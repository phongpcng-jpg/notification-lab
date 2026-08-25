# Transport Report: Server-Sent Events (SSE)

**Technique:** Server-Sent Events (SSE)

**Status:** Implemented on `feature/render-deployment`. The backend exposes a long-lived HTTP stream at `/notifications/stream`; the frontend uses the browser's native `EventSource` implementation; the benchmark has a dedicated Node HTTP SSE client.

## 1. Architecture

SSE provides a long-lived, server-to-client HTTP stream. The application keeps the notification itself in persistent storage and uses SSE to deliver the notification to currently connected clients.

```text
Business event
     │
     ▼
NotificationService
     │
     ├── persist Notification rows
     │
     └── emit notification-created event
                 │
                 ▼
        fetchNotificationsByIds()
                 │
                 ▼
              SseHub
                 │
                 ▼
       connected SSE clients
                 │
                 ▼
             EventSource
```

For a new/reconnected connection, the route also performs cursor-based catch-up:

```text
EventSource
   │
   │ GET /notifications/stream?userId=...
   │ Last-Event-ID: N   ← browser sends this on reconnect
   ▼
SSE route
   │
   ├── read cursor N
   ├── query notifications WHERE id > N
   ├── send missed events
   └── subscribe to SseHub
          │
          │ future notification-created events
          ▼
       send event
```

The backend also accepts `lastEventId` as a query parameter. The browser frontend does not manually maintain this query parameter: it relies on `EventSource` to reconnect and send the standard `Last-Event-ID` request header based on the last received SSE `id:` field. The benchmark client explicitly sends its current cursor as `lastEventId` in the query string. 

The central rule is:

> **SSE is a delivery mechanism, not the source of truth. Persistent notifications remain authoritative and can be replayed using a notification ID cursor.**

---

## 2. Connection lifecycle

A connection follows this lifecycle:

```text
HTTP request
    │
    ▼
validate userId
    │
    ▼
reply.hijack()
    │
    ▼
write SSE response headers
    │
    ▼
write ': connected'
    │
    ▼
open connections record
    │
    ▼
catch-up missed notifications
    │
    ▼
subscribe to SseHub
    │
    ▼
heartbeat timer
    │
    ▼
stream events until disconnect
    │
    ▼
cleanup
```

The route uses `reply.hijack()` and writes directly to `reply.raw`. This is necessary because the response remains open instead of being completed by the normal Fastify request/response lifecycle.

The response uses:

```text
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

`X-Accel-Buffering: no` is intended to prevent response buffering in reverse proxies that honor this header. It does not by itself configure every possible proxy/CDN.

---

## 3. Cursor and reconnect semantics

Every notification event contains:

```text
id: <notification.id>
event: notification
data: <JSON payload>
```

The event ID is the persistent **notification ID**, not a separate SSE sequence generated in memory.

On reconnect, the browser's `EventSource` implementation sends the last received event ID using `Last-Event-ID`. The backend chooses the cursor in this order:

```text
Last-Event-ID header
        │
        ├── present → use it
        │
        └── absent
              │
              ▼
       lastEventId query
              │
              └── absent → 0
```

The catch-up query is:

```sql
WHERE recipient_id = ?
  AND notification.id > ?
ORDER BY notification.id ASC
LIMIT 200
```

Therefore a single connection establishment replays at most 200 missed notifications. This is a deliberate bounded catch-up window rather than an unlimited history replay.

For more general recovery/history, the REST notification endpoint supports the same `after` cursor concept. The frontend and benchmark can therefore use persisted notification history rather than depending on an SSE connection remaining alive forever.

---

## 4. Catch-up followed by realtime subscription

The current server implementation performs catch-up first and registers the `SseHub` subscription immediately afterwards:

```text
fetchNotificationsAfter(after)
       │
       ▼
send missed events
       │
       ▼
sseHub.subscribe()
```

This ordering is important to document because it exposes a small race window: a notification can be created after the catch-up query and before the subscription is registered. If that happens, the current connection can miss that event in realtime.

This does **not** make the persisted notification disappear. On a later reconnect, the client can use its last successfully received event ID and the server can replay the missing notification. However, the current implementation does not provide an atomic "catch-up + subscribe" operation.

This is a known implementation limitation and should not be described as a strict exactly-once realtime stream.

---

## 5. Realtime fan-out

`SseHub` is implemented using the generic `PushHub` abstraction shared with WebSocket.

```text
SseHub
  │
  └── PushHub<SseSubscription>
          │
          ├── user 1 → subscription A, B
          ├── user 2 → subscription C
          └── ...
