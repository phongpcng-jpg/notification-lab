import { getDb } from "../db/index.js";
import { notificationService } from "./notificationService.js";
import type { NotificationView, Transport } from "./types.js";

/**
 * Lấy các notification có id > after cho 1 recipient — dùng chung cho
 * Short Polling và Long Polling (cùng 1 cursor semantics: at-least-once).
 */
export function fetchNotificationsAfter(
  recipientId: number,
  after: number,
  limit: number
): NotificationView[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT n.id, n.status, n.created_at,
              e.actor_id, u.display_name AS actor_display_name,
              e.post_id, substr(p.script, 1, 140) AS script_preview
       FROM notifications n
       JOIN events e ON e.id = n.event_id
       JOIN users u ON u.id = e.actor_id
       LEFT JOIN posts p ON p.id = e.post_id
       WHERE n.recipient_id = ? AND n.id > ?
       ORDER BY n.id ASC
       LIMIT ?`
    )
    .all(recipientId, after, limit) as NotificationView[];
}

/**
 * Lấy notification theo danh sách id cụ thể (kèm recipient_id) — dùng khi
 * transport layer (SSE) cần biết CHÍNH XÁC ai là người nhận của từng
 * notification vừa fan-out, để publish đúng người qua SseHub.
 */
export function fetchNotificationsByIds(
  ids: number[]
): (NotificationView & { recipient_id: number })[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT n.id, n.status, n.created_at, n.recipient_id,
              e.actor_id, u.display_name AS actor_display_name,
              e.post_id, substr(p.script, 1, 140) AS script_preview
       FROM notifications n
       JOIN events e ON e.id = n.event_id
       JOIN users u ON u.id = e.actor_id
       LEFT JOIN posts p ON p.id = e.post_id
       WHERE n.id IN (${placeholders})`
    )
    .all(...ids) as (NotificationView & { recipient_id: number })[];
}

/**
 * Đánh dấu delivered + ghi delivery_attempt cho 1 batch notification vừa
 * trả về client qua 1 transport cụ thể. `baseTimeMs` = thời điểm request tới
 * server (Date.now()), dùng để tính latency = server nhận request - lúc
 * notification được tạo (KHÔNG phải lúc client thực sự nhận — đó là giới hạn
 * đã biết, ghi trong transport report: latency đo được là "server-side send
 * latency", không phải end-to-end thật vì server không có ACK từ client).
 */
export function recordDeliveryBatch(
  rows: NotificationView[],
  transport: Transport,
  baseTimeMs: number
): void {
  for (const n of rows) {
    const latencyMs = baseTimeMs - n.created_at * 1000;
    notificationService.markDelivered(n.id);
    notificationService.recordDeliveryAttempt({
      notificationId: n.id,
      transport,
      result: "success",
      latencyMs,
    });
  }
}
