import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { config } from "../config.js";
import {
  fetchNotificationsAfter,
  recordDeliveryBatch,
} from "../domain/notificationQueries.js";
import { wsHub, type WsSubscription } from "../domain/wsHub.js";
import { openConnection, closeConnection } from "../domain/connectionTracker.js";
import { notificationService } from "../domain/notificationService.js";
import { serializeNotificationForClient } from "../domain/notificationSerialization.js";
import type { NotificationView } from "../domain/types.js";

// Nếu buffer gửi (chưa flush xuống OS) vượt ngưỡng này, coi là backpressure —
// bỏ qua gửi thêm để tránh out-of-memory nếu client chậm (Scenario G — Slow Client).
const BACKPRESSURE_THRESHOLD_BYTES = 1_000_000; // 1MB

/**
 * WEBSOCKET
 * ─────────
 * GET /ws?userId=&after=  (upgrade từ HTTP, dùng @fastify/websocket, dựa
 * trên thư viện `ws` — đúng ADR-001: không dùng Socket.IO để đo đúng hành vi
 * WebSocket thuần).
 *
 * Đây là transport 2 CHIỀU DUY NHẤT trong 5 transport của project:
 * - Server → Client: notification (catch-up + live), connected/error message.
 * - Client → Server: `{ type: 'ack', notificationId }` — xác nhận đã nhận,
 *   cập nhật status 'acknowledged' (khác 'delivered' — xem
 *   `notificationService.markAcknowledged()`), thể hiện đúng khả năng mà
 *   SSE/Polling không có.
 *
 * Heartbeat: dùng ping/pong Ở TẦNG GIAO THỨC WebSocket (không phải app-level
 * message) — browser tự động trả `pong` khi nhận `ping`, hoàn toàn transparent
 * với JS phía client (không cần code gì thêm ở frontend cho việc này).
 * Server chủ động ping định kỳ; nếu không nhận được pong trước lần ping kế
 * tiếp → coi là stale connection → `socket.terminate()` (đóng cứng, không
 * đợi close handshake, vì rất có thể client đã chết/mất mạng).
 *
 * Backpressure: kiểm tra `socket.bufferedAmount` trước khi gửi thêm — nếu
 * vượt ngưỡng, bỏ qua gửi (không block event loop chờ), ghi delivery_attempt
 * result='failed' để benchmark nhìn thấy được hiện tượng này (Scenario G).
 *
 * Message ordering: đảm bảo TRONG 1 kết nối (TCP ordered delivery + gửi tuần
 * tự theo thứ tự query DB ASC). KHÔNG đảm bảo giữa nhiều kết nối/tab của
 * cùng 1 user (mỗi tab là 1 luồng độc lập).
 */
export async function websocketRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { userId: string; after?: string } }>(
    "/ws",
    { websocket: true },
    (socket: WebSocket, req) => {
      const userId = Number(req.query.userId);
      if (!userId) {
        socket.send(
          JSON.stringify({ type: "error", message: "userId is required" })
        );
        socket.close(1008, "userId is required");
        return;
      }
      const after = Number(req.query.after ?? 0);

      const connectionId = openConnection(userId, "websocket");

      function trySend(obj: unknown): "sent" | "backpressure" | "closed" {
        if (socket.readyState !== socket.OPEN) return "closed";
        if (socket.bufferedAmount > BACKPRESSURE_THRESHOLD_BYTES) {
          return "backpressure";
        }
        socket.send(JSON.stringify(obj));
        return "sent";
      }

      function sendNotification(row: NotificationView): void {
        const result = trySend({
          type: "notification",
          data: serializeNotificationForClient(row),
        });
        if (result === "sent") {
          recordDeliveryBatch([row], "websocket", Date.now());
        } else if (result === "backpressure") {
          notificationService.recordDeliveryAttempt({
            notificationId: row.id,
            transport: "websocket",
            result: "failed",
            errorReason: "backpressure: bufferedAmount vượt ngưỡng",
          });
        }
        // result === "closed": socket đã đóng, không ghi gì thêm — 'close'
        // handler sẽ lo phần cleanup.
      }

      // 1) Catch-up
      const missed = fetchNotificationsAfter(userId, after, 200);
      for (const row of missed) sendNotification(row);

      // 2) Đăng ký nhận notification mới
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

      // 3) Heartbeat ping/pong ở tầng giao thức
      let isAlive = true;
      socket.on("pong", () => {
        isAlive = true;
      });
      const heartbeatTimer = setInterval(() => {
        if (!isAlive) {
          socket.terminate(); // sẽ trigger 'close' -> cleanup() bên dưới
          return;
        }
        isAlive = false;
        socket.ping();
      }, config.wsHeartbeatMs);

      // 4) Nhận message từ client — minh chứng tính 2 chiều thật
      socket.on("message", (raw: Buffer) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString("utf-8"));
        } catch {
          return; // malformed message — bỏ qua, không crash connection
        }
        if (
          typeof msg === "object" &&
          msg !== null &&
          "type" in msg &&
          (msg as { type: unknown }).type === "ack" &&
          "notificationId" in msg &&
          typeof (msg as { notificationId: unknown }).notificationId === "number"
        ) {
          notificationService.markAcknowledged(
            (msg as { notificationId: number }).notificationId,
            userId
          );
        }
      });

      // 5) Cleanup
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
