import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";
import type { User } from "../domain/types.js";

export async function userRoutes(app: FastifyInstance) {
  // GET /users — danh sách user để frontend cho phép "chọn vai trò"
  app.get("/users", async () => {
    const db = getDb();
    const users = db
      .prepare("SELECT id, display_name, created_at FROM users ORDER BY id")
      .all() as User[];
    return { users };
  });

  // POST /users — tạo user mới nhanh (không cần password/email)
  app.post<{ Body: { displayName: string } }>("/users", async (req, reply) => {
    const { displayName } = req.body ?? ({} as { displayName?: string });
    if (!displayName || !displayName.trim()) {
      return reply.status(400).send({ error: "displayName is required" });
    }
    const db = getDb();
    const info = db
      .prepare("INSERT INTO users (display_name) VALUES (?)")
      .run(displayName.trim());
    return reply.status(201).send({ id: Number(info.lastInsertRowid), displayName });
  });

  // GET /users/:id/followers — ai đang follow user này (nhận notification khi user post)
  app.get<{ Params: { id: string } }>(
    "/users/:id/followers",
    async (req) => {
      const db = getDb();
      const followers = db
        .prepare(
          `SELECT u.id, u.display_name, u.created_at
           FROM follows f JOIN users u ON u.id = f.follower_id
           WHERE f.followee_id = ?`
        )
        .all(Number(req.params.id)) as User[];
      return { followers };
    }
  );

  // GET /users/:id/following — user này đang follow ai
  app.get<{ Params: { id: string } }>(
    "/users/:id/following",
    async (req) => {
      const db = getDb();
      const following = db
        .prepare(
          `SELECT u.id, u.display_name, u.created_at
           FROM follows f JOIN users u ON u.id = f.followee_id
           WHERE f.follower_id = ?`
        )
        .all(Number(req.params.id)) as User[];
      return { following };
    }
  );
}
