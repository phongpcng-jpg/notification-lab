import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { notificationService } from "../domain/notificationService.js";
import type { NotificationView } from "../domain/types.js";

/**
 * Các route ở đây là REST thuần (không phải cơ chế push/polling thật).
 * Dùng để: xem lịch sử notification, đánh dấu đã đọc.
 * Các endpoint /notifications/poll, /long-poll, /stream, /ws, /push/*
 * sẽ được thêm ở Phase 2 (từng transport riêng).
 */
export async function notificationRoutes(app: FastifyInstance) {
  // GET /notifications?userId=&limit=&after=
  // `after` = notification id, dùng cho recovery/replay (giống Last-Event-ID)
  app.get<{
    Querystring: { userId: string; limit?: string; after?: string };
  }>("/notifications", async (req, reply) => {
    const userId = Number(req.query.userId);
    if (!userId) {
      return reply.status(400).send({ error: "userId is required" });
    }
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const after = req.query.after ? Number(req.query.after) : 0;

    const db = getDb();
    const rows = db
      .prepare(
        `SELECT n.id, n.status, n.created_at,
                e.actor_id, u.display_name AS actor_display_name,
                e.post_id, substr(p.script, 1, 140) AS script_preview
         FROM notifications n
         JOIN events e ON e.id = n.event_id
         JOIN users u ON u.id = e.actor_id
         LEFT JOIN posts p ON p.id = e.post_id
         WHERE n.recipient_id = ? AND n.id > ?
         ORDER BY n.id DESC
         LIMIT ?`
      )
      .all(userId, after, limit) as NotificationView[];

    return { notifications: rows };
  });

  // POST /notifications/:id/read { userId }
  app.post<{ Params: { id: string }; Body: { userId: number } }>(
    "/notifications/:id/read",
    async (req, reply) => {
      const notificationId = Number(req.params.id);
      const { userId } = req.body ?? {};
      if (!userId) {
        return reply.status(400).send({ error: "userId is required" });
      }
      notificationService.markRead(notificationId, userId);
      return reply.status(204).send();
    }
  );
}
