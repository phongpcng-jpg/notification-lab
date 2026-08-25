# Transport Report: Web Push

**Technique:** Web Push (Push API + Service Worker + Notification API)

**Status:** Implemented on `feature/render-deployment`; real Push Service delivery remains dependent on browser/OS support and an externally configured VAPID setup.

## 1. Architecture

Web Push is fundamentally different from Short Polling, Long Polling, SSE, and WebSocket because the application does not keep an application-level connection open to the backend for each notification.

```text
React application
      │
      │ register / subscribe
      ▼
Service Worker (/sw.js)
      │
      │ PushManager.subscribe()
      ▼
PushSubscription
      │
      │ POST /push/subscribe
      ▼
Backend: push_subscriptions

Notification created
      │
      ▼
NotificationService
      │
      ▼
sendWebPushForNotification()
      │
      ▼
Web Push Service
      │
      ▼
Service Worker push event
      ├──────────────► showNotification()
      │
      └──────────────► postMessage(notificationId)
                              │
                              ▼
                         React Web Push hook
                              │
                              ▼
                  GET /notifications?after=N
                              │
                              ▼
                     merge + deduplicate
```

The backend sends the Web Push payload to the browser/vendor Push Service through the `web-push` library and VAPID credentials. It does not maintain a direct application connection to the browser. fileciteturn51file0L2-L2

The most important architectural point is:

> **The push event is a delivery signal; the persisted notification is the source of truth.**

The current frontend therefore performs history loading and cursor-based recovery instead of assuming that the push payload itself is sufficient for maintaining application state. fileciteturn54file0L2-L2

---

## 2. Subscription lifecycle

### 2.1 Subscribe

The current frontend performs the following sequence:

```text
User enables Web Push
        │
        ▼
register /sw.js
        │
        ▼
Notification.requestPermission()
        │
        ├── denied ──► permission-denied
        │
        ▼
GET /push/vapid-public-key
        │
        ▼
PushManager.subscribe()
        │
        ▼
POST /push/subscribe
        │
        ▼
push_subscriptions
        │
        ▼
load notification history
```

The client explicitly handles unsupported browsers, denied permission, missing VAPID configuration, and subscription errors. fileciteturn54file0L2-L2

### 2.2 Backend subscription storage

`POST /push/subscribe` requires:

- `userId`
- `subscription.endpoint`
- `subscription.keys.p256dh`
- `subscription.keys.auth`

The endpoint is used as the conflict key. Re-subscribing the same endpoint updates its user, cryptographic keys, `last_seen_at`, and clears `invalid_at`. This also permits the same browser endpoint to become associated with another user. fileciteturn52file0L2-L2

### 2.3 Unsubscribe

`POST /push/unsubscribe` removes the stored subscription by endpoint. The frontend then calls `PushSubscription.unsubscribe()` locally. fileciteturn52file0L2-L2 fileciteturn54file0L2-L2

---

## 3. Server-side notification delivery

When a notification is created, the Web Push sender loads active subscriptions for the notification recipient:

```text
notification
    │
    ▼
recipient_id
    │
    ▼
SELECT push_subscriptions
WHERE user_id = ?
  AND invalid_at IS NULL
    │
    ▼
for each subscription
    │
    ▼
webpush.sendNotification()
```

The sender uses:

```text
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT
```

and configures the `web-push` library lazily when the public key changes. fileciteturn51file0L2-L2

If VAPID is not configured, the current sender **skips Web Push delivery without failing notification creation**. This is an intentional degradation path for environments where Web Push has not been configured yet. fileciteturn51file0L2-L2

The Web Push send is invoked asynchronously from the notification-created listener, so the main notification creation flow does not wait for the external Push Service. Individual subscription sends inside the sender are awaited so their results can be recorded. fileciteturn51file0L2-L2

---

## 4. Push payload

The current backend sends JSON containing:

```json
{
  "title": "<actor> vừa đăng bài mới",
  "body": "<post preview>",
  "notificationId": 123,
  "postId": 456
}
```

The `notificationId` is particularly important because the Service Worker passes it to the active application tab. The frontend then uses that ID as the trigger for recovery from the canonical notification history endpoint. fileciteturn51file0L2-L2 fileciteturn53file0L2-L2

The project currently does not treat the Web Push payload as a complete authoritative application-state record.

---

## 5. Service Worker behavior

`frontend/public/sw.js` runs outside the normal React tab lifecycle.

On a `push` event it:

