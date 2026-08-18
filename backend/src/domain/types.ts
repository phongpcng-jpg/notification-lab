// Domain types — phản ánh đúng bảng trong schema.sql.
// Không gộp Event/Notification/Delivery/Connection thành 1 type.

export type Transport =
  | "short_polling"
  | "long_polling"
  | "sse"
  | "websocket"
  | "web_push";

export type ConnectionTransport = Exclude<Transport, "web_push">;

export interface User {
  id: number;
  display_name: string;
  created_at: number;
}

export interface Follow {
  follower_id: number;
  followee_id: number;
  created_at: number;
}

export interface Post {
  id: number;
  author_id: number;
  script: string;
  posted_at: number;
}

export type EventType = "POST_CREATED";

export interface DomainEvent {
  id: number;
  type: EventType;
  actor_id: number;
  post_id: number | null;
  created_at: number;
}

export type NotificationStatus =
  | "queued"
  | "delivered"
  | "acknowledged"
  | "read"
  | "failed";

export interface Notification {
  id: number;
  event_id: number;
  recipient_id: number;
  status: NotificationStatus;
  created_at: number;
  delivered_at: number | null;
  read_at: number | null;
}

// Notification kèm theo thông tin hiển thị (join với events/posts/users)
// — dùng cho response API, KHÔNG phải bảng DB.
export interface NotificationView {
  id: number;
  status: NotificationStatus;
  created_at: number;
  actor_id: number;
  actor_display_name: string;
  post_id: number | null;
  script_preview: string | null;
}

export interface DeliveryAttempt {
  id: number;
  notification_id: number;
  transport: Transport;
  attempted_at: number;
  result: "success" | "failed" | "timeout";
  latency_ms: number | null;
  error_reason: string | null;
}

export interface ConnectionRecord {
  id: number;
  user_id: number;
  transport: ConnectionTransport;
  connected_at: number;
  disconnected_at: number | null;
  disconnect_reason: string | null;
}

export interface PushSubscriptionRecord {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
  last_seen_at: number | null;
  invalid_at: number | null;
}
