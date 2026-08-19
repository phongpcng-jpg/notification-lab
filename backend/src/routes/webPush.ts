import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import { getVapidConfig } from "../domain/webPushSender.js";

interface SubscribeBody {
  userId: number;
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
}

export async function webPushRoutes(app: FastifyInstance) {
  // GET /push/vapid-public-key — frontend cần key này để gọi
  // pushManager.subscribe({applicationServerKey: ...}). Trả null nếu server
  // chưa cấu hình VAPID (chưa chạy `npm run generate-vapid-keys`) — frontend
  // phải xử lý case này thay vì giả định luôn có key.
  app.get("/push/vapid-public-key", async () => {
    const { publicKey } = getVapidConfig();
    return { publicKey: publicKey || null };
  });

  // POST /push/subscribe — upsert theo endpoint (1 endpoint chỉ thuộc về 1
  // user tại 1 thời điểm; đổi user cho cùng endpoint là hợp lệ, ví dụ user
  // khác dùng chung máy/trình duyệt).
  app.post<{ Body: SubscribeBody }>("/push/subscribe", async (req, reply) => {
    const { userId, subscription } = req.body ?? ({} as SubscribeBody);
    if (
      !userId ||
      !subscription?.endpoint ||
      !subscription.keys?.p256dh ||
      !subscription.keys?.auth
    ) {
      return reply.status(400).send({
        error:
          "userId và subscription (endpoint, keys.p256dh, keys.auth) là bắt buộc",
      });
    }

    const db = getDb();
    const userExists = db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);
    if (!userExists) {
      return reply.status(404).send({ error: "user không tồn tại" });
    }

    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, last_seen_at)
       VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         last_seen_at = unixepoch(),
         invalid_at = NULL`
    ).run(userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth);

    return reply.status(201).send({ ok: true });
  });

  // POST /push/unsubscribe { endpoint } — gọi khi user tắt Web Push chủ động
  app.post<{ Body: { endpoint: string } }>(
    "/push/unsubscribe",
    async (req, reply) => {
      const { endpoint } = req.body ?? {};
      if (!endpoint) {
        return reply.status(400).send({ error: "endpoint is required" });
      }
      const db = getDb();
      db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
      return reply.status(204).send();
    }
  );
}
