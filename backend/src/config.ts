import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: required("DB_PATH", "./data/notification-lab.db"),

  // Long polling
  longPollTimeoutMs: Number(process.env.LONG_POLL_TIMEOUT_MS ?? 25_000),

  // Short polling — server chỉ trả config gợi ý, client tự quyết định dùng hay không
  shortPollSuggestedIntervalMs: Number(
    process.env.SHORT_POLL_INTERVAL_MS ?? 5_000
  ),

  // SSE heartbeat để giữ kết nối qua proxy hay buffer
  sseHeartbeatMs: Number(process.env.SSE_HEARTBEAT_MS ?? 15_000),

  // WebSocket
  wsHeartbeatMs: Number(process.env.WS_HEARTBEAT_MS ?? 20_000),

  // Web Push (VAPID) — KHÔNG hard-code, phải set qua .env
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",

  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
};
