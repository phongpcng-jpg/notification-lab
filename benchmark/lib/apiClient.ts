const BASE_URL = process.env.BENCHMARK_API_BASE_URL ?? "http://localhost:3000";

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

export function apiBaseUrl(): string {
  return BASE_URL;
}

export function wsBaseUrl(): string {
  return BASE_URL.replace(/^http/, "ws");
}

export async function listUsers(): Promise<ApiUser[]> {
  const res = await fetch(`${BASE_URL}/users`);
  if (!res.ok) throw new Error(`GET /users thất bại: HTTP ${res.status}`);
  const body = (await res.json()) as { users: ApiUser[] };
  return body.users;
}

export async function getFollowers(userId: number): Promise<ApiUser[]> {
  const res = await fetch(`${BASE_URL}/users/${userId}/followers`);
  if (!res.ok) {
    throw new Error(`GET /users/${userId}/followers thất bại: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { followers: ApiUser[] };
  return body.followers;
}

export async function createPost(authorId: number, script: string): Promise<CreatedPost> {
  const res = await fetch(`${BASE_URL}/posts`, {
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
    const res = await fetch(`${BASE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
