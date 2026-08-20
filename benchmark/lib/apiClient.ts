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

export interface ApiUser {
  id: number;
  display_name: string;
  created_at: number;
}

export interface CreatedPost {
  post: { id: number; author_id: number; script: string; posted_at: number };
  eventId: number;
  notificationCount: number;
  recipientIds: number[];
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
  return res.json();
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${apiBaseUrl()}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
