import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import {
  fetchNotificationsAfter,
  recordDeliveryBatch,
} from "../domain/notificationQueries.js";
import { notificationWaiters } from "../domain/notificationWaiters.js";
import { openConnection, closeConnection } from "../domain/connectionTracker.js";

/**
 * LONG POLLING
 * ────────────
 * Client gửi GET /notifications/long-poll?userId=&after=&limit=.
 * - Nếu đã có notification mới (id > after) ngay lúc nhận request → trả về
 *   NGAY, không chờ (giống short polling).
 * - Nếu chưa có gì → GIỮ request mở, đăng ký chờ qua `notificationWaiters`,
 *   tới khi: (a) có notification mới cho user này, (b) hết timeout server
 *   (`LONG_POLL_TIMEOUT_MS`), hoặc (c) client tự ngắt kết nối.
 *
 * Delivery semantics: giống Short Polling — AT-LEAST-ONCE, cursor-based.
 *
 * Giới hạn đã biết (ghi rõ, không giấu):
 * - notificationWaiters là in-process — không hoạt động qua nhiều instance
 *   (xem comment trong notificationWaiters.ts).
 * - Nếu server restart giữa lúc đang giữ request, client sẽ nhận connection
 *   reset — client phải tự reconnect (không có gì đặc biệt cần server làm
 *   thêm ở đây, vì HTTP là stateless per-request).
 */
export async function longPollingRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { userId: string; after?: string; limit?: string };
  }>("/notifications/long-poll", async (req, reply) => {
    const userId = Number(req.query.userId);
    if (!userId) {
      return reply.status(400).send({ error: "userId is required" });
    }
    const after = Number(req.query.after ?? 0);
    const limit = Math.min(Number(req.query.limit ?? 50), 200);

    // 1) Có sẵn dữ liệu ngay? Trả lời ngay lập tức, không cần giữ connection.
    const immediateRows = fetchNotificationsAfter(userId, after, limit);
    if (immediateRows.length > 0) {
      const now = Date.now();
      recordDeliveryBatch(immediateRows, "long_polling", now);
      return reply.send({
        notifications: immediateRows,
        nextAfter: immediateRows[immediateRows.length - 1].id,
        timedOut: false,
        serverTime: now,
      });
    }

    // 2) Chưa có gì — giữ request mở, đăng ký connection + waiter.
    const connectionId = openConnection(userId, "long_polling");
    const { promise, cancel } = notificationWaiters.waitFor(userId);

    let settledReason: "data" | "timeout" | "client_disconnect" | null = null;

    const timeoutHandle = setTimeout(() => {
      if (settledReason === null) settledReason = "timeout";
    }, config.longPollTimeoutMs);

    const onClientClose = () => {
      if (settledReason === null) settledReason = "client_disconnect";
    };
    req.raw.on("close", onClientClose);

    // Race giữa "có notification" và "hết timeout". Poll interval nhỏ (25ms)
    // để phát hiện timeout/disconnect đã xảy ra trong lúc await promise gốc
    // — cách đơn giản hơn dùng thêm 1 Promise.race lồng nhau, đủ chính xác
    // cho benchmark (sai số tối đa ~25ms, chấp nhận được so với timeout hàng
    // chục giây).
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        const check = () => {
          if (settledReason !== null) return resolve();
          setTimeout(check, 25);
        };
        check();
      }),
    ]);

    clearTimeout(timeoutHandle);
    cancel();
    req.raw.off("close", onClientClose);

    if (settledReason === "client_disconnect") {
      closeConnection(connectionId, "client_disconnect");
      // Không thể (và không nên) gọi reply.send() nữa — client đã đóng kết nối.
      return;
    }

    // Dù được đánh thức bởi "data" hay chạm "timeout", đều re-query DB để lấy
    // đúng dữ liệu hiện tại (tránh phụ thuộc vào payload của waiter — đơn giản
    // và luôn nhất quán với nguồn sự thật là DB).
    const rows = fetchNotificationsAfter(userId, after, limit);
    const now = Date.now();

    if (rows.length > 0) {
      recordDeliveryBatch(rows, "long_polling", now);
      closeConnection(connectionId, "data_delivered");
      return reply.send({
        notifications: rows,
        nextAfter: rows[rows.length - 1].id,
        timedOut: false,
        serverTime: now,
      });
    }

    // Timeout thật sự xảy ra trước khi có data (race hiếm: notify() bắn ra
    // đúng lúc timeout, nhưng khi re-query lại không thấy gì — an toàn vì
    // client vẫn giữ nguyên cursor, sẽ thấy ở lần long-poll kế tiếp).
    closeConnection(connectionId, "timeout");
    return reply.send({
      notifications: [],
      nextAfter: after,
      timedOut: true,
      serverTime: now,
    });
  });
}
