# Transport Report: Long Polling

**Technique:** Long Polling

**Status:** Implemented on `feature/render-deployment` at `GET /notifications/long-poll`. The server returns immediately when notifications newer than the client's cursor already exist; otherwise it keeps the HTTP request open until a notification is created, the configured timeout expires, or the client disconnects.

## 1. Architecture

Long Polling uses normal HTTP and a persistent notification cursor:

```text
Client
  │
  │ GET /notifications/long-poll?userId=24&after=157&limit=50
  ▼
Fastify route
  │
  ├── fetchNotificationsAfter(userId, after, limit)
  │
  ├── rows found ───────────────► return immediately
  │
  └── no rows
       │
       ▼
   NotificationWaiters.waitFor(userId)
       │
       │ notification-created
       ▼
   waiter resolves
       │
       ▼
   re-query DB with same cursor
       │
       ▼
   return notifications
```

The notification itself remains persisted in SQLite. Long Polling is therefore a delivery/retrieval mechanism, not the source of truth.

The notification-created event in `app.ts` does not push the notification through the open HTTP response. Instead, it calls `notificationWaiters.notify(recipientId)`, which wakes waiting requests; each request then queries the database again. This is deliberately different from SSE/WebSocket, where the event is pushed directly through an active stream/socket.

---

## 2. Endpoint and request parameters

The endpoint is:

```text
GET /notifications/long-poll?userId=<id>&after=<cursor>&limit=<n>
```

Parameters:

| Parameter | Current behavior |
|---|---|
| `userId` | Required; converted to a number. Missing/falsy value returns HTTP 400. |
| `after` | Optional cursor; defaults to `0`. Only notifications with `id > after` are returned. |
| `limit` | Optional; defaults to `50` and is capped at `200`. |

The query uses:

```sql
WHERE recipient_id = ?
  AND notification.id > ?
ORDER BY notification.id ASC
LIMIT ?
```

Therefore notification IDs are both the ordering basis and the recovery cursor.

Long Polling does not use SSE's `Last-Event-ID` header and does not maintain a separate in-memory event sequence.

---

## 3. Response format

A successful response with data has the shape:

```json
{
  "notifications": [
    {
      "id": 123,
      "status": "queued",
      "created_at": 1720000000,
      "actor_id": 1,
      "actor_display_name": "alice",
      "post_id": 456,
      "script_preview": "post preview"
    }
  ],
  "nextAfter": 123,
  "timedOut": false,
  "serverTime": 1720000000123,
  "serverSentAtMs": 1720000000123
}
```

When the request times out without new notifications:

```json
{
  "notifications": [],
  "nextAfter": 157,
  "timedOut": true,
  "serverTime": 1720000000123,
  "serverSentAtMs": 1720000000123
}
```

`serverSentAtMs` is a server-side instrumentation timestamp captured immediately before the response is returned. It does **not** mean that the browser received the response at that timestamp.

`serverTime` currently contains the same timestamp value. The benchmark primarily uses `serverSentAtMs` for transport timing analysis.

---

## 4. Immediate-return path

The first operation is always a database query:

```text
fetchNotificationsAfter(userId, after, limit)
```

If rows already exist:

```text
DB rows found
    │
    ├── recordDeliveryBatch(...)
    └── HTTP response immediately
```

No waiter is registered and no long-lived request is created.

The returned `nextAfter` is the ID of the last notification in the response. The frontend stores that cursor and uses it on the next request.

---

## 5. Waiting path

If the initial query returns no rows, the server:

1. Creates a persistent `connections` row with `transport="long_polling"`.
2. Registers a waiter with `notificationWaiters.waitFor(userId)`.
3. Starts the configured timeout.
4. Registers a `req.raw` `close` listener.
5. Waits until data, timeout, or client disconnect is observed.
6. Cancels the waiter and removes the request listener.
7. Re-queries the database using the original `after` cursor.

The important point is that `NotificationWaiters` only signals **"something may have changed"**. It does not carry notification data to the HTTP handler.

```text
notification-created
       │
       ▼
notificationWaiters.notify(userId)
       │
       ▼
resolve waiting request
       │
       ▼
fetchNotificationsAfter(...)
       │
       ▼
return actual persisted rows
```

