# Architecture — Phase 1 (Core domain, chưa có transport)

```
React SPA (Vite, :5173)
    │  fetch /api/*  (proxy -> :3000)
    ▼
Fastify API Server (:3000)
    ├── /users     (chọn "vai trò", follow list)
    ├── /follows   (follow/unfollow, không giới hạn)
    ├── /posts     (đăng bài -> tạo Event -> fan-out Notification)
    └── /notifications (REST list/read — chưa realtime)
    │
    ▼
NotificationService (domain, transport-agnostic)
    │
    ▼
SQLite (better-sqlite3, WAL mode)
    users / follows / posts / events / notifications
    / delivery_attempts / connections / push_subscriptions
```

## Ghi chú quan trọng: đây là kiến trúc SIMPLIFIED, không phải production

- **Single Fastify instance, single SQLite file.** Production thật với nhiều
  instance sẽ cần Redis Pub/Sub hoặc message broker để broadcast notification
  giữa các instance (theo đúng phân tích trong research report, mục 2.4). Ở
  quy mô benchmark local hiện tại, single-instance là đủ và cho phép đo đúng
  overhead của từng transport mà không bị nhiễu bởi độ phức tạp multi-instance.
- **NotificationService phát ra sự kiện qua `emit()` nội bộ (in-process),**
  không qua message queue thật. Khi thêm transport ở Phase 2, mỗi transport
  (SSE/WS) sẽ `onNotificationCreated()` để biết khi nào có notification mới
  cho user đang connect, đây là in-memory pub/sub đơn giản — sẽ ghi rõ giới
  hạn này khi phân tích scalability.
- **`delivery_attempts` và `connections`** đã có trong schema từ Phase 1 dù
  chưa dùng, vì transport layer (Phase 2) cần ghi vào các bảng này để benchmark
  đo được delivery semantics và connection lifecycle thật, không suy diễn.

## Data flow: 1 post → N notification

```
User A đăng post
    │
    ▼
POST /posts { authorId: A, script }
    │
    ▼
posts.insert()
    │
    ▼
NotificationService.createPostCreatedEvent(actorId=A, postId)
    │
    ├── events.insert(type='POST_CREATED', actor_id=A, post_id)
    │
    ├── SELECT follower_id FROM follows WHERE followee_id = A
    │
    └── FOR EACH follower → notifications.insert(event_id, recipient_id=follower, status='queued')
    │
    ▼
emit(notificationIds, eventId)  -- Phase 2: transport adapters lắng nghe ở đây
```

Trạng thái `queued` nghĩa là "đã tạo record trong DB", KHÔNG có nghĩa là đã
đẩy tới client. `delivered` chỉ được set khi transport layer thực sự gửi
thành công (xem `notificationService.markDelivered()`), tránh nhầm lẫn
delivery semantics như Rule 18 trong yêu cầu gốc.