```

Each subscription contains callbacks for:

```text
onNotification(row)
forceClose()
```

When `NotificationService` emits a newly created notification, `app.ts` loads the complete notification rows and calls `sseHub.publish(recipientId, row)`. Every active SSE subscription for that user receives the row.

This is an **in-process** fan-out mechanism. It is not Redis Pub/Sub, a message broker, or a shared event bus.

### Multi-instance limitation

```text
Fastify instance A
  └── SseHub A

Fastify instance B
  └── SseHub B
```

A notification created in instance A is only published to subscriptions registered with SseHub A. A connection held by instance B will not receive that in-process event automatically.

A production multi-instance architecture would require a shared event/distribution mechanism. That is outside the current lab implementation.

---

## 6. Event payload

SSE and WebSocket use the same backend serialization shape:

```json
{
  "id": 123,
  "actorId": 1,
  "actorDisplayName": "alice",
  "postId": 456,
  "scriptPreview": "post preview",
  "createdAt": 1720000000,
  "serverSentAtMs": 1720000000123
}
```

`serverSentAtMs` is captured immediately before the backend writes the event payload. It is an instrumentation field, not a business timestamp and not a guarantee that the browser received the event at that time.

The frontend maps the payload into the same `PolledNotification` shape used by Short/Long Polling so the UI can share notification rendering logic across transports.

---

## 7. Heartbeat

The server sends SSE comment frames periodically:

```text
: ping

```

The default interval is:

```text
SSE_HEARTBEAT_MS=15000
```

The interval is configurable through the backend environment. Heartbeats help keep idle connections active through infrastructure that otherwise terminates or buffers quiet HTTP streams.

Heartbeat frames are comments, so they do not appear as application notifications in the frontend or benchmark parser.

---

## 8. Connection tracking and cleanup

Each SSE connection is recorded in the `connections` table:

```text
connect
   │
   ▼
openConnection(userId, "sse")
   │
   ▼
connections row
   │
   │ client closes / connection errors
   ▼
cleanup()
   ├── clear heartbeat
   ├── unsubscribe from SseHub
   └── closeConnection(..., "client_disconnect")
```

The cleanup function is guarded so it runs only once even if multiple close/error signals occur.

This persistent connection record is useful for benchmark analysis of connection counts, connection lifetime, reconnects, and disconnect reasons.

During process shutdown, `server.ts` calls `sseHub.closeAll()` before closing the Fastify application, allowing active SSE responses to be closed deliberately.

---

## 9. Delivery status and delivery attempts

When SSE sends a notification, the backend records a successful delivery attempt and calls `markDelivered()`.

For catch-up:

```text
all missed rows
   │
   ├── write each event
   └── recordDeliveryBatch(missed, "sse", ...)
```

For realtime delivery:

```text
new notification
   │
   ▼
SseHub subscription
   │
   ▼
write event
   │
   ▼
recordDeliveryBatch([row], "sse", serverSentAtMs)
```

The stored `latency_ms` is calculated as:

```text
baseTimeMs - notification.created_at * 1000
```

This is a **server-observed delivery/attempt latency**. It is not the exact time at which the browser processed the event.

A successful `recordDeliveryBatch()` therefore means the backend recorded the transport operation as successful; it does not prove that the user saw the notification.

---

## 10. Frontend implementation

The frontend uses the native browser API:

```text
new EventSource(
  `${API_BASE_URL}/notifications/stream?userId=${userId}`
)
```

The React hook listens for:

```text
open
notification
error
```

On `notification`, it parses the JSON payload and deduplicates by notification ID before adding the notification to local React state.

On `error`, the hook does **not** close the EventSource. It only updates UI state because the browser is responsible for reconnecting.

This is an important difference from the benchmark client: the production/frontend path intentionally relies on browser-native EventSource reconnect behavior, while the Node benchmark client implements its own reconnect timer so that reconnect behavior is deterministic and measurable.

The frontend derives its API base URL from `VITE_API_BASE_URL` in production and uses the Vite `/api` proxy in development.

---

## 11. Testing

The integration tests in `backend/src/routes/sse.test.ts` use a real listening HTTP server:

```text
app.listen({ port: 0 })
        │
        ▼
node:http client
        │
        ▼
