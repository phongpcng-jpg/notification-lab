import type { FastifyInstance } from "fastify";

export async function createUser(
  app: FastifyInstance,
  name: string
): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: "/users",
    payload: { displayName: name },
  });
  return JSON.parse(res.payload).id;
}

export async function follow(
  app: FastifyInstance,
  followerId: number,
  followeeId: number
): Promise<void> {
  await app.inject({
    method: "POST",
    url: "/follows",
    payload: { followerId, followeeId },
  });
}

export async function createPost(
  app: FastifyInstance,
  authorId: number,
  script: string
) {
  return app.inject({
    method: "POST",
    url: "/posts",
    payload: { authorId, script },
  });
}

/** Lấy port thật sau khi app.listen({port:0}) — cần cho test SSE/WebSocket
 * vì fastify.inject() không phù hợp cho luồng dài hạn/streaming. */
export function getPort(app: FastifyInstance): number {
  const address = app.server.address();
  if (address && typeof address === "object") return address.port;
  throw new Error("Server chưa listen, không lấy được port");
}

/** Poll 1 điều kiện tới khi đúng hoặc timeout — dùng thay vì fixed sleep
 * để test nhanh và ổn định hơn (không phụ thuộc timing cứng). */
export function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitUntil timeout sau ${timeoutMs}ms`));
      }
      setTimeout(check, 20);
    };
    check();
  });
}
