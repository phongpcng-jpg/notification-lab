import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import {
  fetchNotificationsAfter,
  recordDeliveryBatch,
} from "../domain/notificationQueries.js";

/**
 * SHORT POLLING
 * ─────────────
 * Client gọi định kỳ GET /notifications/poll?userId=&after=&limit=
 * Server trả lời NGAY LẬP TỨC (không giữ request mở — khác Long Polling).
 *
 * Delivery semantics: AT-LEAST-ONCE.
 * - Lọc theo `id > after` (cursor do CLIENT tự giữ), KHÔNG lọc theo `status`.
 *   Lý do: nếu lọc theo status='queued' và server đã set 'delivered' ngay khi
 *   trả response, nhưng client bị rớt mạng/crash TRƯỚC khi xử lý xong response,
 *   notification đó sẽ biến mất vĩnh viễn khỏi client (mất dữ liệu — không chấp
 *   nhận được). Dùng cursor để client tự quyết định khi nào "coi như đã nhận",
 *   giống pattern offset của Kafka.
 * - Vì vậy, nếu client polling lại với `after` cũ (do lỗi/retry), server sẽ
 *   trả lại đúng những notification đó lần nữa → CLIENT PHẢI TỰ DEDUPE theo id.
 * - `status`/`delivered_at`/`delivery_attempts` trong DB chỉ dùng để QUAN SÁT
 *   (observability/benchmark), không dùng làm nguồn sự thật cho việc "đã gửi
 *   cho ai chưa" — nguồn sự thật là cursor phía client.
 */
export async function shortPollingRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { userId: string; after?: string; limit?: string };
  }>("/notifications/poll", async (req, reply) => {
    const requestReceivedAt = Date.now();
    const userId = Number(req.query.userId);
    if (!userId) {
      return reply.status(400).send({ error: "userId is required" });
    }
    const after = Number(req.query.after ?? 0);
    const limit = Math.min(Number(req.query.limit ?? 50), 200);

    const rows = fetchNotificationsAfter(userId, after, limit);
    recordDeliveryBatch(rows, "short_polling", requestReceivedAt);

    const nextAfter = rows.length > 0 ? rows[rows.length - 1].id : after;

    return reply.send({
      notifications: rows,
      nextAfter,
      suggestedIntervalMs: config.shortPollSuggestedIntervalMs,
      serverTime: requestReceivedAt,
    });
  });
}
