import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { fetchNotificationsAfter, recordDeliveryBatch } from "../domain/notificationQueries.js";
import { notificationWaiters } from "../domain/notificationWaiters.js";
import { openConnection, closeConnection } from "../domain/connectionTracker.js";

export async function longPollingRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { userId: string; after?: string; limit?: string } }>(
    "/notifications/long-poll", async (req, reply) => {
      const userId = Number(req.query.userId);
      if (!userId) return reply.status(400).send({ error: "userId is required" });
      const after = Number(req.query.after ?? 0);
      const limit = Math.min(Number(req.query.limit ?? 50), 200);

      const immediateRows = fetchNotificationsAfter(userId, after, limit);
      if (immediateRows.length > 0) {
        const now = Date.now();
        recordDeliveryBatch(immediateRows, "long_polling", now);
        const serverSentAtMs = Date.now();
        return reply.send({ notifications: immediateRows, nextAfter: immediateRows[immediateRows.length - 1].id, timedOut: false, serverTime: now, serverSentAtMs });
      }

      const connectionId = openConnection(userId, "long_polling");
      const { promise, cancel } = notificationWaiters.waitFor(userId);
      let settledReason: "data" | "timeout" | "client_disconnect" | null = null;
      const timeoutHandle = setTimeout(() => { if (settledReason === null) settledReason = "timeout"; }, config.longPollTimeoutMs);
      const onClientClose = () => { if (settledReason === null) settledReason = "client_disconnect"; };
      req.raw.on("close", onClientClose);
      await Promise.race([promise, new Promise<void>((resolve) => {
        const check = () => { if (settledReason !== null) return resolve(); setTimeout(check, 25); };
        check();
      })]);
      clearTimeout(timeoutHandle); cancel(); req.raw.off("close", onClientClose);

      if (settledReason === "client_disconnect") {
        closeConnection(connectionId, "client_disconnect");
        return;
      }

      const rows = fetchNotificationsAfter(userId, after, limit);
      const now = Date.now();
      if (rows.length > 0) {
        recordDeliveryBatch(rows, "long_polling", now);
        closeConnection(connectionId, "data_delivered");
        const serverSentAtMs = Date.now();
        return reply.send({ notifications: rows, nextAfter: rows[rows.length - 1].id, timedOut: false, serverTime: now, serverSentAtMs });
      }

      closeConnection(connectionId, "timeout");
      const serverSentAtMs = Date.now();
      return reply.send({ notifications: [], nextAfter: after, timedOut: true, serverTime: now, serverSentAtMs });
    });
}