This makes the database the authoritative source even during long-poll wake-up.

---

## 6. Timeout behavior

The default timeout is:

```text
LONG_POLL_TIMEOUT_MS=25000
```

It is configurable through the backend environment.

When the timer fires, the route marks the reason as `timeout`. The request then re-queries the database. If no notification appeared during the wait, it returns:

```text
notifications: []
timedOut: true
nextAfter: original after cursor
```

The timeout is therefore a normal successful HTTP response, not an HTTP error.

### Implementation detail

The current server waits with a `Promise.race()` between the notification waiter and a 25 ms polling check of `settledReason`:

```text
waiter promise
     │
     ├──────────────┐
     │              │
     ▼              ▼
notification     25ms check
signal           loop
     │              │
     └──────┬───────┘
            ▼
       settled reason
```

The 25 ms check is a deliberate implementation trade-off. It makes timeout/disconnect detection straightforward but introduces a small scheduling/timing granularity. The configured timeout is the primary contract; individual request timing can vary slightly because of the check loop and normal event-loop scheduling.

---

## 7. Client disconnect and cancellation

The server listens to the underlying request:

```text
req.raw.on("close", onClientClose)
```

If the client disconnects while waiting:

```text
client closes HTTP request
        │
        ▼
settledReason = client_disconnect
        │
        ▼
clear timeout
cancel waiter
remove close listener
        │
        ▼
closeConnection(..., "client_disconnect")
        │
        └── return without reply.send()
```

Not calling `reply.send()` after a client disconnect is important because there is no longer a usable response stream.

The frontend uses `AbortController` when the transport is stopped, disabled, unmounted, or switched to another user/transport. An intentional abort is not retried as a network error.

---

## 8. Concurrent long-poll requests

The current implementation intentionally allows multiple outstanding long-poll requests for the same user:

```text
user 24
 ├── request A → waiter A
 ├── request B → waiter B
 └── request C → waiter C
```

`NotificationWaiters.notify(24)` resolves **all** waiters for that user.

Each request then independently queries:

```text
id > after
```

If multiple requests use the same cursor, they can return the same notification. This is intentional and consistent with the project's at-least-once delivery model.

The frontend deduplicates by notification ID before adding rows to React state.

There is currently no server-side single-flight/one-request-per-user restriction.

---

## 9. Waiter registry and multi-instance limitation

`NotificationWaiters` is an in-memory registry:

```text
Fastify instance A
  └── NotificationWaiters A

Fastify instance B
  └── NotificationWaiters B
```

A notification created on instance A wakes only waiters registered in instance A. A long-poll request waiting on instance B will not be notified by the in-process event from A.

This means the current implementation is correct for a single backend process but is **not a complete multi-instance architecture**.

A multi-instance deployment would need a shared notification signal/distribution layer such as Redis Pub/Sub or a message broker. The notification database would remain the source of truth; the shared broker would only provide the cross-instance wake-up signal.

---

## 10. Connection tracking

Only the waiting path creates a `connections` record because an immediate-return request is not held open:

```text
no existing data
      │
      ▼
openConnection(userId, "long_poll")
      │
      ▼
request waits
      │
      ├── data → closeConnection(..., "data_delivered")
      ├── timeout → closeConnection(..., "timeout")
      └── disconnect → closeConnection(..., "client_disconnect")
```

The record is persisted in SQLite so benchmark analysis can inspect connection lifetimes and disconnect reasons after the run.

`closeConnection()` only updates rows that have not already been closed, which prevents duplicate close transitions.

---

## 11. Delivery recording and latency semantics

When notifications are returned, the server calls:

```text
recordDeliveryBatch(rows, "long_polling", serverSentAtMs)
```

This marks each notification as delivered and creates a successful `delivery_attempt`.

The stored latency is calculated as:

```text
serverSentAtMs - notification.created_at * 1000
```

This is **server-side delivery/response latency**. It is not the full client-perceived E2E latency because the server does not receive an acknowledgement for an ordinary Long Polling HTTP response.

For benchmark analysis, the important timestamps are:

```text
notification.created_at
serverSentAtMs
benchmark receivedAtMonoMs
```

