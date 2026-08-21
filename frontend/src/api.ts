import { API_BASE_URL } from "./config.js";

const BASE = API_BASE_URL;

export interface ApiUser {
  id: number;
  display_name: string;
  created_at: number;
}

export interface ApiPost {
  id: number;
  author_id: number;
  script: string;
  posted_at: number;
  author_name?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  listUsers: () => request<{ users: ApiUser[] }>("/users"),
  createUser: (displayName: string) =>
    request<{ id: number; displayName: string }>("/users", {
      method: "POST",
      body: JSON.stringify({ displayName }),
    }),
  listFollowing: (userId: number) =>
    request<{ following: ApiUser[] }>(`/users/${userId}/following`),
  listFollowers: (userId: number) =>
    request<{ followers: ApiUser[] }>(`/users/${userId}/followers`),
  follow: (followerId: number, followeeId: number) =>
    request("/follows", {
      method: "POST",
      body: JSON.stringify({ followerId, followeeId }),
    }),
  unfollow: (followerId: number, followeeId: number) =>
    request("/follows", {
      method: "DELETE",
      body: JSON.stringify({ followerId, followeeId }),
    }),
  listPosts: (limit = 50) => request<{ posts: ApiPost[] }>(`/posts?limit=${limit}`),
  createPost: (authorId: number, script: string) =>
    request<{ post: ApiPost; notificationCount: number }>("/posts", {
      method: "POST",
      body: JSON.stringify({ authorId, script }),
    }),
  listNotifications: (userId: number, after = 0) =>
    request(`/notifications?userId=${userId}&after=${after}`),
};
