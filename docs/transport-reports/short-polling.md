# Transport Report: Short Polling

**Technique:** Short Polling

**Status:** Implemented on `feature/render-deployment` at `GET /notifications/poll`. The server handles every request independently and always returns an HTTP response immediately; it never keeps the request open waiting for a notification.

## 1. Architecture

Short Polling is the simplest transport in the lab:

```text
React / benchmark client
        │
        │ GET /notifications/poll?userId=24&after=157&limit=50
        ▼
   Fastify route
        │
        ▼
fetchNotificationsAfter()
        │
        ├── notifications found
        │        │
        │        └── return immediately
        │
        └── no notifications
                 │
                 └── return immediately with []
```

There is no server-side waiter, stream, socket, heartbeat, or persistent transport connection. The client decides when to issue the next request.

The notification remains persisted in SQLite. Short Polling therefore retrieves persistent notification state rather than maintaining a separate transport-specific queue.

The common query is cursor-based:

```sql
WHERE recipient_id = ?
  AND notification.id > ?
ORDER BY notification.id ASC
LIMIT ?
```

The cursor is the persistent notification ID and is owned by the client. fileciteturn158file0L2-L2

---

## 2. Endpoint and request parameters

The endpoint is:

```text
GET /notifications/poll?userId=<id>&after=<cursor>&limit=<n>
```

Current behavior:

| Parameter | Current behavior |
|---|---|
| `userId` | Required; converted to a number. Missing/falsy value returns HTTP 400. |
| `after` | Optional; defaults to `0`. Only notifications with `id > after` are returned. |
| `limit` | Optional; defaults to `50`, capped at `200`. |

The route does not use notification `status` to decide which rows to return. This is intentional: if the server used `status='queued'` as the cursor, a notification could become `delivered` before a client successfully processed the response and then disappear from a later retry. The client cursor is therefore the recovery position. fileciteturn155file0L2-L2

---

## 3. Response format

A successful response has the following shape:

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
  "suggestedIntervalMs": 5000,
  "serverTime": 1720000000123,
  "serverSentAtMs": 1720000000123
}
```

When there is no new notification:

```json
{
  "notifications": [],
  "nextAfter": 123,
  "suggestedIntervalMs": 5000,
  "serverTime": 1720000000123,
  "serverSentAtMs": 1720000000123
}
```

`nextAfter` is the last notification ID returned, or the original `after` value when the response contains no rows.

`serverSentAtMs` is captured immediately before the response is sent. It is a server-side instrumentation timestamp and does **not** mean that the browser received or processed the response at that exact time. `serverTime` currently contains the same timestamp. fileciteturn155file0L2-L2

---

## 4. Polling interval

The backend returns a server-suggested interval rather than enforcing a polling schedule:

```text
SHORT_POLL_INTERVAL_MS=5000
```

The default is **5 seconds**. The value is exposed as `suggestedIntervalMs` in every successful response. fileciteturn151file0L2-L2

This is an important distinction:

> **The 5-second value is a client scheduling recommendation, not a server-side latency guarantee.**

If the client follows the default interval and notifications are created just after a poll completes, the next poll may be roughly one interval away, plus normal scheduling/network/processing time. If the client changes the interval, the actual latency changes accordingly.

The project does not currently implement server push or adaptive polling based on whether a user has recent activity.

---

## 5. Client polling lifecycle

The React hook uses recursive `setTimeout`, not `setInterval`:

```text
start
  │
  ▼
pollOnce()
  │
  ▼
HTTP request
  │
  ├── success ──► process response
  │                    │
  │                    ▼
  │              schedule next poll
  │              using suggestedIntervalMs
  │
  └── error ────► compute exponential backoff + jitter
                       │
                       ▼
                  schedule retry
```

Because the next timer is scheduled only after the previous request has completed, the frontend does not intentionally create overlapping polling requests. fileciteturn159file0L2-L2

On a successful response:

1. Parse the response.
2. Deduplicate notification IDs already present in React state.
3. Add new notifications to local state.
4. Advance `afterRef.current` to `nextAfter`.
5. Reset the retry attempt counter.
6. Schedule the next poll using `suggestedIntervalMs`.

On an HTTP/network error, the hook records `lastError` and retries using the shared exponential-backoff helper with jitter, base `1000 ms` and maximum `30000 ms`. fileciteturn159file0L2-L2

---

## 6. Cursor and delivery semantics

The current implementation is explicitly **at-least-once-oriented**.

```text
Client cursor = after
       │
       ▼
server returns id > after
       │
       ▼
client processes response
       │
       ▼
client advances cursor
```

If the client advances its cursor successfully, the next request starts after the latest returned notification.

If the client retries with an old cursor, the server intentionally returns those notifications again:

```text
request 1: after=0 → notification 123

client crashes before persisting/advancing cursor

