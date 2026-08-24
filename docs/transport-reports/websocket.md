# Transport Report: WebSocket

**Technique:** WebSocket (`@fastify/websocket` + `ws`)

**Status:** Implemented on `feature/render-deployment`. WebSocket is the only transport in the project that provides an application-level bidirectional channel: the server sends notifications and the client can send an `ack` message back on the same connection.

## 1. Architecture

The current endpoint is:

```text
GET /ws?userId=<id>&after=<cursor>
        │
        ▼
@fastify/websocket
        │
        ▼
websocketRoutes()
        │
        ├── open connections record
        ├── catch up persisted notifications
        ├── subscribe to WsHub
        ├── send connected message
        ├── protocol ping/pong heartbeat
        └── receive client messages
                  │
                  └── { type: "ack", notificationId }
```

Notification fan-out is:

```text
NotificationService
       │
       │ notification-created
       ▼
app.ts transport wiring
       │
       ▼
fetchNotificationsByIds()
       │
       ▼
wsHub.publish(recipientId, row)
       │
       ▼
WebSocket connection
       │
       ▼
JSON { type: "notification", data: ... }
       │
       ▼
client ACK
       │
       ▼
notificationService.markAcknowledged()
```

`NotificationService` itself remains transport-agnostic: it creates the persistent notification rows, then emits an in-process event. WebSocket delivery is wired separately in `app.ts`. fileciteturn97file0L2-L2 fileciteturn95file0L2-L2

The persistent notification is still the source of truth. WebSocket is a delivery channel, not an independent notification store.

---

## 2. Connection and authentication model

The current lab uses a deliberately minimal identity model:

```text
/ws?userId=<id>
```

`userId` is converted to a number and must be present/truthy. If it is missing or invalid, the server sends an error message and closes the WebSocket with close code `1008`. This is **not** production authentication; there is no JWT/OAuth/session validation in this transport. fileciteturn88file0L2-L2

On a valid connection the server creates a row in the `connections` table with `transport='websocket'`. The connection ID is then included in the server's `connected` message. fileciteturn88file0L2-L2

The client URL includes both the user and its current notification cursor:

```text
ws://.../ws?userId=24&after=157
```

In production HTTPS deployments, the frontend derives the WebSocket endpoint from the backend HTTP origin and uses `wss://` rather than `ws://`.

---

## 3. Catch-up and cursor semantics

WebSocket does not have SSE's built-in `Last-Event-ID` mechanism. The current implementation therefore uses an explicit query parameter:

```text
GET /ws?userId=24&after=157
```

The server executes:

```text
fetchNotificationsAfter(userId, after, 200)
```

which selects notifications with:

```sql
recipient_id = ?
AND id > ?
ORDER BY id ASC
LIMIT 200
```

The same persistent notification ID is therefore used as the client cursor. fileciteturn92file0L2-L2

The client starts with `after=0`, advances the cursor to the largest notification ID received, and reconnects using that cursor. It also deduplicates notifications by ID before adding them to React state. fileciteturn90file0L2-L2

A connection establishment can replay at most **200** missed notifications. For larger gaps, the normal notification history API should be treated as the recovery mechanism rather than assuming one WebSocket connection will replay unlimited history.

---

## 4. Catch-up/realtime race window

The current server performs catch-up before registering the WebSocket subscription:

```text
fetchNotificationsAfter(...)
        │
        ▼
send missed notifications
        │
        ▼
wsHub.subscribe(...)
```

Therefore there is a small race window in which a notification can be created after the catch-up query but before the subscription is registered. That notification can be missed by this connection's realtime path.

This is a known limitation of the current implementation. The notification remains persisted and can be recovered by reconnecting with the last received cursor or by using notification history. The implementation does **not** provide an atomic catch-up-plus-subscribe operation.

This should be considered when interpreting the WebSocket transport as **at-least-once-oriented with recovery**, not as a strict exactly-once stream.

---

## 5. Realtime fan-out and `WsHub`

`wsHub` is a `PushHub<WsSubscription>` instance:

```text
WsHub
  │
  └── PushHub<WsSubscription>
          │
          ├── user A → socket 1
          ├── user A → socket 2
          └── user B → socket 3
```

The subscription contains the WebSocket and its `connectionId`. The generic hub is shared as an abstraction with SSE, but the actual hub instances are separate. fileciteturn89file0L2-L2

