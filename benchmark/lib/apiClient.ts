import "dotenv/config";

/**
 * Base URL đọc ĐỘNG (không đóng băng lúc import) — cho phép Scenario H
 * (runNetworkScenario.ts) tạm thời trỏ mọi request qua Toxiproxy proxy mà
 * KHÔNG cần set biến môi trường trước khi tiến trình khởi động, và KHÔNG
 * ảnh hưởng tới các scenario khác (chúng không bao giờ gọi setApiBaseUrl()).
 */
let baseUrlOverride: string | null = null;

export function setApiBaseUrl(url: string): void {
  baseUrlOverride = url;
}

export function resetApiBaseUrl(): void {
  baseUrlOverride = null;
}

export function apiBaseUrl(): string {
  return baseUrlOverride ?? process.env.BENCHMARK_API_BASE_URL ?? "http://localhost:3000";
}

export function wsBaseUrl(): string {
  return apiBaseUrl().replace(/^http/, "ws");
}

export function benchmarkApiKey(): string {
  const key = process.env.BENCHMARK_API_KEY;
  if (!key) {
    throw new Error(
      "Missing BENCHMARK_API_KEY. Set it in benchmark/.env or environment variables."
    );
  }
  return key;
}

export interface ApiUser {
  id: number;
  display_name: string;
  created_at: number;
}

export interface CreatedPost {
  post: { id: number; author_id: number; script: string; posted_at: number };
  eventId: number;
  notificationIds: number[];
  notificationCount: number;
  recipientIds: number[];
}

export interface DeliveryAttempt {
  notificationId: number;
  transport: "short_polling" | "long_polling" | "sse" | "websocket" | "web_push";
  result: "success" | "failed" | "timeout";
  latencyMs: number | null;
}

export interface ServerClockCalibration {
  /** server Unix-ms - client performance.now() at the estimated request midpoint */
  serverMsPerMonoMs: number;
  roundTripMs: number;
}

export async function listUsers(): Promise<ApiUser[]> {
  const res = await fetch(`${apiBaseUrl()}/users`);
  if (!res.ok) throw new Error(`GET /users thất bại: HTTP ${res.status}`);
  const body = (await res.json()) as { users: ApiUser[] };
  return body.users;
}

export async function getFollowers(userId: number): Promise<ApiUser[]> {
  const res = await fetch(`${apiBaseUrl()}/users/${userId}/followers`);
  if (!res.ok) {
    throw new Error(`GET /users/${userId}/followers thất bại: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { followers: ApiUser[] };
  return body.followers;
}

export async function createPost(authorId: number, script: string): Promise<CreatedPost> {
  const res = await fetch(`${apiBaseUrl()}/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorId, script }),
  });
  if (!res.ok) {
    throw new Error(`POST /posts thất bại: HTTP ${res.status}`);
  }
  return res.json() as Promise<CreatedPost>;
}

export async function getDeliveryAttempts(
  notificationIds: number[]
): Promise<DeliveryAttempt[]> {
  if (notificationIds.length === 0) return [];

  const params = new URLSearchParams({
    notificationIds: notificationIds.join(","),
  });

  const res = await fetch(
    `${apiBaseUrl()}/benchmark/delivery-attempts?${params}`,
    {
      headers: {
        "X-Benchmark-Key": benchmarkApiKey(),
      },
    }
  );

  if (!res.ok) {
    throw new Error(
      `GET /benchmark/delivery-attempts thất bại: HTTP ${res.status}`
    );
  }

  const body = (await res.json()) as {
    attempts: DeliveryAttempt[];
  };
  return body.attempts;
}

/**
 * Calibrate the Render server wall clock against the benchmark process's
 * monotonic clock. We use the midpoint of the /health request to reduce the
 * effect of network round-trip time. The result lets us convert a later
 * performance.now() into the same Unix-ms domain used by SSE createdAt.
 */
export async function calibrateServerClock(): Promise<ServerClockCalibration> {
  const requestStartMonoMs = performance.now();

  const res = await fetch(`${apiBaseUrl()}/health`, {
    cache: "no-store",
  });
  const responseMonoMs = performance.now();

  if (!res.ok) {
    throw new Error(`GET /health thất bại: HTTP ${res.status}`);
  }

  const body = (await res.json()) as { time?: string };
  if (!body.time) {
    throw new Error("GET /health không trả field time để calibrate server clock");
  }

  const serverTimeMs = Date.parse(body.time);
  if (!Number.isFinite(serverTimeMs)) {
    throw new Error(`GET /health trả time không hợp lệ: ${body.time}`);
  }

  const midpointMonoMs = (requestStartMonoMs + responseMonoMs) / 2;

  return {
    serverMsPerMonoMs: serverTimeMs - midpointMonoMs,
    roundTripMs: responseMonoMs - requestStartMonoMs,
  };
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${apiBaseUrl()}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
