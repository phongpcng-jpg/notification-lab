-- Notification Realtime Lab — SQLite schema
-- Thiết kế tách rõ: Event / Notification / Delivery Attempt / Connection
-- (không gộp chung thành 1 bảng, theo yêu cầu domain model trong system prompt)

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL; -- tốt hơn cho workload đọc/ghi đồng thời (benchmark)

-- ─────────────────────────────────────────────
-- USERS
-- Không có auth thật: user "đăng nhập" bằng cách chọn 1 id có sẵn ở frontend.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name  TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ─────────────────────────────────────────────
-- FOLLOWS
-- Không giới hạn, không ràng buộc gì ngoài: không tự follow chính mình,
-- không follow trùng (unique).
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS follows (
  follower_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);

-- ─────────────────────────────────────────────
-- POSTS
-- Nội dung chỉ gồm "script" (text) + thời gian đăng. Không title, không field khác.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  script      TEXT NOT NULL,
  posted_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_posted_at ON posts(posted_at);

-- ─────────────────────────────────────────────
-- EVENTS
-- Sự kiện nghiệp vụ thô — nguồn gốc để sinh ra Notification.
-- Tách khỏi Notification vì 1 event có thể fan-out ra N notification (N follower).
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,              -- 'POST_CREATED' (mở rộng sau nếu cần)
  actor_id    INTEGER NOT NULL REFERENCES users(id),
  post_id     INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

-- ─────────────────────────────────────────────
-- NOTIFICATIONS
-- 1 dòng / 1 recipient / 1 event. status phản ánh delivery semantics thực tế,
-- không phải "delivered" chỉ vì server đã cố gửi bytes.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  recipient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','delivered','acknowledged','read','failed')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  delivered_at  INTEGER,
  read_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications(recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_status
  ON notifications(recipient_id, status);

-- ─────────────────────────────────────────────
-- DELIVERY ATTEMPTS
-- Mỗi lần server *cố* đưa 1 notification tới client qua 1 transport cụ thể.
-- Dùng để đo delivery semantics (at-least-once, duplicate, failed...) trong benchmark.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id   INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  transport         TEXT NOT NULL
                       CHECK (transport IN ('short_polling','long_polling','sse','websocket','web_push')),
  attempted_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  result            TEXT NOT NULL CHECK (result IN ('success','failed','timeout')),
  latency_ms        INTEGER,             -- thời gian từ event tạo -> attempt này (nếu đo được)
  error_reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_notification
  ON delivery_attempts(notification_id);

-- ─────────────────────────────────────────────
-- CONNECTIONS
-- Lifecycle của 1 kết nối realtime (SSE/WebSocket) hoặc 1 phiên long-polling.
-- Dùng cho benchmark connection-scalability/reconnect scenarios.
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connections (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transport         TEXT NOT NULL
                       CHECK (transport IN ('short_polling','long_polling','sse','websocket')),
  connected_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  disconnected_at   INTEGER,
  disconnect_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_connections_user ON connections(user_id);

-- ─────────────────────────────────────────────
-- PUSH SUBSCRIPTIONS (riêng cho Web Push — khác bản chất với connections ở trên)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at  INTEGER,
  invalid_at    INTEGER            -- set khi push service trả 404/410
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
