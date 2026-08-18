import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { notificationService } from "../domain/notificationService.js";
import type { Post } from "../domain/types.js";

export async function postRoutes(app: FastifyInstance) {
  // GET /posts — feed chung (mới nhất trước), phục vụ hiển thị/demo
  app.get<{ Querystring: { limit?: string } }>("/posts", async (req) => {
    const db = getDb();
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const posts = db
      .prepare(
        `SELECT p.id, p.author_id, p.script, p.posted_at, u.display_name AS author_name
         FROM posts p JOIN users u ON u.id = p.author_id
         ORDER BY p.posted_at DESC LIMIT ?`
      )
      .all(limit);
    return { posts };
  });

  // POST /posts { authorId, script }
  // -> tạo post -> tạo Event POST_CREATED -> fan-out Notification cho follower
  // Đây là nơi duy nhất business logic "notification phát sinh từ event nào" chạy.
  app.post<{ Body: { authorId: number; script: string } }>(
    "/posts",
    async (req, reply) => {
      const { authorId, script } = req.body ?? {};
      if (!authorId || !script || !script.trim()) {
        return reply
          .status(400)
          .send({ error: "authorId and script are required" });
      }

      const db = getDb();
      const userExists = db
        .prepare("SELECT 1 FROM users WHERE id = ?")
        .get(authorId);
      if (!userExists) {
        return reply.status(404).send({ error: "author không tồn tại" });
      }

      const info = db
        .prepare(
          "INSERT INTO posts (author_id, script, posted_at) VALUES (?, ?, unixepoch())"
        )
        .run(authorId, script.trim());
      const postId = Number(info.lastInsertRowid);
      const post = db
        .prepare("SELECT id, author_id, script, posted_at FROM posts WHERE id = ?")
        .get(postId) as Post;

      // Fan-out: tạo Event + Notification cho từng follower.
      // Việc "đẩy" thật sự tới client (SSE/WS/Push/...) do transport adapter
      // đăng ký lắng nghe notificationService xử lý (Phase 2), không ở đây.
      const { eventId, notificationIds, recipientIds } =
        notificationService.createPostCreatedEvent({
          actorId: authorId,
          postId,
        });

      return reply.status(201).send({
        post,
        eventId,
        notificationCount: notificationIds.length,
        recipientIds,
      });
    }
  );
}
