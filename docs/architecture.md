# Architecture — Notification Lab

> This document describes the architecture currently implemented on `feature/render-deployment`.
> It is intentionally a lab architecture: it demonstrates and benchmarks notification delivery techniques rather than providing a horizontally scalable production design.

## 1. Architecture goals

Notification Lab separates **notification state** from the mechanism used to deliver that state to a client.

The core design is:

```text
Business Event
     │
     ▼
Persistent Notification State
     │
     ├───────────────┬───────────────┬───────────────┬───────────────┐
     ▼               ▼               ▼               ▼               ▼
Short Polling   Long Polling       SSE          WebSocket       Web Push
     │               │               │               │               │
     └───────────────┴───────────────┴───────────────┴───────────────┘
                                      │
                                      ▼
                              Client notification state
                                      │
                                      ▼
                                  Recovery
```

The important architectural rule is:

> **A transport is not the source of truth. The persisted notification record is the source of truth; transports deliver or signal that state to the client.**

This makes cursor-based recovery possible even when a realtime connection is interrupted or a push event is missed.

---

## 2. System overview

### Local development

```text
┌──────────────────────────────┐
│ React SPA + Vite             │
│ :5173                        │
└──────────────┬───────────────┘
               │ /api/*
               │ Vite proxy
               ▼
┌──────────────────────────────┐
│ Fastify API                  │
│ :3000                        │
│                              │
│ users / follows / posts      │
│ notifications                │
│ short polling / long polling │
│ SSE / WebSocket / Web Push   │
│ benchmark                    │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ SQLite                       │
│ better-sqlite3               │
│ WAL mode                     │
└──────────────────────────────┘
```

The backend listens on `0.0.0.0` so the same server process can run in a hosted environment. The database schema is migrated during backend startup. fileciteturn48file0L2-L2

### Deployed environment

```text
Browser
   │
   │ HTTPS
   ▼
Frontend hosting
   │
   │ VITE_API_BASE_URL
   ▼
Fastify backend
   │
   ├── HTTP API
   ├── SSE
   ├── WebSocket
   └── Web Push
        │
        ▼
     SQLite
```

In production, the frontend calls the backend directly through `VITE_API_BASE_URL`. The WebSocket URL is derived from the HTTP origin (`https` → `wss`). fileciteturn49file0L2-L2

---

## 3. Domain architecture

The backend keeps the business/domain operation of creating notifications separate from transport implementations.

```text
HTTP route
   │
   │ business action
   ▼
NotificationService
   │
   ├── create Event
   ├── find followers
   ├── fan-out Notification rows
   └── emit notification-created event
             │
             ▼
       transport wiring
```

`NotificationService` does **not** directly depend on SSE, WebSocket, polling, or Web Push. It creates the persistent notification records and emits an in-process notification-created event after the transaction completes. Transport wiring in `app.ts` listens to that event. fileciteturn41file0L2-L2

### 3.1 Post → notification fan-out

```text
POST /posts
    │
    ▼
createPostCreatedEvent(actorId, postId)
    │
    ▼
DB transaction
    ├── INSERT events
    ├── SELECT followers
    └── INSERT notifications(status='queued')
    │
    ▼
transaction committed
    │
    ▼
notificationService.emit(...)
```

Each follower receives a separate notification row. The resulting notification IDs and recipient IDs are passed to the in-process listeners. fileciteturn41file0L2-L2

### 3.2 Notification status

The notification lifecycle includes states used by the current implementation:

```text
queued
   │
   ├── transport delivery succeeds ──► delivered
   │
   ├── WebSocket client ACK ─────────► acknowledged
   │
   └── REST read operation ──────────► read
```

`acknowledged` is specifically associated with the bidirectional WebSocket flow. Polling and SSE do not have an ACK channel on the same transport connection; they use the separate REST read operation instead. fileciteturn41file0L2-L2

`delivery_attempts` records transport-level delivery attempts independently from the notification's business state. Each attempt can be `success`, `failed`, or `timeout`. fileciteturn41file0L2-L2

---

## 4. Notification query and serialization layers

The transport implementations share a small set of domain helpers rather than each implementing its own notification query semantics.

### 4.1 Cursor-based notification query

```text
fetchNotificationsAfter(recipientId, after, limit)
                    │
                    ▼
        notifications WHERE id > after
                    │
                    ▼
              ordered by id
```

Short Polling and Long Polling use the same `after` cursor semantics. This gives both transports the same recovery model and makes duplicate handling explicit: clients can keep a cursor and deduplicate by notification ID. fileciteturn42file0L2-L2

