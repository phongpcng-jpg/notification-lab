import type { FastifyInstance } from "fastify";
import { getDb } from "../db/index.js";

export async function followRoutes(app: FastifyInstance) {
  // POST /follows { followerId, followeeId }
  app.post<{ Body: { followerId: number; followeeId: number } }>(
    "/follows",
    async (req, reply) => {
      const { followerId, followeeId } = req.body ?? {};
      if (!followerId || !followeeId) {
        return reply
          .status(400)
          .send({ error: "followerId and followeeId are required" });
      }
      if (followerId === followeeId) {
        return reply
          .status(400)
          .send({ error: "Không thể tự follow chính mình" });
      }

      const db = getDb();
      const userExists = db
        .prepare("SELECT 1 FROM users WHERE id IN (?, ?)")
        .all(followerId, followeeId);
      if (userExists.length < 2) {
        return reply.status(404).send({ error: "User không tồn tại" });
      }

      db.prepare(
        "INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)"
      ).run(followerId, followeeId);

      return reply.status(201).send({ followerId, followeeId });
    }
  );

  // DELETE /follows { followerId, followeeId }
  app.delete<{ Body: { followerId: number; followeeId: number } }>(
    "/follows",
    async (req, reply) => {
      const { followerId, followeeId } = req.body ?? {};
      if (!followerId || !followeeId) {
        return reply
          .status(400)
          .send({ error: "followerId and followeeId are required" });
      }
      const db = getDb();
      db.prepare(
        "DELETE FROM follows WHERE follower_id = ? AND followee_id = ?"
      ).run(followerId, followeeId);
      return reply.status(204).send();
    }
  );
}