The benchmark can therefore estimate client-observed E2E latency after clock calibration, while `delivery_attempts.latency_ms` remains a server-side metric.

A successful delivery attempt means the backend produced the HTTP response successfully; it does not prove that the user saw the notification.

---

## 12. Frontend implementation

The React transport uses `fetch()` with `AbortController`:

```text
loop()
  │
  ▼
fetch(/notifications/long-poll?userId=...&after=...)
  │
  ├── notifications → merge + dedupe + advance cursor → loop again
  │
  ├── timeout response → advance cursor unchanged → loop again
  │
  └── network error → backoff → retry
```

Current retry configuration:

```text
BASE_RETRY_DELAY_MS = 1000
MAX_RETRY_DELAY_MS  = 30000
```

Network errors use the shared `computeBackoffDelay()` helper with jitter. Successful responses reset the retry attempt counter.

The client maintains the cursor in a React ref:

```text
afterRef.current
```

When a response contains notifications, it deduplicates by ID and prepends the fresh notifications to the local state. The cursor is then advanced to `nextAfter`.

A timeout is not treated as an error. The client simply starts the next long-poll request.

---

## 13. Realtime wake-up wiring

`app.ts` wires the notification service to all transports. For Long Polling specifically:

```text
NotificationService
       │
       ▼
notification-created
       │
       ▼
for each recipientId
       │
       ▼
notificationWaiters.notify(recipientId)
```

The event carries notification IDs and recipient IDs, but Long Polling only needs the recipient ID to wake the appropriate waiter. It deliberately does not pass the notification row directly into the HTTP response.

This differs from SSE/WebSocket:

| Transport | On notification-created |
|---|---|
| Short Polling | No open request to wake; client asks again later |
| Long Polling | Wake waiter; request re-queries DB |
| SSE | Publish row directly to active SSE stream |
| WebSocket | Publish row directly to active WebSocket |
| Web Push | Send notification through external Push Service |

---

## 14. Race and delivery semantics

The current route has two important ordering properties.

### Initial query before waiter registration

The route first queries the database and only registers a waiter when no rows exist:

```text
query DB
  │
  ├── data → return
  │
  └── empty
       │
       ▼
   register waiter
```

This creates a potential race if a notification is committed between the initial empty query and waiter registration. In that case the notification-created wake-up can occur before the waiter exists, leaving the request waiting until timeout.

The notification is **not lost from persistent storage**. After timeout, the route re-queries the database and can return it if it is still newer than the cursor. The downside is extra latency: the client may wait until the long-poll timeout rather than being woken immediately.

This is a known implementation limitation and should be distinguished from data loss.

### Concurrent requests

Two requests with the same cursor can both receive the same notification. Therefore the transport is not exactly-once.

Overall semantics should be described as:

> **At-least-once-oriented delivery with persistent cursor-based recovery and client-side deduplication.**

---

## 15. Testing

`backend/src/routes/longPolling.test.ts` contains five integration tests using Fastify's `app.inject()`:

1. Existing notification returns immediately.
2. A request waiting for data is awakened after a new post creates a notification.
3. Empty request returns `timedOut=true` after the configured timeout.
4. Two concurrent requests for the same user are both awakened and intentionally receive the same notification.
5. Missing `userId` returns HTTP 400.

The timeout test uses a test configuration of approximately **300 ms** and allows timing tolerance for the server's 25 ms checking loop.

### Current testing gaps

The integration suite does **not** fully reproduce a real browser abort of an open HTTP request because `fastify.inject()` is not a real network client.

The following still need dedicated/manual validation:

- Client closes a genuinely open long-poll HTTP request midway through waiting.
- Browser tab unmount/switch behavior against a real server.
- Proxy/load-balancer behavior for long-lived HTTP requests.
- Multi-instance behavior.
- Large numbers of concurrent waiting requests.
- Race-window timing between the initial DB query and waiter registration.
- Slow-client/network failure scenarios.

---

## 16. Benchmark implementation

The benchmark has a dedicated `LongPollingClient` using `fetch()` and `AbortController`.

It records:

```text
notificationId
receivedAtMonoMs
serverCreatedAtMs
serverSentAtMs
```

