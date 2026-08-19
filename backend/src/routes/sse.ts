import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import {
  fetchNotificationsAfter,
  recordDeliveryBatch,
} from "../domain/notificationQueries.js";
import { sseHub, type SseSubscription } from "../domain/sseHub.js";
import { openConnection, closeConnection } from "../domain/connectionTracker.js";
import { serializeNotificationForClient } from "../domain/notificationSerialization.js";
import type { NotificationView } from "../domain/types.js";

/**
 * SERVER-SENT EVENTS
 * ──────────────────
 * GET /notifications/stream?userId=&lastEventId=
 * (EventSource tự gửi header `Last-Event-ID` khi reconnect sau khi mất kết
 * nối — route đọc cả header lẫn query param để hỗ trợ test thủ công bằng
 * curl, ưu tiên header nếu có cả hai.)
 *
 * Luồng:
 * 1. Catch-up: gửi ngay các notification đã bỏ lỡ (id > lastEventId) —
 *    KHÔNG chờ, tận dụng đúng cơ chế recovery chuẩn của EventSource.
 * 2. Đăng ký nhận notification MỚI qua SseHub — sống suốt vòng đời kết nối.
 * 3. Heartbeat định kỳ (dòng comment `: ping`) để tránh bị proxy trung gian
 *    buffer/timeout kết nối (đúng vấn đề đã ghi trong research report 2.3).
 * 4. Cleanup khi client đóng kết nối: hủy subscription, đóng heartbeat timer,
 *    ghi nhận vào bảng `connections`.
 *
 * Header quan trọng: `X-Accel-Buffering: no` — tắt buffer ở Nginx (nếu có),
 * nếu không đặt thì client có thể không nhận được event nào cho tới khi
 * buffer đầy hoặc kết nối đóng (đúng vấn đề đã ghi trong research report).
 */
export async function sseRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { userId: string; lastEventId?: string } }>(
    "/notifications/stream",
    async (req, reply) => {
      const userId = Number(req.query.userId);
      if (!userId) {
        return reply.status(400).send({ error: "userId is required" });
      }

      const lastEventIdHeader = req.headers["last-event-id"];
      const headerValue = Array.isArray(lastEventIdHeader)
        ? lastEventIdHeader[0]
        : lastEventIdHeader;
      const after = Number(headerValue ?? req.query.lastEventId ?? 0);

      // Báo cho Fastify biết: từ giờ TỰ QUẢN LÝ reply.raw, Fastify không
      // được tự ý gửi response nữa (tránh lỗi "double send").
      reply.hijack();

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": config.corsOrigin,
      });
      // Flush header ngay để client biết kết nối đã mở (một số proxy giữ
      // header lại nếu chưa có byte nào được gửi).
      reply.raw.write(": connected\n\n");

      const connectionId = openConnection(userId, "sse");

      function sendEvent(row: NotificationView): void {
        const payload = JSON.stringify(serializeNotificationForClient(row));
        reply.raw.write(`id: ${row.id}\n`);
        reply.raw.write(`event: notification\n`);
        reply.raw.write(`data: ${payload}\n\n`);
      }

      // 1) Catch-up
      const missed = fetchNotificationsAfter(userId, after, 200);
      if (missed.length > 0) {
        const now = Date.now();
        for (const row of missed) sendEvent(row);
        recordDeliveryBatch(missed, "sse", now);
      }

      // 2) Live subscription
      const subscription: SseSubscription = {
        onNotification: (row) => {
          sendEvent(row);
          recordDeliveryBatch([row], "sse", Date.now());
        },
        forceClose: () => {
          if (!reply.raw.writableEnded) reply.raw.end();
        },
      };
      const unsubscribe = sseHub.subscribe(userId, subscription);

      // 3) Heartbeat — dòng bắt đầu bằng ':' là comment theo spec SSE,
      // EventSource bỏ qua, chỉ dùng để giữ kết nối "sống" qua proxy.
      const heartbeatTimer = setInterval(() => {
        if (reply.raw.writableEnded) return;
        reply.raw.write(": ping\n\n");
      }, config.sseHeartbeatMs);

      // 4) Cleanup
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeatTimer);
        unsubscribe();
        closeConnection(connectionId, "client_disconnect");
      };
      req.raw.on("close", cleanup);
      req.raw.on("error", cleanup);
    }
  );
}
