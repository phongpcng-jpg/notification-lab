import { config } from "./config.js";
import { migrate } from "./db/index.js";
import { buildApp } from "./app.js";
import { sseHub } from "./domain/sseHub.js";
import { wsHub } from "./domain/wsHub.js";

async function main() {
  // Đảm bảo schema tồn tại trước khi nhận request (idempotent).
  migrate();

  const app = await buildApp();

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
      sseHub.closeAll();
      wsHub.closeAll();
      await app.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