The benchmark client keeps its own `after` cursor and immediately starts another long-poll request after every successful response. A network error increments `errorCount` and currently retries after a fixed **1-second delay**.

This differs from the frontend, which uses exponential/backoff + jitter up to 30 seconds. Benchmark reconnect/retry behavior should therefore not be assumed to be identical to production frontend behavior.

For simulated slow clients, the benchmark can add `slowClientExtraDelayMs` after a response containing notifications.

The benchmark should distinguish:

| Metric | Meaning |
|---|---|
| E2E latency | Estimated notification creation → benchmark client receipt |
| Transport/network latency | Estimated `serverSentAtMs` → benchmark client receipt |
| Server delivery latency | Notification creation → recorded server delivery attempt |
| Delivery rate | Expected unique notification IDs received / expected IDs |
| Duplicate count | Repeated notification IDs received |
| Error count | Benchmark HTTP/network errors |
| Timeout responses | Long-poll responses with `timedOut=true` and no notification |

`serverSentAtMs - createdAt` must not be presented as browser/client E2E latency.

No fixed performance result is claimed in this report until an actual benchmark run produces corresponding result data.

---

## 17. Strengths

- **Simple HTTP model:** no WebSocket upgrade or SSE-specific streaming protocol is required.
- **Lower empty-request overhead than Short Polling:** an open request waits for useful work instead of repeatedly polling at a fixed interval.
- **Near-immediate response when an event arrives:** the in-process waiter is awakened instead of waiting for the next client polling interval.
- **Works with ordinary `fetch()`:** browser-side implementation uses standard HTTP APIs.
- **Persistent cursor recovery:** notifications remain queryable by `id > after`.
- **Explicit disconnect handling:** the server can cancel the waiter and record the disconnect reason.
- **Useful fallback:** can be attractive when SSE/WebSocket infrastructure is unavailable but long-lived HTTP requests are acceptable.

---

## 18. Weaknesses and limitations

- **Long-lived HTTP requests:** each waiting request consumes an active socket and associated server/client state.
- **In-process waiter registry:** current wake-up mechanism does not work across backend instances.
- **Duplicate delivery is possible:** concurrent requests and reconnects can receive the same notification.
- **Race between initial query and waiter registration:** a notification can wake no waiter and cause unnecessary timeout latency.
- **Timeout churn:** even when no notification exists, the client must issue another request after each timeout.
- **Explicit cancellation is required:** the frontend must manage `AbortController` and retry state.
- **Proxy timeout constraints:** reverse proxies/load balancers must permit HTTP requests to remain open for the configured duration.
- **No bidirectional application channel:** client actions still use separate HTTP APIs.
- **No proof of user visibility:** a successful HTTP response is not evidence that the user saw the notification.

---

## 19. Best suited for

- Applications that need lower notification latency than Short Polling without introducing WebSocket infrastructure.
- HTTP-oriented environments where long-lived requests are supported.
- Fallback delivery when SSE/WebSocket is unavailable or undesirable.
- Moderate-scale in-process deployments where the waiter registry limitation is acceptable.

## 20. Poorly suited for

- Very large multi-instance deployments without a shared wake-up mechanism.
- Systems where long-lived HTTP requests are aggressively terminated by proxies/load balancers.
- True bidirectional realtime communication; WebSocket is a better fit.
- Background notifications when the web application is not open; Web Push is a better fit.
- Workloads requiring exactly-once user-visible delivery.

---

## 21. Comparison summary

| Category | Assessment |
|---|---|
| Complexity | Medium |
| Connection model | Long-lived HTTP request, one request per wait cycle |
| Latency | Near-immediate after notification wake-up; exact E2E values require benchmark runs |
| Throughput | Benchmarkable with the current framework; no fixed result claimed here |
| Scalability | Better request efficiency than Short Polling, but current waiter registry is single-process |
| Reliability | At-least-once-oriented with persistent cursor recovery; disconnect and timeout paths are handled |
| Browser support | Standard `fetch()` / `AbortController` in modern browsers; target-browser validation still required |
| Infrastructure | Ordinary HTTP, but proxy/load-balancer idle/request timeout must exceed the long-poll window |
| Operational complexity | Medium |
| Best use case | Low-latency HTTP fallback when SSE/WebSocket is not suitable |