When a new notification is created, `app.ts` fetches the complete rows and publishes each row only to its `recipient_id`:

```text
wsHub.publish(recipientId, row)
```

This is targeted delivery, not broadcast-to-all. fileciteturn95file0L2-L2

### Multi-instance limitation

`WsHub` is process-local. With two backend instances:

```text
Instance A → WsHub A → connections on A
Instance B → WsHub B → connections on B
```

A notification created on A is not automatically published to connections held by B. A production multi-instance implementation would require a shared event-distribution mechanism such as Redis Pub/Sub or a message broker. That is outside the current lab scope.

---

## 6. Notification message format

The server sends application messages in the following form:

```json
{
  "type": "notification",
  "data": {
    "id": 123,
    "actorId": 1,
    "actorDisplayName": "alice",
    "postId": 456,
    "scriptPreview": "post preview",
    "createdAt": 1720000000,
    "serverSentAtMs": 1720000000123
  }
}
```

The server also sends:

```json
{
  "type": "connected",
  "userId": 24,
  "connectionId": 17
}
```

Invalid/malformed application messages are ignored unless they form a valid ACK message. A server-side validation error for a missing `userId` is sent as an explicit `error` message before the connection is closed. fileciteturn88file0L2-L2

`serverSentAtMs` is captured immediately before the server serializes/sends the notification. It is intended for benchmark instrumentation; it is not proof that the browser received the event at that timestamp.

---

## 7. Bidirectional ACK semantics

The WebSocket client sends:

```json
{
  "type": "ack",
  "notificationId": 123
}
```

The server validates the message shape and calls:

```text
notificationService.markAcknowledged(notificationId, userId)
```

The database update is restricted to the recipient's own notification and only changes notifications whose current status is `queued` or `delivered`:

```text
queued / delivered
        │
        │ valid client ACK
        ▼
acknowledged
```

This is the clearest architectural difference between WebSocket and the other transports in this lab: the client can send an application-level message to the server over the same connection. fileciteturn97file0L2-L2

The ACK means the application received the notification message and explicitly confirmed it. It does **not** mean the human user saw the notification.

The current implementation does not send a separate `acknowledged` response back to the client.

---

## 8. Protocol heartbeat

The server uses the WebSocket protocol's native ping/pong mechanism:

```text
server
  │
  │ ping
  ▼
client
  │
  │ pong
  ▼
server
```

The configured interval is:

```text
WS_HEARTBEAT_MS=20000
```

The server marks the connection alive when it receives `pong`. On each heartbeat interval:

```text
if previous ping has no pong
       │
       ▼
socket.terminate()
```

This is a **protocol-level heartbeat**, not an application JSON message. The browser/WebSocket implementation handles the protocol response automatically, so the React client does not need a custom heartbeat handler. fileciteturn88file0L2-L2 fileciteturn90file0L2-L2

The timeout behavior is therefore approximately one heartbeat interval after a missing pong, rather than an application-level ping timeout with a separate grace period.

---

## 9. Reconnect behavior

Unlike `EventSource`, the browser's native WebSocket API does **not** automatically reconnect.

The React transport therefore implements reconnect itself:

```text
close/error
    │
    ▼
attempt++
    │
    ▼
computeBackoffDelay()
    │
    ▼
new WebSocket(...&after=currentCursor)
```

Current frontend values are:

```text
BASE_RETRY_DELAY_MS = 1000
MAX_RETRY_DELAY_MS  = 30000
```

The cursor is preserved across reconnects so missed notifications can be requested again. The frontend also deduplicates by notification ID. fileciteturn90file0L2-L2

The benchmark WebSocket client uses the same cursor concept but currently reconnects with a fixed **1-second delay**, rather than the frontend's exponential/backoff helper. fileciteturn96file0L2-L2

This distinction matters when interpreting benchmark results: browser reconnect behavior and benchmark reconnect behavior are not identical implementations.

---

## 10. Backpressure

Before sending a notification, the backend checks:

```text
socket.bufferedAmount > 1,000,000 bytes
```

If the threshold is exceeded, the current implementation:

1. Does **not** call `socket.send()`.
2. Records a failed WebSocket delivery attempt.
3. Uses the error reason `backpressure: bufferedAmount vượt ngưỡng`.
4. Does not block the event loop waiting for the socket buffer to drain.

