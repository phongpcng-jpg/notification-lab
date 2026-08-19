import type { PolledNotification } from "./types.js";

export interface ClientNotificationPayload {
  id: number;
  actorId: number;
  actorDisplayName: string;
  postId: number | null;
  scriptPreview: string | null;
  createdAt: number;
}

/**
 * Chuyển payload server gửi qua SSE/WebSocket (camelCase, gọn) thành
 * `PolledNotification` (cùng shape với Short/Long Polling) để UI dùng
 * chung 1 component hiển thị cho mọi transport.
 */
export function toPolledNotification(
  e: ClientNotificationPayload,
  status: PolledNotification["status"] = "delivered"
): PolledNotification {
  return {
    id: e.id,
    status,
    created_at: e.createdAt,
    actor_id: e.actorId,
    actor_display_name: e.actorDisplayName,
    post_id: e.postId,
    script_preview: e.scriptPreview,
  };
}