parse SSE frames
```

They intentionally do not use `fastify.inject()` for the streaming cases because the SSE response is designed to remain open rather than finish like a normal HTTP response.

Current coverage includes:

1. Catch-up of an existing notification.
2. Realtime notification after the SSE connection is already open.
3. Reconnect using a previous event ID without replaying an already received notification.
4. Cleanup and persistent `connections` tracking after client disconnect.
5. Missing `userId` returns HTTP 400 without hijacking the response.

These tests use Node's HTTP client, so they validate the SSE protocol and backend lifecycle but do not reproduce every browser-specific `EventSource` behavior.

### Browser-specific behavior still requiring manual validation

- Native EventSource reconnect timing.
- Browser/OS behavior while a tab is backgrounded.
- Proxy/CDN buffering and connection timeout behavior.
- Behavior under real HTTPS deployment.
- Browser-specific connection limits and lifecycle policies.

---

## 12. Benchmark implementation

SSE is included in the automated benchmark framework.

The benchmark uses `benchmark/generators/sseClient.ts`, which implements an SSE client using Node's `http`/`https` modules and parses `id`, `event`, and `data` frames directly.

The simulated client tracks:

```text
notificationId
receivedAtMonoMs
serverCreatedAtMs
serverSentAtMs
```

The runner also calibrates the backend wall clock against the benchmark process's monotonic clock using `/health`. This allows the benchmark to estimate:

```text
End-to-end latency
≈ calibrated client receive time - notification creation time

Transport/network latency
≈ calibrated client receive time - serverSentAtMs
```

The benchmark separately reads `delivery_attempts` for server-observed delivery latency.

Therefore the report should distinguish at least:

| Metric | Meaning |
|---|---|
| E2E latency | Estimated notification creation → benchmark client receipt |
| Transport/network latency | Estimated `serverSentAtMs` → benchmark client receipt |
| Server delivery latency | Backend notification creation → recorded SSE delivery attempt |
| Delivery rate | Unique expected notification IDs received / expected IDs |
| Duplicate count | Repeated notification IDs observed by a client |
| Reconnect count | Benchmark client reconnect attempts |

No benchmark numbers are claimed in this document until an actual benchmark run has produced result files. The benchmark framework currently marks the repository as not having a completed real benchmark run.

---

## 13. Strengths

- **Native browser support:** `EventSource` provides a simple client API and browser-managed reconnect behavior.
- **One long-lived connection:** many notifications can be delivered without a new HTTP request for every event.
- **Low delivery overhead for active clients:** once the stream is established, the server can write an event immediately when the notification-created event reaches the SSE hub.
- **Cursor-based recovery:** the SSE `id:` field is based on the persistent notification ID, allowing missed events to be replayed after reconnect.
- **Simple server-to-client model:** ideal when the application needs notifications from server to browser but does not need application messages in the reverse direction over the same connection.
- **Shared notification model:** SSE uses the same persisted notification records and serialization shape as the other transports.

---

## 14. Weaknesses and limitations

- **One-way connection:** the client cannot send application messages back through the SSE stream. Actions such as mark-as-read use separate REST endpoints.
- **Long-lived connection cost:** each active client keeps an HTTP connection open.
- **In-process fan-out:** `SseHub` does not distribute events across multiple backend instances.
- **Raw response management:** `reply.hijack()` moves the route outside Fastify's normal response lifecycle, so cleanup and stream errors require explicit handling.
- **Catch-up is bounded:** one connection establishment replays at most 200 notifications.
- **Catch-up/subscription race:** the current implementation does not atomically combine historical replay and realtime subscription registration.
- **Proxy infrastructure matters:** buffering, idle timeouts, connection limits, and streaming support must be configured correctly in the hosting path.
- **Browser lifecycle matters:** browser backgrounding and device/OS policies can affect long-lived connections.

---

## 15. Best suited for

- In-app notifications while the user has the application open.
- Server-to-browser event streams.
- Applications where a persistent connection is useful and client-to-server messaging is handled separately through normal HTTP APIs.
- Notification workloads where cursor-based replay is desirable after reconnect.

## 16. Poorly suited for

- Bidirectional realtime protocols where the client must continuously send application messages over the same connection; WebSocket is a better fit.
- Binary-heavy streaming.
- Architectures that cannot maintain long-lived HTTP connections.
- Multi-instance deployments without a shared event-distribution mechanism.
- Scenarios that require proof that a human user actually saw a notification.

---

## 17. Comparison summary

| Category | Assessment |
|---|---|
| Complexity | Low–Medium |
| Connection model | Long-lived HTTP stream |
| Latency | Low after connection establishment; exact values require benchmark runs |
| Throughput | Measured by the automated benchmark framework; no result is claimed here until a real run is available |
| Scalability | Good for active connections at moderate scale, but current `SseHub` is single-process |
| Reliability | Reconnect + persistent notification IDs provide replay capability; current catch-up/subscription race remains a limitation |
| Browser support | Broad modern-browser support through native `EventSource`; target-browser validation is still required |
| Infrastructure | Requires streaming HTTP, correct proxy buffering/timeout behavior, and long-lived connection support |
| Operational complexity | Medium because raw response lifecycle and cleanup are explicit |
| Best use case | Server-to-client in-app notifications while the application is open |