This is intentionally a drop/fail policy rather than a queueing policy. A notification skipped because of backpressure remains persisted and can be recovered later using the notification cursor/history path. fileciteturn88file0L2-L2

The threshold is currently a hard-coded `1_000_000` bytes in `websocket.ts`; it is not an environment-configured value.

---

## 11. Ordering and duplicates

Within a single connection, catch-up notifications are queried in ascending notification ID order and sent sequentially. Realtime notifications are delivered through the same socket as they reach the hub.

The architecture should therefore assume:

- Notification IDs provide the ordering/cursor basis.
- One connection is expected to observe notifications in increasing ID order under normal operation.
- Multiple connections/tabs for the same user have no single global ordering guarantee.
- Reconnects can cause duplicate delivery if the cursor has not advanced past an already delivered notification.
- The frontend deduplicates by notification ID. fileciteturn90file0L2-L2

Exactly-once user-visible delivery is not guaranteed.

---

## 12. Connection tracking and cleanup

Every successful WebSocket connection creates a `connections` row:

```text
connect
   │
   ▼
openConnection(userId, "websocket")
   │
   ▼
connections table
```

On `close` or `error`, the guarded cleanup function:

```text
clear heartbeat timer
        │
        ▼
unsubscribe from WsHub
        │
        ▼
closeConnection(connectionId, "client_disconnect")
```

The cleanup guard prevents duplicate cleanup when both `error` and `close` occur. fileciteturn88file0L2-L2

During process shutdown, `server.ts` calls:

```text
sseHub.closeAll()
wsHub.closeAll()
app.close()
```

The WebSocket hub's `forceClose` callback closes active sockets with code `1001` (`server_shutdown`). fileciteturn89file0L2-L2 fileciteturn93file0L2-L2

---

## 13. Delivery status and delivery attempts

A successful WebSocket send is passed to `recordDeliveryBatch()`:

```text
socket.send()
     │
     ▼
markDelivered()
     │
     ▼
recordDeliveryAttempt(result="success")
```

The recorded `latencyMs` is based on:

```text
serverSentAtMs - notification.created_at
```

More precisely, the current query helper computes:

```text
baseTimeMs - n.created_at * 1000
```

where `baseTimeMs` is captured immediately before the WebSocket send. This is **server-observed delivery/send latency**, not browser receipt latency. fileciteturn92file0L2-L2

Backpressure failures are recorded separately as `result="failed"` and do not call `markDelivered()`. fileciteturn88file0L2-L2

After a client ACK, the notification can become `acknowledged`. This state is separate from the historical `delivery_attempts` record.

---

## 14. Frontend implementation

The React transport keeps:

```text
notifications
connectionState: connecting | open | closed
lastError
current cursor
reconnect attempt count
```

When a notification arrives it:

1. Parses the server JSON.
2. Converts the payload into the shared `PolledNotification` shape.
3. Advances the cursor using the notification ID.
4. Deduplicates by ID before updating React state.
5. Sends an application-level ACK on the same WebSocket. fileciteturn90file0L2-L2

When the connection closes, the hook schedules a reconnect unless the transport was explicitly stopped or disabled.

When the user/transport changes, the current hook resets the notification list and cursor to zero before connecting again.

---

## 15. Testing

`backend/src/routes/websocket.test.ts` uses the real `ws` package as a client and a real listening Fastify server. It intentionally does not use `fastify.inject()` because protocol upgrade behavior is not equivalent to a normal HTTP request. fileciteturn94file0L2-L2

The current test suite covers:

1. `connected` message after a successful connection.
2. Catch-up of an existing notification.
3. Realtime notification after connection.
4. Client ACK changing status to `acknowledged`.
5. Reconnect with `after` without replaying an already seen notification.
6. Connection cleanup and `connections` persistence.
7. Missing `userId` causing close code `1008`. fileciteturn94file0L2-L2

### Remaining validation gaps

**Heartbeat timeout:** the normal `ws` test client automatically responds to protocol `ping` frames with `pong`, so a stale client that deliberately stops responding is not represented by the ordinary integration tests. A custom non-responsive client or controlled socket test would be required.