A second query, `fetchNotificationsByIds()`, is used by the realtime push path to turn the IDs emitted by `NotificationService` into complete notification rows with their recipients before publishing to SSE and WebSocket clients. fileciteturn42file0L2-L2

### 4.2 Client serialization

SSE and WebSocket share the same serialized notification shape:

```text
id
actorId
actorDisplayName
postId
scriptPreview
createdAt
serverSentAtMs
```

`serverSentAtMs` is captured immediately before the transport writes the payload. It is intended to help benchmark transport/network timing without requiring synchronized client and server clocks. It is not itself a measurement of complete end-to-end delivery latency. fileciteturn43file0L2-L2

### 4.3 Delivery-attempt latency

For polling, `recordDeliveryBatch()` calculates:

```text
latencyMs = server request/response timestamp - notification.created_at
```

This is **server-side delivery latency**, not the time at which the browser actually received the notification. The benchmark must not label this value as true end-to-end client latency. fileciteturn42file0L2-L2

---

## 5. Transport architecture

The five implemented notification transports have different connection and delivery models, but all ultimately operate on the same persisted notification state.

### 5.1 Short Polling

```text
Client
  │
  │ GET /notifications/poll?after=N
  ▼
Route
  │
  ▼
fetchNotificationsAfter()
  │
  ▼
SQLite
  │
  ▼
items + nextAfter
  │
  ▼
Client updates cursor
```

The client periodically asks for notifications whose IDs are greater than its current cursor. No persistent server-side connection is required.

---

### 5.2 Long Polling

```text
Client
  │
  │ GET /notifications/poll?... wait
  ▼
Long Poll route
  │
  ├── query DB immediately
  │
  └── no notification
          │
          ▼
   NotificationWaiters
          │
          │ notification-created event
          ▼
        wake waiter
          │
          ▼
     query DB again
          │
          ▼
       response
```

`NotificationWaiters` is an in-memory registry used only to wake requests waiting for a user. It does **not** store notification data; the waiting request re-queries the database after it is awakened. fileciteturn46file0L2-L2

Multiple waiters for the same user can be awakened by one notification-created event. This can result in duplicate delivery, which is intentional under the lab's at-least-once delivery model. Clients should deduplicate by notification ID. fileciteturn46file0L2-L2

---

### 5.3 Server-Sent Events (SSE)

```text
Client
  │
  │ GET /notifications/stream
  │ Last-Event-ID / cursor
  ▼
SSE route
  │
  ├── catch up from persisted state
  │
  └── subscribe to SseHub
               │
               │ new notification
               ▼
           SseHub.publish()
               │
               ▼
          EventSource client
```

SSE uses a long-lived HTTP connection. The server can first replay missed notifications and then keep the connection open for new events. Heartbeats keep the connection active, and disconnect cleanup removes the subscription.

The implementation uses `PushHub` as the underlying in-process hub for SSE. fileciteturn44file0L2-L2

---

### 5.4 WebSocket

```text
Client
  │
  │ WebSocket /ws
  ▼
WsHub
  │
  ├── connection lifecycle
  ├── heartbeat
  ├── notification publish
  └── client ACK
          │
          ▼
   notificationService.markAcknowledged()
```

WebSocket is the only current transport with a bidirectional application-level ACK path. The ACK can move a notification from `queued`/`delivered` to `acknowledged`. fileciteturn41file0L2-L2

The implementation also uses `PushHub` as the underlying in-process hub for WebSocket connections, with a WebSocket-specific subscription containing the socket and connection ID. fileciteturn45file0L2-L2

SSE and WebSocket therefore share the same generic `PushHub` abstraction, but they maintain separate hub instances and separate connection types. fileciteturn44file0L2-L2 fileciteturn45file0L2-L2

---

### 5.5 Web Push

Web Push is intentionally different from SSE/WebSocket: it does not maintain an application connection to the backend.

#### Server-side dispatch

```text
NotificationService
      │
      ▼
notification persisted
      │
      ▼
sendWebPushForNotification()
      │
      ▼
push_subscriptions
      │
      ▼
Web Push Service
```

The backend loads active subscriptions for the recipient and calls `webpush.sendNotification()` for each subscription. The dispatch is fire-and-forget from the notification-created listener, so a slow/failing Push Service does not block the main notification creation flow. Within the background sender, individual subscription sends are awaited sequentially so each result can be recorded. fileciteturn40file0L2-L2 fileciteturn47file0L2-L2

#### Browser-side flow

