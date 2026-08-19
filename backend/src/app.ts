import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocketPlugin from "@fastify/websocket";
import { config } from "./config.js";
import { userRoutes } from "./routes/users.js";
import { followRoutes } from "./routes/follows.js";
import { postRoutes } from "./routes/posts.js";
import { notificationRoutes } from "./routes/notifications.js";
import { shortPollingRoutes } from "./routes/shortPolling.js";
import { longPollingRoutes } from "./routes/longPolling.js";
import { sseRoutes } from "./routes/sse.js";
import { websocketRoutes } from "./routes/websocket.js";
import { webPushRoutes } from "./routes/webPush.js";
import { sendWebPushForNotification } from "./domain/webPushSender.js";
import { notificationService } from "./domain/notificationService.js";
import { notificationWaiters } from "./domain/notificationWaiters.js";
import { sseHub } from "./domain/sseHub.js";
import { wsHub } from "./domain/wsHub.js";
import { fetchNotificationsByIds } from "./domain/notificationQueries.js";

// notificationService là singleton dùng chung toàn process. buildApp() có thể
// được gọi nhiều lần (mỗi test 1 lần) — guard này tránh đăng ký listener
// trùng lặp nhiều lần lên cùng 1 service instance.
let transportsWired = false;
function wireTransportsToNotificationService(): void {
  if (transportsWired) return;
  transportsWired = true;
  notificationService.onNotificationCreated((notificationIds, _eventId, recipientIds) => {
    // Long Polling: chỉ cần đánh thức, request tự re-query DB.
    for (const recipientId of recipientIds) {
      notificationWaiters.notify(recipientId);
    }
    // SSE + WebSocket: cần đúng nội dung row để push trực tiếp qua kết nối
    // đang mở, không có chuyện "request tự re-query" như long polling.
    const rows = fetchNotificationsByIds(notificationIds);
    for (const row of rows) {
      sseHub.publish(row.recipient_id, row);
      wsHub.publish(row.recipient_id, row);
      // Web Push: fire-and-forget có chủ đích — gửi qua Push Service bên thứ
      // 3 có thể chậm/lỗi, KHÔNG được block luồng tạo notification chính.
      // Lỗi (nếu có) đã được xử lý bên trong sendWebPushForNotification()
      // (ghi delivery_attempts, đánh dấu subscription hết hạn...), .catch()
      // ở đây chỉ là lưới an toàn cuối cùng cho lỗi không lường trước.
      void sendWebPushForNotification(row).catch((err) => {
        console.error("[webPush] Lỗi không lường trước khi gửi:", err);
      });
    }
  });
}

/**
 * buildApp() tách khỏi server.ts (vốn còn gọi app.listen() + xử lý signal)
 * để test integration có thể dùng app.inject() — không mở port thật,
 * không cần networking, chạy nhanh và không xung đột port giữa các test.
 */
export async function buildApp(): Promise<FastifyInstance> {
  wireTransportsToNotificationService();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  await app.register(cors, {
    origin: config.corsOrigin,
  });
  await app.register(websocketPlugin);

  app.get("/health", async () => ({
    status: "ok",
    time: new Date().toISOString(),
  }));

  await app.register(userRoutes);
  await app.register(followRoutes);
  await app.register(postRoutes);
  await app.register(notificationRoutes);
  await app.register(shortPollingRoutes);
  await app.register(longPollingRoutes);
  await app.register(sseRoutes);
  await app.register(websocketRoutes);
  await app.register(webPushRoutes);

  return app;
}
