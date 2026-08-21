import { useCallback, useEffect, useRef, useState } from "react";
import { WS_BASE_URL } from "../config.js";
import { computeBackoffDelay } from "./backoff.js";
import type { PolledNotification } from "./types.js";
import {
  toPolledNotification,
  type ClientNotificationPayload,
} from "./notificationPayload.js";

interface ServerMessage {
  type: "connected" | "notification" | "error";
  userId?: number;
  connectionId?: number;
  data?: ClientNotificationPayload;
  message?: string;
}

const MAX_RETRY_DELAY_MS = 30_000;
const BASE_RETRY_DELAY_MS = 1_000;

/**
 * WEBSOCKET client.
 *
 * Khác SSE: trình duyệt KHÔNG có reconnect built-in cho WebSocket (đúng như
 * research report ghi — "Tự implement, không built-in như EventSource"),
 * nên phải tự viết reconnect + backoff, giống pattern đã dùng ở Short/Long
 * Polling (dùng chung `computeBackoffDelay`).
 *
 * Heartbeat ping/pong ở tầng giao thức được trình duyệt xử lý HOÀN TOÀN
 * transparent — không cần code gì ở đây cho việc đó (khác WebSocket thô
 * trên Node.js, nơi mình phải tự lắng nghe sự kiện 'ping'/'pong').
 *
 * Minh chứng tính 2 chiều: sau khi nhận 1 notification, chủ động gửi lại
 * `{type:'ack', notificationId}` cho server — điều mà SSE/Polling không
 * làm được vì không có kênh client->server trên cùng kết nối.
 */
export function useWebSocket(userId: number | null, enabled: boolean) {
  const [notifications, setNotifications] = useState<PolledNotification[]>([]);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "open" | "closed"
  >("closed");
  const [lastError, setLastError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const afterRef = useRef(0);
  const attemptRef = useRef(0);
  const stoppedRef = useRef(true);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRetryTimer = () => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  };

  const connect = useCallback(() => {
    if (!userId || stoppedRef.current) return;

    setConnectionState("connecting");
    const url = `${WS_BASE_URL}?userId=${userId}&after=${afterRef.current}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionState("open");
      setLastError(null);
      attemptRef.current = 0;
    };

    ws.onmessage = (ev: MessageEvent<string>) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch (err) {
        setLastError(
          `Không parse được message: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }

      if (msg.type === "notification" && msg.data) {
        const notification = toPolledNotification(msg.data);
        afterRef.current = Math.max(afterRef.current, notification.id);
        setNotifications((prev) =>
          prev.some((n) => n.id === notification.id)
            ? prev
            : [notification, ...prev]
        );
        // Minh chứng bidirectional: ack lại cho server ngay khi nhận.
        ws.send(JSON.stringify({ type: "ack", notificationId: notification.id }));
      } else if (msg.type === "error") {
        setLastError(msg.message ?? "WebSocket server error");
      }
    };

    ws.onerror = () => {
      setLastError("WebSocket connection error");
    };

    ws.onclose = () => {
      wsRef.current = null;
      setConnectionState("closed");
      if (!stoppedRef.current) {
        attemptRef.current += 1;
        const delay = computeBackoffDelay(attemptRef.current, {
          baseMs: BASE_RETRY_DELAY_MS,
          maxMs: MAX_RETRY_DELAY_MS,
        });
        retryTimeoutRef.current = setTimeout(connect, delay);
      }
    };
  }, [userId]);

  const start = useCallback(() => {
    if (!userId) return;
    stoppedRef.current = false;
    setNotifications([]); // reset khi đổi user/transport
    afterRef.current = 0;
    clearRetryTimer();
    connect();
  }, [userId, connect]);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    clearRetryTimer();
    wsRef.current?.close();
    wsRef.current = null;
    setConnectionState("closed");
  }, []);

  useEffect(() => {
    if (enabled && userId) {
      start();
    } else {
      stop();
    }
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userId]);

  return { notifications, connectionState, lastError };
}
