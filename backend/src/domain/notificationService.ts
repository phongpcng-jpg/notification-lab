import type Database from "better-sqlite3";
import { getDb } from "../db/index.js";
import type { DomainEvent, EventType } from "./types.js";

/**
 * NotificationService — KHÔNG biết gì về transport (SSE/WS/Polling/Push).
 * Nó chỉ chịu trách nhiệm: nhận business event -> fan-out ra Notification rows.
 * Việc "đẩy" notification tới client cụ thể qua transport nào là việc của
 * từng TransportAdapter (sẽ implement ở Phase 2), đăng ký lắng nghe qua
 * onNotificationCreated().
 */

type Listener = (
  notificationIds: number[],
  eventId: number,
  recipientIds: number[]
) => void;

class NotificationService {
  private listeners: Listener[] = [];

  onNotificationCreated(fn: Listener): void {
    this.listeners.push(fn);
  }

  private emit(
    notificationIds: number[],
    eventId: number,
    recipientIds: number[]
  ): void {
    for (const fn of this.listeners) {
      try {
        fn(notificationIds, eventId, recipientIds);
      } catch (err) {
        // Một listener lỗi không được làm hỏng luồng tạo notification.
        console.error("[NotificationService] listener error:", err);
      }
    }
  }

  /**
   * Tạo 1 Event + fan-out Notification cho toàn bộ follower của actor.
   * Trả về { eventId, notificationIds } để caller (route) có thể trả response,
   * và để transport layer biết cần push cho ai.
   */
  createPostCreatedEvent(params: {
    actorId: number;
    postId: number;
  }): { eventId: number; notificationIds: number[]; recipientIds: number[] } {
    const db = getDb();

    const insertEvent = db.prepare(
      `INSERT INTO events (type, actor_id, post_id) VALUES (?, ?, ?)`
    );
    const selectFollowers = db.prepare(
      `SELECT follower_id FROM follows WHERE followee_id = ?`
    );
    const insertNotification = db.prepare(
      `INSERT INTO notifications (event_id, recipient_id, status) VALUES (?, ?, 'queued')`
    );

    const tx = db.transaction(() => {
      const eventType: EventType = "POST_CREATED";
      const eventInfo = insertEvent.run(eventType, params.actorId, params.postId);
      const eventId = Number(eventInfo.lastInsertRowid);

      const followers = selectFollowers.all(params.actorId) as {
        follower_id: number;
      }[];

      const notificationIds: number[] = [];
      const recipientIds: number[] = [];
      for (const f of followers) {
        const info = insertNotification.run(eventId, f.follower_id);
        notificationIds.push(Number(info.lastInsertRowid));
        recipientIds.push(f.follower_id);
      }

      return { eventId, notificationIds, recipientIds };
    });

    const result = tx();
    this.emit(result.notificationIds, result.eventId, result.recipientIds);
    return result;
  }

  markDelivered(notificationId: number): void {
    const db = getDb();
    db.prepare(
      `UPDATE notifications SET status = 'delivered', delivered_at = unixepoch()
       WHERE id = ? AND status = 'queued'`
    ).run(notificationId);
  }

  markRead(notificationId: number, recipientId: number): void {
    const db = getDb();
    db.prepare(
      `UPDATE notifications SET status = 'read', read_at = unixepoch()
       WHERE id = ? AND recipient_id = ?`
    ).run(notificationId, recipientId);
  }

  /**
   * Đánh dấu 'acknowledged' — chỉ có ý nghĩa với transport 2 chiều thật sự
   * (hiện tại: WebSocket), vì cần client chủ động gửi ngược lại 1 message
   * xác nhận đã nhận. Short/Long Polling/SSE không có kênh client->server
   * trên cùng kết nối nên không thể "ack" theo nghĩa này (chỉ có REST
   * /notifications/:id/read riêng, đánh dấu 'read' chứ không phải 'acknowledged').
   */
  markAcknowledged(notificationId: number, recipientId: number): void {
    const db = getDb();
    db.prepare(
      `UPDATE notifications SET status = 'acknowledged'
       WHERE id = ? AND recipient_id = ? AND status IN ('queued', 'delivered')`
    ).run(notificationId, recipientId);
  }

  recordDeliveryAttempt(params: {
    notificationId: number;
    transport: string;
    result: "success" | "failed" | "timeout";
    latencyMs?: number;
    errorReason?: string;
  }): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO delivery_attempts
        (notification_id, transport, result, latency_ms, error_reason)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      params.notificationId,
      params.transport,
      params.result,
      params.latencyMs ?? null,
      params.errorReason ?? null
    );
  }
}

export const notificationService = new NotificationService();
