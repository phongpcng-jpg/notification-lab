import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { notificationService } from "../domain/notificationService.js";
import { addHotPathSpan, startHotPathTrace, setTraceNotificationIds } from "../domain/performanceInstrumentation.js";
import type { Post } from "../domain/types.js";

export async function postRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string } }>("/posts", async (req) => {
    const db = getDb();
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const posts = db.prepare(`SELECT p.id, p.author_id, p.script, p.posted_at, u.display_name AS author_name FROM posts p JOIN users u ON u.id = p.author_id ORDER BY p.posted_at DESC LIMIT ?`).all(limit);
    return { posts };
  });

  app.post<{ Body: { authorId: number; script: string } }>("/posts", async (req, reply) => {
    const requestStart = performance.now();
    const trace = startHotPathTrace();
    const { authorId, script } = req.body ?? {};
    if (!authorId || !script || !script.trim()) return reply.status(400).send({ error: "authorId and script are required" });

    const db = getDb();
    const validationStart = performance.now();
    const userExists = db.prepare("SELECT 1 FROM users WHERE id = ?").get(authorId);
    addHotPathSpan(trace, "createPost.validate_author_db", validationStart, performance.now());
    if (!userExists) return reply.status(404).send({ error: "author không tồn tại" });

    const insertStart = performance.now();
    const info = db.prepare("INSERT INTO posts (author_id, script, posted_at) VALUES (?, ?, unixepoch())").run(authorId, script.trim());
    const postId = Number(info.lastInsertRowid);
    const post = db.prepare("SELECT id, author_id, script, posted_at FROM posts WHERE id = ?").get(postId) as Post;
    addHotPathSpan(trace, "createPost.post_db_insert_and_read", insertStart, performance.now(), { postId });

    const fanoutStart = performance.now();
    const { eventId, notificationIds, recipientIds } = notificationService.createPostCreatedEvent({ actorId: authorId, postId, trace });
    addHotPathSpan(trace, "createPost.fanout_total", fanoutStart, performance.now(), { notificationCount: notificationIds.length, eventId });
    setTraceNotificationIds(trace, notificationIds);

    const responseStart = performance.now();
    const response = { post, eventId, notificationIds, notificationCount: notificationIds.length, recipientIds, traceId: trace.traceId };
    addHotPathSpan(trace, "createPost.response_build", responseStart, performance.now());
    addHotPathSpan(trace, "createPost.total", requestStart, performance.now(), { notificationCount: notificationIds.length });
    return reply.status(201).send(response);
  });
}