```text
Web Push Service
      │
      ▼
Service Worker
      │
      ├──────────────► showNotification()
      │
      └──────────────► postMessage(notificationId)
                              │
                              ▼
                         React Web Push hook
                              │
                              ▼
                       recoverAfterPush()
                              │
                              ▼
                  GET notification history
                              │
                              ▼
                       merge into UI state
```

The push event is therefore a **delivery signal**, not the authoritative notification state. The client can recover the actual notification from the backend using the notification cursor/history API.

Expired push subscriptions (HTTP 404/410) are marked invalid, and Web Push delivery attempts are recorded in `delivery_attempts`. fileciteturn47file0L2-L2

A successful `webpush.sendNotification()` means the server-side Web Push operation succeeded; it does **not** prove that the user saw the operating-system notification or that the React UI received and reconciled the notification.

---

## 6. Client state and recovery

The notification state model is designed around a persistent cursor.

```text
Client cursor
     │
     │ after=N
     ▼
Notification history API
     │
     ▼
SQLite notifications
     │
     ▼
notifications with id > N
     │
     ▼
client merge + dedupe
     │
     ▼
advance cursor
```

This model is especially important for transports that can lose a connection or event:

- Short Polling naturally resumes from the last cursor.
- Long Polling resumes from the last cursor after timeout/reconnect.
- SSE can catch up from persisted notification state before/around establishing realtime delivery.
- WebSocket can use the notification history/cursor mechanism for recovery rather than treating the socket as the source of truth.
- Web Push uses the push event as a signal and then explicitly performs state recovery.

The architecture therefore favors **at-least-once delivery plus client deduplication/reconciliation** rather than pretending that a realtime transport can guarantee exactly-once delivery.

---

## 7. Delivery semantics

The current lab should be interpreted as follows:

| Concept | Meaning |
|---|---|
| `queued` | Notification record exists and has not yet been marked delivered by a transport path |
| `delivered` | A transport-level delivery operation succeeded according to the backend's observation |
| `acknowledged` | WebSocket client explicitly acknowledged the notification |
| `read` | Notification was marked read through the REST read operation |
| `delivery_attempts` | Historical record of transport delivery attempts |

These states must not be conflated with user-visible guarantees.

In particular:

```text
backend marked delivered
        ≠
browser received
        ≠
UI reconciled
        ≠
user saw notification
```

---

## 8. Backend component map

```text
backend/src/
├── app.ts
│   ├── Fastify setup
│   ├── CORS
│   ├── WebSocket plugin
│   └── transport wiring
│
├── server.ts
│   ├── migration
│   ├── app startup
│   └── graceful shutdown
│
├── domain/
│   ├── notificationService.ts
│   ├── notificationQueries.ts
│   ├── notificationSerialization.ts
│   ├── notificationWaiters.ts
│   ├── pushHub.ts
│   ├── sseHub.ts
│   ├── wsHub.ts
│   └── webPushSender.ts
│
├── routes/
│   ├── users.ts
│   ├── follows.ts
│   ├── posts.ts
│   ├── notifications.ts
│   ├── shortPolling.ts
│   ├── longPolling.ts
│   ├── sse.ts
│   ├── websocket.ts
│   ├── webPush.ts
│   └── benchmark.ts
│
└── db/
    ├── index.ts
    └── schema.sql
```

`app.ts` registers all five notification transports plus the benchmark routes and wires `NotificationService` to the transport-specific in-process components. fileciteturn40file0L2-L2

---

## 9. Frontend component model

The frontend uses one transport module/hook per transport and shares API/configuration concepts.

```text
React UI
   │
   ├── Short Polling
   ├── Long Polling
   ├── SSE
   ├── WebSocket
   └── Web Push
          │
          ▼
     API / transport endpoints
```

The frontend API base is environment-dependent:

```text
Development
React :5173
   │
   └── /api proxy
          ▼
       Fastify :3000

Production
React
   │
   └── VITE_API_BASE_URL
          ▼
       Fastify backend
```

The WebSocket endpoint is derived from the same backend origin, converting `http`/`https` to `ws`/`wss`. fileciteturn49file0L2-L2

---

## 10. Database architecture

SQLite is the persistent state store for the lab.

Conceptually:

```text
users
  │
  ├── follows
  │
  └── push_subscriptions

posts
  │
  ▼
events
  │
  ▼
notifications
  │
  └── delivery_attempts
```

The notification record connects the business event to a specific recipient. Transport-specific delivery history is stored separately in `delivery_attempts`.

The current project intentionally uses a single SQLite database file and in-process transport hubs. This is appropriate for the lab/benchmark scope but is not a complete horizontally scalable production architecture.

---