1. Parses the JSON payload.
2. Extracts `title`, `body`, `notificationId`, and `postId`.
3. Calls `showNotification()` to display an operating-system/browser notification.
4. Finds active/uncontrolled window clients.
5. Sends `{ type: "notification", notificationId }` to those clients through `postMessage()`. fileciteturn53file0L2-L2

The Service Worker also handles notification clicks by closing the notification and focusing an existing window or opening `/` when no window is available. fileciteturn53file0L2-L2

### Important limitation

A push event can wake the Service Worker even when the application tab is not open, but `postMessage()` can only reach matching window clients that actually exist. Therefore:

```text
Tab open
   │
   └── push → Service Worker → postMessage → React

Tab closed
   │
   └── push → Service Worker → showNotification
                              └── no React client to message
```

This is why the system must not depend on `postMessage()` as the only mechanism for updating application state.

---

## 6. React-side recovery

The Web Push hook maintains a local notification list and an `afterRef` cursor.

Initial load:

```text
useWebPush enabled
       │
       ▼
GET /notifications?after=0
       │
       ▼
mergeNotifications()
       │
       ▼
advance afterRef
```

When the Service Worker sends a notification message:

```text
Service Worker
      │
      │ postMessage(notificationId)
      ▼
useWebPush message listener
      │
      ▼
recoverAfterPush(notificationId)
      │
      ▼
GET /notifications?after=currentCursor
      │
      ▼
mergeNotifications()
      │
      ▼
deduplicate by notification.id
```

The `notificationId` is logged and passed into the recovery function, but the recovery query itself uses the current cursor. This allows the client to recover any notifications missed before the push event rather than fetching only one notification. fileciteturn54file0L2-L2

`mergeNotifications()` removes IDs already present in the React state and advances the cursor using the largest notification ID received. fileciteturn54file0L2-L2

---

## 7. Delivery-attempt tracking

The backend records Web Push attempts in `delivery_attempts`.

### Success

After `webpush.sendNotification()` succeeds:

```text
markDelivered(notificationId)
recordDeliveryAttempt(... result="success")
update subscription.last_seen_at
```

### Expired subscription

For HTTP `404` or `410` from the Push Service:

```text
send fails
   │
   ▼
subscription.invalid_at = now
   │
   ▼
record failed delivery attempt
```

That subscription is excluded from future sends because the sender only selects subscriptions where `invalid_at IS NULL`. fileciteturn51file0L2-L2

### Other errors

Other errors are recorded as failed attempts with the returned error message, but the subscription is not automatically marked invalid. fileciteturn51file0L2-L2

---

## 8. Delivery semantics

Web Push should be described as **best-effort transport delivery**, not guaranteed user-visible delivery.

The following are different events:

```text
webpush.sendNotification() succeeds
        ≠
Push Service delivers to browser
        ≠
Service Worker receives push
        ≠
showNotification() completes
        ≠
React receives postMessage()
        ≠
React reconciles application state
        ≠
user sees/opens notification
```

The backend's `delivered` state represents successful completion of its observed transport operation. It is not proof that the browser displayed the notification or that the user saw it.

The project therefore combines Web Push with persistent notification history and client-side reconciliation rather than attempting to guarantee exactly-once user-visible delivery.

---

## 9. Strengths

- **Works without an application connection:** the browser Push Service can deliver a push event to the Service Worker even when the application tab is not open.
- **Good fit for background/offline-style notifications:** useful when the user should be alerted without keeping an SSE/WebSocket connection alive.
- **Low application connection overhead:** the backend does not maintain one persistent application socket per subscribed browser.
- **Subscription lifecycle management:** expired subscriptions are invalidated after HTTP 404/410 and excluded from later sends. fileciteturn51file0L2-L2
- **Recovery-friendly:** the push payload contains a notification ID and the React client can recover from persisted notification history. fileciteturn54file0L2-L2

---

## 10. Weaknesses and limitations

- Requires browser support for the Push API and Service Worker.
- Requires notification permission from the user.
- Requires VAPID configuration for the backend to send pushes.
- Depends on an external browser Push Service.
- Delivery timing and availability are not fully controlled by the application.
- A successful backend send does not prove user-visible delivery.
- A closed tab has no React window client to receive the Service Worker's `postMessage()`; the operating-system/browser notification remains the primary user-visible result. fileciteturn53file0L2-L2
- Browser and OS behavior varies; compatibility must be validated on the target browsers/devices rather than assumed from the server implementation.
- The current backend sends to each active subscription sequentially inside `sendWebPushForNotification()`, so many subscriptions for one recipient are not parallelized. fileciteturn51file0L2-L2

---

## 11. Testing

### Automated backend coverage

