import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { migrate } from "./db/index.js";
import { userRoutes } from "./routes/users.js";
import { followRoutes } from "./routes/follows.js";
import { postRoutes } from "./routes/posts.js";
import { notificationRoutes } from "./routes/notifications.js";

async function main() {
  // Đảm bảo schema tồn tại trước khi nhận request (idempotent).
  migrate();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  await app.register(cors, {
    origin: config.corsOrigin,
  });

  app.get("/health", async () => ({
    status: "ok",
    time: new Date().toISOString(),
  }));

  await app.register(userRoutes);
  await app.register(followRoutes);
  await app.register(postRoutes);
  await app.register(notificationRoutes);

  // ── Phase 2 sẽ đăng ký thêm ở đây: ──
  // await app.register(shortPollingRoutes);
  // await app.register(longPollingRoutes);
  // await app.register(sseRoutes);
  // await app.register(websocketRoutes);
  // await app.register(webPushRoutes);

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    app.log.info(`Notification Lab backend listening on port ${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown — quan trọng cho benchmark (đóng connection sạch sẽ)
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down gracefully...`);
      await app.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
