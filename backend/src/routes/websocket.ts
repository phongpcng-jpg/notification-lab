import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { config } from "../config.js";
import { fetchNotificationsAfter, recordDeliveryBatch } from "../domain/notificationQueries.js";
import { wsHub, type WsSubscription } from "../domain/wsHub.js";
import { openConnection, closeConnection } from "../domain/connectionTracker.js";
import { notificationService } from "../domain/notificationService.js";
import { serializeNotificationForClient } from "../domain/notificationSerialization.js";
import type { NotificationView } from "../domain/types.js";

const BACKPRESSURE_THRESHOLD_BYTES = 1_000_000;

export async function websocketRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { userId: string; after?: string } }>(
    "/ws",
    { websocket: true },
    (socket: WebSocket, req) => {
      const userId = Number(req.query.userId);
      if (!userId) {
        socket.send(JSON.stringify({ type: "error", message: "userId is required" }));
        socket.close(1008, "userId is required");
        return;
      }
      const after = Number(req.query.after ?? 0);
      const connectionId = openConnection(userId, "websocket");

      function sendNotification(row: NotificationView): void {
        if (socket.readyState !== socket.OPEN) return;
        if (socket.bufferedAmount > BACKPRESSURE_THRESHOLD_BYTES) {
          notificationService.recordDeliveryAttempt({
            notificationId: row.id,
            transport: "websocket",
            result: "failed",
            errorReason: "backpressure: bufferedAmount vượt ngưỡng",
          });
          return;
        }

        const serverSentAtMs = Date.now();
        socket.send(JSON.stringify({
          type: "notification",
          data: serializeNotificationForClient(row, serverSentAtMs),
        }));
        recordDeliveryBatch([row], "websocket", serverSentAtMs);
      }

      const missed = fetchNotificationsAfter(userId, after, 200);
      for (const row of missed) sendNotification(row);

      const subscription: WsSubscription = {
        socket,
        connectionId,
        onNotification: sendNotification,
        forceClose: () => {
          if (socket.readyState === socket.OPEN) socket.close(1001, "server_shutdown");
        },
      };
      const unsubscribe = wsHub.subscribe(userId, subscription);
      socket.send(JSON.stringify({ type: "connected", userId, connectionId }));

      let isAlive = true;
      socket.on("pong", () => { isAlive = true; });
      const heartbeatTimer = setInterval(() => {
        if (!isAlive) {
          socket.terminate();
          return;
        }
        isAlive = false;
        socket.ping();
      }, config.wsHeartbeatMs);

      socket.on("message", (raw: Buffer) => {
        let msg: unknown;
        try { msg = JSON.parse(raw.toString("utf-8")); } catch { return; }
        if (
          typeof msg === "object" && msg !== null && "type" in msg &&
          (msg as { type: unknown }).type === "ack" && "notificationId" in msg &&
          typeof (msg as { notificationId: unknown }).notificationId === "number"
        ) {
          notificationService.markAcknowledged(
            (msg as { notificationId: number }).notificationId,
            userId
          );
        }
      });

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeatTimer);
        unsubscribe();
        closeConnection(connectionId, "client_disconnect");
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    }
  );
}
