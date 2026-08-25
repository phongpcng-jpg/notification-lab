import { getDb } from "../db/index.js";
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
 * Lấy notification theo danh sách id cụ thể — dùng sau khi fan-out transaction
 * đã commit, để transport layer luôn publish state thực tế đang có trong DB.
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
 * Đánh dấu delivered + ghi delivery_attempt cho một batch trong DUY NHẤT
 * transaction. better-sqlite3 là synchronous, vì vậy tránh UPDATE + INSERT
 * riêng lẻ cho từng notification trên hot path.
 */
export function recordDeliveryBatch(
  rows: NotificationView[],
  transport: Transport,
  baseTimeMs: number
): void {
  if (rows.length === 0) return;

  const db = getDb();
  const markDelivered = db.prepare(
    `UPDATE notifications
     SET status = 'delivered', delivered_at = unixepoch()
     WHERE id = ? AND status = 'queued'`
  );
  const recordAttempt = db.prepare(
    `INSERT INTO delivery_attempts
      (notification_id, transport, result, latency_ms, error_reason)
     VALUES (?, ?, 'success', ?, NULL)`
  );

  const writeBatch = db.transaction(() => {
    for (const row of rows) {
      const latencyMs = Math.max(0, baseTimeMs - row.created_at * 1000);
      markDelivered.run(row.id);
      recordAttempt.run(row.id, transport, latencyMs);
    }
  });

  writeBatch();
}

export interface AcknowledgedDelivery {
  notificationId: number;
  recipientId: number;
  latencyMs: number;
}

/**
 * WebSocket ACK instrumentation. ACKs được gom thành một transaction để
 * tránh một UPDATE + INSERT synchronous cho mỗi frame WebSocket.
 * `latencyMs` được tính từ notification.created_at tới lúc server nhận ACK.
 */
export function recordAcknowledgedBatch(items: AcknowledgedDelivery[]): void {
  if (items.length === 0) return;

  const db = getDb();
  const markAcknowledged = db.prepare(
    `UPDATE notifications
     SET status = 'acknowledged'
     WHERE id = ? AND recipient_id = ?
       AND status IN ('queued', 'delivered')`
  );
  const recordAttempt = db.prepare(
    `INSERT INTO delivery_attempts
      (notification_id, transport, result, latency_ms, error_reason)
     VALUES (?, 'websocket', 'success', ?, NULL)`
  );

  const writeBatch = db.transaction(() => {
    for (const item of items) {
      markAcknowledged.run(item.notificationId, item.recipientId);
      recordAttempt.run(item.notificationId, Math.max(0, item.latencyMs));
    }
  });

  writeBatch();
}

export interface DeliveryAttemptView {
  notificationId: number;
  transport: Transport;
  result: "success" | "failed" | "timeout";
  latencyMs: number | null;
}

/**
 * Đọc delivery_attempts phục vụ benchmark. Đây là server-side delivery / ACK
 * latency, KHÔNG phải local browser render latency.
 */
export function fetchDeliveryAttemptsByNotificationIds(
  ids: number[]
): DeliveryAttemptView[] {
  if (ids.length === 0) return [];

  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");

  return db
    .prepare(
      `SELECT
         notification_id AS notificationId,
         transport,
         result,
         latency_ms AS latencyMs
       FROM delivery_attempts
       WHERE notification_id IN (${placeholders})
       ORDER BY id ASC`
    )
    .all(...ids) as DeliveryAttemptView[];
}
