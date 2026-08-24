import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { fetchNotificationsAfter, recordDeliveryBatch } from "../domain/notificationQueries.js";
import { sseHub, type SseSubscription } from "../domain/sseHub.js";
import { openConnection, closeConnection } from "../domain/connectionTracker.js";
import { serializeNotificationForClient } from "../domain/notificationSerialization.js";
import type { NotificationView } from "../domain/types.js";

export async function sseRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { userId: string; lastEventId?: string } }>(
    "/notifications/stream",
    async (req, reply) => {
      const userId = Number(req.query.userId);
      if (!userId) return reply.status(400).send({ error: "userId is required" });

      const lastEventIdHeader = req.headers["last-event-id"];
      const headerValue = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
      const after = Number(headerValue ?? req.query.lastEventId ?? 0);

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": config.corsOrigin,
      });
      reply.raw.write(": connected\n\n");

      const connectionId = openConnection(userId, "sse");

      function sendEvent(row: NotificationView): void {
        const payload = JSON.stringify(serializeNotificationForClient(row, Date.now()));
        const serverSentAtMs = Date.now();
        const finalPayload = JSON.stringify(serializeNotificationForClient(row, serverSentAtMs));
        reply.raw.write(`id: ${row.id}\n`);
        reply.raw.write(`event: notification\n`);
        reply.raw.write(`data: ${finalPayload}\n\n`);
      }

      const missed = fetchNotificationsAfter(userId, after, 200);
      if (missed.length > 0) {
        for (const row of missed) sendEvent(row);
        recordDeliveryBatch(missed, "sse", Date.now());
      }

      const subscription: SseSubscription = {
        onNotification: (row) => {
          const payload = JSON.stringify(serializeNotificationForClient(row, Date.now()));
          const serverSentAtMs = Date.now();
          const finalPayload = JSON.stringify(serializeNotificationForClient(row, serverSentAtMs));
          reply.raw.write(`id: ${row.id}\n`);
          reply.raw.write(`event: notification\n`);
          reply.raw.write(`data: ${finalPayload}\n\n`);
          recordDeliveryBatch([row], "sse", serverSentAtMs);
        },
        forceClose: () => {
          if (!reply.raw.writableEnded) reply.raw.end();
        },
      };
      const unsubscribe = sseHub.subscribe(userId, subscription);

      const heartbeatTimer = setInterval(() => {
        if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n");
      }, config.sseHeartbeatMs);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeatTimer);
        unsubscribe();
        closeConnection(connectionId, "client_disconnect");
      };
      req.raw.on("close", cleanup);
      req.raw.on("error", cleanup);
    }
  );
}