**Backpressure:** filling `bufferedAmount` deterministically on localhost is difficult. The implementation has the protection, but a realistic slow-client scenario is better validated under benchmark/load conditions.

**Browser-specific behavior:** native browser WebSocket lifecycle, background-tab policies, real proxy/LB upgrades, TLS, and production network failures still require browser/deployment validation.

---

## 16. Benchmark implementation

The benchmark has a dedicated Node `ws` client. It records:

```text
notificationId
receivedAtMonoMs
serverCreatedAtMs
serverSentAtMs
```

and sends an ACK after receiving each notification. It maintains a cursor and reconnects using that cursor. For simulated slow clients, an additional client-side delay can be introduced before recording the event. fileciteturn96file0L2-L2

The benchmark can therefore distinguish:

| Metric | Meaning |
|---|---|
| E2E latency | Estimated notification creation → benchmark client receipt |
| Transport/network latency | Estimated `serverSentAtMs` → benchmark client receipt |
| Server delivery latency | Notification creation → backend recorded send attempt |
| Delivery rate | Expected unique notifications received / expected notifications |
| Duplicate count | Repeated notification IDs received |
| Reconnect count | Benchmark WebSocket reconnect attempts |
| ACK path | Whether the benchmark client sends application ACKs back to the server |

The benchmark should not call `serverSentAtMs - createdAt` a browser E2E measurement. `serverSentAtMs` is a server-side instrumentation timestamp, while `receivedAtMonoMs` is measured by the benchmark client.

No fixed performance result is asserted in this transport report until an actual benchmark run produces the corresponding result data.

---

## 17. Strengths

- **True application-level bidirectionality:** the client can send ACKs or future application commands over the same connection.
- **Low-latency push after connection establishment:** no polling interval is required.
- **Protocol-level heartbeat:** ping/pong is part of the WebSocket protocol rather than an application JSON heartbeat.
- **Cursor-based catch-up:** reconnects can request notifications after the last received persistent ID.
- **Explicit backpressure handling:** the server avoids blindly growing the socket buffer beyond the configured hard threshold.
- **Good fit for interactive realtime features:** chat, collaborative editing, live controls, and other cases where both sides need to communicate continuously.

## 18. Weaknesses and limitations

- **Higher implementation complexity:** reconnect, heartbeat, cleanup, backpressure, and bidirectional message validation must be handled explicitly.
- **No browser built-in reconnect:** the application must implement reconnect and backoff.
- **In-process hub:** current `WsHub` does not distribute notifications across backend instances.
- **Bounded catch-up:** a connection establishment replays at most 200 notifications.
- **Catch-up/subscription race:** there is no atomic registration covering both historical replay and future realtime events.
- **Backpressure policy drops the current send:** the event is not queued for that socket when `bufferedAmount` exceeds 1 MB; recovery must happen later through the persisted notification state.
- **Infrastructure requirements:** reverse proxies/load balancers must support WebSocket upgrade and long-lived connections.
- **Minimal authentication:** `userId` in the query string is an intentionally simplified lab identity mechanism, not production security.

---

## 19. Best suited for

- Chat and other bidirectional realtime communication.
- Collaborative editing or interactive shared state.
- Applications where the client needs to acknowledge or command the server over the same persistent connection.
- Realtime notification systems that may later evolve into richer bidirectional interactions.

## 20. Poorly suited for

- Simple server-to-client notifications where no client message is needed; SSE is simpler.
- Background notifications while the browser tab is closed; Web Push is a better fit.
- Environments that cannot support WebSocket upgrades or long-lived connections.
- Multi-instance deployments without a shared event distribution layer.

---

## 21. Comparison summary

| Category | Assessment |
|---|---|
| Complexity | High |
| Connection model | Long-lived bidirectional WebSocket |
| Latency | Low after connection establishment; exact values require benchmark runs |
| Throughput | Benchmarkable with the current framework; no fixed result claimed here |
| Scalability | Good connection model, but current hub is single-process |
| Reliability | At-least-once-oriented with cursor recovery; application ACK provides an explicit client confirmation, not user-visible proof |
| Browser support | Broad modern-browser support through the standard WebSocket API; target-browser/deployment validation still required |
| Infrastructure | WebSocket-aware proxy/load balancer and long-lived connection support |
| Operational complexity | High |
| Best use case | Bidirectional realtime applications |
