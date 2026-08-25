import { getDb } from "../db/index.js";
import type { DomainEvent, EventType } from "./types.js";

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

  private emit(notificationIds: number[], eventId: number, recipientIds: number[]): void {
    for (const fn of this.listeners) {
      try {
        fn(notificationIds, eventId, recipientIds);
      } catch (err) {
        console.error("[NotificationService] listener error:", err);
      }
    }
  }

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
      const followers = selectFollowers.all(params.actorId) as { follower_id: number }[];
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
    // Important: emit only AFTER the SQLite transaction commits. Transport
    // listeners may re-query these ids and must never observe uncommitted rows.
    this.emit(result.notificationIds, result.eventId, result.recipientIds);
    return result;
  }

  markDelivered(notificationId: number): void {
    getDb()
      .prepare(
        `UPDATE notifications SET status = 'delivered', delivered_at = unixepoch()
         WHERE id = ? AND status = 'queued'`
      )
      .run(notificationId);
  }

  markRead(notificationId: number, recipientId: number): void {
    getDb()
      .prepare(
        `UPDATE notifications SET status = 'read', read_at = unixepoch()
         WHERE id = ? AND recipient_id = ?`
      )
      .run(notificationId, recipientId);
  }

  markAcknowledged(notificationId: number, recipientId: number): void {
    getDb()
      .prepare(
        `UPDATE notifications SET status = 'acknowledged'
         WHERE id = ? AND recipient_id = ? AND status IN ('queued', 'delivered')`
      )
      .run(notificationId, recipientId);
  }

  recordDeliveryAttempt(params: {
    notificationId: number;
    transport: string;
    result: "success" | "failed" | "timeout";
    latencyMs?: number;
    errorReason?: string;
  }): void {
    getDb()
      .prepare(
        `INSERT INTO delivery_attempts
          (notification_id, transport, result, latency_ms, error_reason)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        params.notificationId,
        params.transport,
        params.result,
        params.latencyMs ?? null,
        params.errorReason ?? null
      );
  }
}

export const notificationService = new NotificationService();
