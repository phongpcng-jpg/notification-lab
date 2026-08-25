import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { config } from "../config.js";
import { fetchNotificationsAfter, recordAcknowledgedBatch, type AcknowledgedDelivery } from "../domain/notificationQueries.js";
import { wsHub, type WsSubscription } from "../domain/wsHub.js";
import { openConnection, closeConnection } from "../domain/connectionTracker.js";
import { notificationService } from "../domain/notificationService.js";
import { serializeNotificationForClient } from "../domain/notificationSerialization.js";
import { addHotPathSpan, findHotPathTracesByNotificationIds } from "../domain/performanceInstrumentation.js";
import type { NotificationView } from "../domain/types.js";

const BACKPRESSURE_THRESHOLD_BYTES = 1_000_000;
const ACK_BATCH_SIZE = 100;
const ACK_FLUSH_MS = 50;

export async function websocketRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { userId: string; after?: string } }>("/ws", { websocket: true }, (socket: WebSocket, req) => {
    const userId = Number(req.query.userId);
    if (!userId) { socket.send(JSON.stringify({ type: "error", message: "userId is required" })); socket.close(1008, "userId is required"); return; }
    const after = Number(req.query.after ?? 0);
    const connectionId = openConnection(userId, "websocket");
    const pendingAcks: AcknowledgedDelivery[] = [];
    const sentCreatedAtMs = new Map<number, number>();
    let ackFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushAcks = () => {
      ackFlushTimer = null;
      if (pendingAcks.length === 0) return;
      const batch = pendingAcks.splice(0, pendingAcks.length);
      const dbStart = performance.now();
      recordAcknowledgedBatch(batch);
      const dbDuration = performance.now() - dbStart;
      const traceIds = [...new Set(batch.flatMap((item) => findHotPathTracesByNotificationIds([item.notificationId]).map((trace) => trace.traceId)))];
      for (const traceId of traceIds) {
        const traces = findHotPathTracesByNotificationIds(batch.map((item) => item.notificationId));
        for (const trace of traces.filter((t) => t.traceId === traceId)) {
          addHotPathSpan(trace, "ack.db_write", dbStart, dbStart + dbDuration, { batchSize: batch.length });
        }
      }
      for (const item of batch) sentCreatedAtMs.delete(item.notificationId);
    };

    const queueAck = (notificationId: number) => {
      const createdAtMs = sentCreatedAtMs.get(notificationId);
      if (createdAtMs === undefined) return;
      if (pendingAcks.some((item) => item.notificationId === notificationId)) return;
      pendingAcks.push({ notificationId, recipientId: userId, latencyMs: Math.max(0, Date.now() - createdAtMs) });
      if (pendingAcks.length >= ACK_BATCH_SIZE) { flushAcks(); return; }
      if (!ackFlushTimer) ackFlushTimer = setTimeout(flushAcks, ACK_FLUSH_MS);
    };

    function sendNotification(row: NotificationView): void {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > BACKPRESSURE_THRESHOLD_BYTES) {
        notificationService.recordDeliveryAttempt({ notificationId: row.id, transport: "websocket", result: "failed", errorReason: "backpressure: bufferedAmount vượt ngưỡng" });
        return;
      }
      const sendStart = performance.now();
      const serverSentAtMs = Date.now();
      const payload = JSON.stringify({ type: "notification", data: serializeNotificationForClient(row, serverSentAtMs) });
      socket.send(payload);
      sentCreatedAtMs.set(row.id, row.created_at * 1000);
      const traces = findHotPathTracesByNotificationIds([row.id]);
      for (const trace of traces) addHotPathSpan(trace, "websocket.socket_send", sendStart, performance.now(), { notificationId: row.id, bufferedAmount: socket.bufferedAmount });
    }

    const subscription: WsSubscription = { socket, connectionId, onNotification: sendNotification, forceClose: () => { if (socket.readyState === socket.OPEN) socket.close(1001, "server_shutdown"); } };
    const unsubscribe = wsHub.subscribe(userId, subscription);

    const replayStart = performance.now();
    const missed = fetchNotificationsAfter(userId, after, 200);
    for (const row of missed) sendNotification(row);
    const replayTraces = missed.flatMap((row) => findHotPathTracesByNotificationIds([row.id]));
    for (const trace of replayTraces) addHotPathSpan(trace, "websocket.catchup_db_requery", replayStart, performance.now(), { rowCount: missed.length });

    socket.send(JSON.stringify({ type: "connected", userId, connectionId }));
    let isAlive = true;
    socket.on("pong", () => { isAlive = true; });
    const heartbeatTimer = setInterval(() => { if (!isAlive) { socket.terminate(); return; } isAlive = false; socket.ping(); }, config.wsHeartbeatMs);

    socket.on("message", (raw: Buffer) => {
      let msg: unknown; try { msg = JSON.parse(raw.toString("utf-8")); } catch { return; }
      if (typeof msg === "object" && msg !== null && "type" in msg && (msg as { type: unknown }).type === "ack" && "notificationId" in msg && typeof (msg as { notificationId: unknown }).notificationId === "number") queueAck((msg as { notificationId: number }).notificationId);
    });

    let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; clearInterval(heartbeatTimer); if (ackFlushTimer) clearTimeout(ackFlushTimer); flushAcks(); sentCreatedAtMs.clear(); unsubscribe(); closeConnection(connectionId, "client_disconnect"); };
    socket.on("close", cleanup); socket.on("error", cleanup);
  });
}