## 11. In-process boundaries and scalability limitation

The following components are process-local:

```text
NotificationService listeners
NotificationWaiters
SseHub
WsHub
```

Therefore:

```text
Instance A
  │
  ├── creates notification
  └── wakes/publishes only to connections known by A

Instance B
  └── does not automatically receive A's in-process event
```

With multiple backend instances, a notification created on instance A will not automatically wake a Long Polling waiter or publish to an SSE/WebSocket connection held by instance B. `NotificationWaiters` explicitly documents this limitation. fileciteturn46file0L2-L2

A production multi-instance design would need a shared event/distribution mechanism such as Redis Pub/Sub or a message broker, plus a shared persistent database/storage strategy. That is outside the current lab scope.

---

## 12. Benchmark architecture

The benchmark intentionally separates transport behavior from the deployment architecture.

```text
Benchmark runner
      │
      ▼
HTTP / transport clients
      │
      ▼
Fastify backend
      │
      ▼
SQLite
```

The benchmark can automate the server-observable behavior of Short Polling, Long Polling, SSE, and WebSocket. Web Push requires additional browser/Service Worker behavior, so it is evaluated with a combination of server-side dispatch instrumentation and browser/manual validation rather than being treated as an identical fully automated client benchmark.

The architecture must distinguish:

```text
server-side delivery latency
```

from:

```text
true client end-to-end latency
```

because the backend does not universally receive a client-level ACK at the point where every transport payload reaches the browser. `serverSentAtMs` was added to the SSE/WebSocket payload specifically to improve transport timing instrumentation without assuming synchronized clocks. fileciteturn43file0L2-L2

---

## 13. Deployment architecture

The current deployment-oriented branch is designed so the backend can run in a hosted environment while the frontend can point directly at its backend URL.

```text
                    Internet
                       │
             ┌─────────┴─────────┐
             │                   │
             ▼                   ▼
       Frontend hosting     Render backend
             │                   │
             │ HTTPS             │
             └───────┐     ┌─────┘
                     ▼     ▼
                   Browser
```

The backend binds to `0.0.0.0` and uses the configured port, which is required for the hosted runtime. fileciteturn48file0L2-L2

The frontend uses `VITE_API_BASE_URL` to switch from the local `/api` proxy to the deployed backend origin. fileciteturn49file0L2-L2

Detailed hosting instructions should live in the deployment documentation rather than being duplicated here.

---

## 14. Graceful shutdown

The backend closes active SSE and WebSocket connections during `SIGINT`/`SIGTERM` shutdown before closing the Fastify application.

```text
SIGTERM / SIGINT
       │
       ├── sseHub.closeAll()
       ├── wsHub.closeAll()
       └── app.close()
```

This is particularly useful for tests and benchmark runs because active connections are explicitly cleaned up. fileciteturn48file0L2-L2

---

## 15. Current limitations

This architecture deliberately does **not** claim production-grade guarantees.

### Persistence

- SQLite is used as the lab database.
- Horizontal scaling with a single local SQLite file is not supported as a production architecture.

### Realtime fan-out

- `NotificationService` listeners are in-process.
- `NotificationWaiters`, `SseHub`, and `WsHub` are in-memory.
- There is no Redis Pub/Sub or external message broker.

### Delivery guarantees

- The system follows an at-least-once-oriented model.
- Duplicate delivery is possible.
- Clients should deduplicate by notification ID.
- `delivered` is not proof that a user saw the notification.

### Web Push

- Web Push depends on browser Service Worker and external Push Service behavior.
- A successful backend push operation does not prove UI reconciliation or user visibility.
- Expired subscriptions are invalidated when the Push Service reports HTTP 404/410.

### Benchmark

- Server-side delivery timing is not equivalent to universal true end-to-end client latency.
- Web Push cannot be benchmarked through exactly the same automated client path as SSE/WebSocket/Polling.

---

## 16. Architectural summary

The current Notification Lab architecture can be summarized as:

```text
                     BUSINESS EVENT
                           │
                           ▼
                  NotificationService
                           │
                           ▼
                 Persistent Notification
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
          Polling       SSE / WS     Web Push
              │            │            │
              │            │       Service Worker
              │            │            │
              └────────────┴────────────┘
                           │
                           ▼
                    Client state
                           │
                           ▼
                    Cursor / recovery
                           │
                           ▼
                         UI
```

The central design decision is to keep **persistent notification state independent from delivery transport**. This allows the project to compare five notification techniques while retaining a common notification model, common cursor semantics where applicable, explicit delivery-attempt tracking, and recovery paths for missed events.
