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
import { benchmarkRoutes } from "./routes/benchmark.js";
import { sendWebPushForNotification } from "./domain/webPushSender.js";
import { notificationService } from "./domain/notificationService.js";
import { notificationWaiters } from "./domain/notificationWaiters.js";
import { sseHub } from "./domain/sseHub.js";
import { wsHub } from "./domain/wsHub.js";
import { fetchNotificationsByIds } from "./domain/notificationQueries.js";
import { addHotPathSpan } from "./domain/performanceInstrumentation.js";

let transportsWired = false;
function wireTransportsToNotificationService(): void {
  if (transportsWired) return;
  transportsWired = true;
  notificationService.onNotificationCreated((notificationIds, _eventId, recipientIds, trace) => {
    const waitersStart = performance.now();
    for (const recipientId of recipientIds) notificationWaiters.notify(recipientId);
    addHotPathSpan(trace, "fanout.long_poll_notify", waitersStart, performance.now(), { recipientCount: recipientIds.length });

    const requeryStart = performance.now();
    const rows = fetchNotificationsByIds(notificationIds);
    addHotPathSpan(trace, "fanout.db_requery_after_commit", requeryStart, performance.now(), { rowCount: rows.length });

    for (const row of rows) {
      const sseStart = performance.now();
      sseHub.publish(row.recipient_id, row);
      addHotPathSpan(trace, "fanout.sse_publish", sseStart, performance.now(), { notificationId: row.id });

      const wsStart = performance.now();
      wsHub.publish(row.recipient_id, row);
      addHotPathSpan(trace, "fanout.websocket_publish", wsStart, performance.now(), { notificationId: row.id });

      void sendWebPushForNotification(row).catch((err) => console.error("[webPush] Lỗi không lường trước khi gửi:", err));
    }
  });
}

export async function buildApp(): Promise<FastifyInstance> {
  wireTransportsToNotificationService();
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cors, { origin: config.corsOrigin });
  await app.register(websocketPlugin);

  app.get("/health", async () => {
    const serverTimestampMs = Date.now();
    return { status: "ok", time: new Date(serverTimestampMs).toISOString(), serverTimestampMs };
  });

  await app.register(userRoutes);
  await app.register(followRoutes);
  await app.register(postRoutes);
  await app.register(notificationRoutes);
  await app.register(shortPollingRoutes);
  await app.register(longPollingRoutes);
  await app.register(sseRoutes);
  await app.register(websocketRoutes);
  await app.register(webPushRoutes);
  await app.register(benchmarkRoutes);
  return app;
}
