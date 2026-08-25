import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const vitestWorker = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID;
const defaultDbPath = vitestWorker ? `./data/test-${vitestWorker}.db` : "./data/notification-lab.db";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: required("DB_PATH", defaultDbPath),
  longPollTimeoutMs: Number(process.env.LONG_POLL_TIMEOUT_MS ?? 25_000),
  shortPollSuggestedIntervalMs: Number(process.env.SHORT_POLL_INTERVAL_MS ?? 5_000),
  sseHeartbeatMs: Number(process.env.SSE_HEARTBEAT_MS ?? 15_000),
  wsHeartbeatMs: Number(process.env.WS_HEARTBEAT_MS ?? 20_000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  benchmarkApiKey: process.env.BENCHMARK_API_KEY ?? "",
};