The Web Push route/sender tests mock the `web-push` dependency instead of calling a real external Push Service. This keeps unit tests deterministic and avoids coupling test success to third-party network infrastructure.

Important behaviors to test/retain include:

- VAPID public key endpoint with and without configuration.
- Subscription creation.
- Endpoint upsert behavior.
- Unsubscribe.
- Missing required subscription fields → `400`.
- Unknown user → `404`.
- Successful `sendNotification()`.
- VAPID not configured → Web Push skipped without breaking post creation.
- HTTP `404`/`410` → subscription invalidated.
- Invalid subscription is not selected for future sends.

### Browser/manual validation

The following cannot be fully validated by the backend unit tests:

- Real browser permission flow.
- Service Worker registration and lifecycle.
- Real Push API subscription.
- Real Push Service delivery.
- OS-level notification display.
- Behavior while the tab is closed/backgrounded.
- Browser/OS-specific behavior.
- React `postMessage()` recovery after a real push event.

A useful manual test is:

```text
1. Run frontend + backend with valid VAPID credentials.
2. Open the app in a supported browser.
3. Enable Web Push for a user.
4. Confirm /push/subscribe succeeds.
5. Close or background the application tab.
6. Create a post as another user who the subscribed user follows.
7. Observe the OS/browser notification.
8. Reopen the application.
9. Verify notification history contains the notification.
10. If a window was available during the push, verify the Service Worker
    postMessage path triggers recovery in React.
```

The real Push Service should not be a dependency of deterministic unit tests.

---

## 12. Benchmark status

**Status: Not yet a full client end-to-end benchmark.**

Web Push requires a different benchmark model from Polling, SSE, and WebSocket.

The measurable server-side portion is approximately:

```text
notification created
      │
      ▼
Web Push sender starts
      │
      ▼
webpush.sendNotification()
      │
      ▼
Push Service request completes
```

The backend can observe this operation, but it cannot directly observe the complete path:

```text
Push Service
      │
      ▼
Browser
      │
      ▼
Service Worker
      │
      ▼
OS notification / React
```

Therefore the final benchmark/report must **not combine these into one number called “Web Push end-to-end latency.”**

Recommended future measurements are:

| Metric | Observable by backend? | Meaning |
|---|---:|---|
| Web Push send duration | Yes | Time spent in `webpush.sendNotification()` |
| Push Service → browser delay | No | External delivery delay |
| Service Worker receive time | Only with client instrumentation | Browser-side push arrival |
| OS notification display time | No reliable backend measurement | User-visible notification timing |
| React recovery time | With browser instrumentation | Time from push message to application state reconciliation |

---

## 13. Infrastructure requirements

The current implementation requires:

```text
Backend
├── VAPID_PUBLIC_KEY
├── VAPID_PRIVATE_KEY
└── VAPID_SUBJECT

Browser
├── Service Worker support
├── Push API support
└── Notification permission
```

The backend exposes:

```text
GET  /push/vapid-public-key
POST /push/subscribe
POST /push/unsubscribe
```

The VAPID public key is deliberately fetched from the backend rather than duplicated as a hard-coded frontend constant. fileciteturn52file0L2-L2

For hosted environments, Web Push must be tested over HTTPS. Localhost is the normal browser development exception.

---

## 14. Best suited for

- Notifications that should reach users while the application is backgrounded or the tab is closed.
- Low-frequency or event-driven notifications where keeping a persistent SSE/WebSocket connection solely for notifications is unnecessary.
- User alerts where OS/browser notification UI is more useful than an in-app realtime stream.

## 15. Poorly suited for

- High-frequency UI synchronization.
- Realtime collaborative state where the application needs a continuously interactive connection.
- Workloads that require the backend to know with certainty that the user actually saw a notification.
- A benchmark that requires identical client-observable latency semantics across all five transports.

---

## 16. Comparison summary

| Category | Assessment |
|---|---|
| Complexity | High — Service Worker, Push API, VAPID, subscription lifecycle |
| Connection model | No persistent application connection |
| Latency | External Push Service makes complete E2E latency unavailable from backend alone |
| Throughput | Not yet fully benchmarked in the current lab |
| Scalability | Good connection model; actual scaling also depends on persistence and Push Service behavior |
| Reliability | Best-effort; not a guarantee of user-visible delivery |
| Recovery | Strong when combined with persisted notification history + cursor reconciliation |
| Browser support | Browser/OS dependent; validate target environments |
| Infrastructure | VAPID keys + external browser Push Service + HTTPS for hosted deployment |
| Operational complexity | High |
| Best use case | Background/offline-style user notifications |