request 2: after=0 → notification 123 again
```

The frontend therefore deduplicates by notification ID. This is preferable to marking a notification permanently unavailable based only on the server having generated an HTTP response. fileciteturn155file0L2-L2

Exactly-once delivery is **not** guaranteed.

The `notifications.status`, `delivered_at`, and `delivery_attempts` records are observability/delivery-state information; they are not the client's recovery cursor. The common query itself uses only `recipient_id` and `id > after`. fileciteturn158file0L2-L2

---

## 7. Ordering and batching

The backend query orders notifications by ascending ID:

```text
id ASC
```

and returns at most the requested `limit`, capped at 200.

This means a client with a large backlog may need several polling cycles:

```text
after=0
  │
  ├── rows 1..200 → nextAfter=200
  │
  ▼
next request after=200
  │
  ├── rows 201..400 → nextAfter=400
  │
  ▼
...
```

The frontend does not currently expose a custom `limit`; it relies on the backend default of 50. The benchmark client also omits `limit`, so benchmark polling uses the same default response limit. fileciteturn143file0L2-L2 fileciteturn161file0L2-L2

Within one response, notification IDs are therefore ordered ascending. The React UI reverses the fresh batch when prepending it to the notification list so newer notifications appear first. fileciteturn149file0L2-L2

---

## 8. Server-side delivery recording

When the route finds notifications, it calls:

```text
recordDeliveryBatch(rows, "short_polling", serverSentAtMs)
```

For each returned row, the server:

```text
markDelivered(notification.id)
recordDeliveryAttempt({
    transport: "short_polling",
    result: "success",
    latencyMs: ...
})
```

The stored latency is calculated from:

```text
serverSentAtMs - notification.created_at * 1000
```

This is **server-side delivery/response latency**, not client E2E latency. The server has no ACK from a normal Short Polling HTTP response. fileciteturn158file0L2-L2

A successful delivery attempt therefore means that the backend produced the response successfully; it does not prove that the browser received, rendered, or displayed the notification to a user.

An empty poll does not create a delivery attempt because there is no notification to deliver.

---

## 9. Connection and scalability model

Short Polling does not create a persistent `connections` record and does not use the connection-tracking mechanism used by Long Polling/SSE/WebSocket.

Each request is independent:

```text
poll #1 → HTTP request → HTTP response → done
poll #2 → HTTP request → HTTP response → done
poll #3 → HTTP request → HTTP response → done
```

This gives Short Polling a useful infrastructure property:

- no sticky session is required;
- no in-process waiter registry is required;
- no WebSocket upgrade is required;
- no SSE stream needs to survive across requests;
- ordinary HTTP load balancing can distribute requests across instances.

The trade-off is request overhead: every client continues generating requests even when there are no new notifications.

The architecture document classifies the current project as a lab rather than a horizontally scalable production system, but **Short Polling itself is the least stateful transport at the server layer**. fileciteturn139file0L2-L2

---

## 10. Frontend lifecycle and cleanup

The hook exposes:

```text
start()
stop()
isPolling
lastError
notifications
```

When the transport is disabled, the user changes, or the component unmounts, the hook marks polling as stopped and clears the scheduled timer. fileciteturn159file0L2-L2

There is no open socket or long-lived HTTP request to abort in the Short Polling implementation. Cleanup only needs to prevent the next scheduled request from starting.

When the user changes, the React hook instance uses a new user ID and its cursor state is scoped to that hook lifecycle. The current implementation does not persist the cursor to local storage or another durable browser store.

---

## 11. Error and retry behavior

HTTP responses with a non-2xx status are treated as errors by the frontend:

```text
HTTP error / fetch error
        │
        ▼
attempt++
        │
        ▼
computeBackoffDelay()
        │
        ▼
retry
```

The shared backoff implementation uses exponential growth with a default jitter ratio of 30%, capped by `maxMs`. The frontend configures:

```text
base = 1000 ms
max  = 30000 ms
```

This is intended to avoid a thundering herd when many clients fail and retry simultaneously. fileciteturn118file0L2-L2

The benchmark client uses a simpler retry policy: after a request error it increments `errorCount` and retries after a fixed **1 second**. It does not use the frontend's exponential/jitter backoff helper. fileciteturn161file0L2-L2

Therefore benchmark retry behavior should not be interpreted as an exact reproduction of the production React hook.

---

## 12. Benchmark implementation

Short Polling is one of the four transports automated by the benchmark framework:

```text
short_polling
long_polling
sse
websocket
```

Web Push is intentionally excluded from this common runner because it cannot be represented by the same Node polling/streaming client model. fileciteturn146file0L2-L2

The benchmark client records:

```text
notificationId
receivedAtMonoMs
serverCreatedAtMs
serverSentAtMs
```

The runner also captures an initial high-water cursor for every subscriber before the measured phase, so notifications that already existed before the benchmark are not counted as measured deliveries. fileciteturn117file0L2-L2

For each received notification, the benchmark can estimate:

```text
E2E latency
≈ calibrated benchmark receive time - notification creation time

