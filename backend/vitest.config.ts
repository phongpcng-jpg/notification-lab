import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      DB_PATH: ":memory:",
      CORS_ORIGIN: "http://localhost:5173",
      LOG_LEVEL: "silent",
      LONG_POLL_TIMEOUT_MS: "300",
    },
  },
});
