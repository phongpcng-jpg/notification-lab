import type { NotificationView } from "./types.js";

/**
 * Payload gửi cho client qua SSE hoặc WebSocket — cùng 1 shape để frontend
 * dùng chung 1 hàm parse (`toPolledNotification`) cho cả 2 transport.
 *
 * serverSentAtMs được truyền vào ngay trước khi transport bắt đầu ghi payload,
 * giúp benchmark đo riêng phần transport/network delivery mà không cần đồng
 * bộ clock giữa client và server.
 */
export interface ClientNotificationPayload {
  id: number;
  actorId: number;
  actorDisplayName: string;
  postId: number | null;
  scriptPreview: string | null;
  createdAt: number;
  serverSentAtMs: number;
}

export function serializeNotificationForClient(
  row: NotificationView,
  serverSentAtMs = Date.now()
): ClientNotificationPayload {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorDisplayName: row.actor_display_name,
    postId: row.post_id,
    scriptPreview: row.script_preview,
    createdAt: row.created_at,
    serverSentAtMs,
  };
}