Transport/network latency
≈ calibrated benchmark receive time - serverSentAtMs
```

It separately reads `delivery_attempts` for server-side delivery latency. The benchmark result model exposes E2E, server-delivery, and transport-delivery latency percentiles, as well as delivery rate, duplicates, errors, and reconnect counts. fileciteturn117file0L2-L2 fileciteturn119file0L2-L2

### Important benchmark limitation

Short Polling has no persistent connection to reconnect. Consequently `reconnectStorm` is not semantically equivalent to SSE/WebSocket reconnect behavior. The benchmark framework explicitly warns that Scenario F has little meaning as a "reconnect" test for Short Polling. fileciteturn153file0L2-L2

A Short Polling benchmark should therefore be interpreted primarily through:

- delivery rate;
- E2E latency distribution;
- empty-request/request overhead;
- error count;
- duplicate count;
- behavior under different polling intervals and subscriber counts.

---

## 13. Testing

`backend/src/routes/shortPolling.test.ts` currently contains **5 integration tests** using Fastify `app.inject()` and an in-memory SQLite database:

1. A follower receives a newly created notification.
2. Polling again with `after=nextAfter` does not return the already passed notification.
3. Polling again with an old cursor returns the notification again, demonstrating at-least-once behavior.
4. A notification is not leaked to a user who is not the recipient.
5. Missing `userId` returns HTTP 400. fileciteturn135file0L2-L2

The frontend also has 4 unit tests for the shared backoff function, covering exponential growth, maximum cap, non-negative jitter output, and negative-attempt handling. fileciteturn128file0L2-L2

These tests validate transport behavior and retry calculation, but they do not constitute a real browser/network benchmark.

### Remaining validation gaps

- Browser behavior under background-tab throttling.
- Real network/proxy failures.
- High request rates with very large subscriber populations.
- Load-balancer behavior under many simultaneous polling requests.
- Actual production benchmark numbers.
- Whether a particular deployment's HTTP rate limits make the chosen polling interval acceptable.

---

## 14. Strengths

- **Very simple protocol:** ordinary HTTP request/response and `fetch()`.
- **No persistent server connection state:** no WebSocket/SSE lifecycle and no long-poll waiter registry.
- **Easy horizontal request distribution:** each request can be handled independently by a backend instance.
- **Simple debugging:** a single `curl` request is enough to inspect the API.
- **Persistent cursor recovery:** `id > after` avoids using delivery status as the client's recovery position.
- **At-least-once-oriented semantics:** retrying with an older cursor can recover a notification rather than losing it permanently.
- **Predictable infrastructure requirements:** standard HTTP is sufficient.

---

## 15. Weaknesses and limitations

- **Request overhead:** clients make requests even when no notification exists.
- **Latency/request trade-off:** shorter intervals reduce waiting latency but increase request load; longer intervals reduce load but increase notification latency.
- **No server push:** the server cannot notify a client between polls.
- **Client scheduling responsibility:** the browser must manage polling, retry, backoff, cursor advancement, and deduplication.
- **At-least-once rather than exactly-once:** an old cursor can intentionally produce duplicates.
- **No bidirectional realtime channel:** client-to-server application actions use separate HTTP APIs.
- **No connection-level measurement:** unlike Long Polling/SSE/WebSocket, there is no persistent connection whose lifetime can be tracked.
- **Benchmark reconnect scenarios are not directly comparable:** "disconnect/reconnect" has a different meaning for a request-per-poll transport.

---

## 16. Best suited for

- Simple in-app notifications where several seconds of latency is acceptable.
- Low-complexity systems that already use ordinary HTTP APIs.
- Environments where WebSocket/SSE infrastructure is unavailable or intentionally avoided.
- Fallback notification delivery when more realtime transports cannot be used.
- Systems where stateless request handling is more valuable than minimizing request count.

## 17. Poorly suited for

- Chat or highly interactive realtime UI.
- Dashboards requiring sub-second updates.
- Very large numbers of clients where empty polling requests become a significant server/network cost.
- Background notifications when the web application is closed; Web Push is a better fit.
- Systems requiring exactly-once or user-visible delivery guarantees.

---

## 18. Comparison summary

| Category | Assessment |
|---|---|
| Complexity | Low |
| Connection model | Independent short-lived HTTP requests |
| Default client interval | 5 seconds, server-suggested via `suggestedIntervalMs` |
| Latency | Dominated by polling interval plus network/processing; exact E2E values require benchmark runs |
| Throughput | Benchmarkable with the common runner; no fixed performance result is claimed here |
| Scalability | Server-side request handling is stateless; total request volume grows with client count and polling frequency |
| Reliability | At-least-once-oriented with persistent ID cursor and client deduplication |
| Browser support | Standard `fetch()` in modern browsers; no transport-specific browser API required |
| Infrastructure | Ordinary HTTP; no WebSocket upgrade or SSE streaming support required |
| Operational complexity | Low |
| Best use case | Simple in-app notification where several-second latency is acceptable |
