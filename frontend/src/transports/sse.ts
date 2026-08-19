import { useEffect, useRef, useState } from "react";
import type { PolledNotification } from "./types.js";
import {
  toPolledNotification,
  type ClientNotificationPayload,
} from "./notificationPayload.js";

/**
 * SSE client — dùng `EventSource` built-in của trình duyệt thay vì tự viết
 * reconnect logic. Khác biệt lớn nhất so với 2 transport polling trước:
 * - KHÔNG cần vòng lặp/backoff thủ công — EventSource tự động reconnect khi
 *   mất kết nối, và tự động gửi header `Last-Event-ID` (giá trị lấy từ dòng
 *   `id:` cuối cùng server gửi) khi reconnect, nên server tự catch-up đúng
 *   phần bị lỡ — đây chính là lý do research report đánh giá SSE có
 *   "reconnect + event-id built-in trong trình duyệt, giảm code phải tự viết".
 * - `readyState` của EventSource cho biết trạng thái connecting/open/closed,
 *   dùng trực tiếp thay vì tự quản lý `isPolling`.
 */
export function useSse(userId: number | null, enabled: boolean) {
  const [notifications, setNotifications] = useState<PolledNotification[]>([]);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "open" | "closed"
  >("closed");
  const [lastError, setLastError] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled || !userId) {
      esRef.current?.close();
      esRef.current = null;
      setConnectionState("closed");
      return;
    }

    setNotifications([]); // reset khi đổi user/transport, tránh lẫn dữ liệu
    setConnectionState("connecting");
    const es = new EventSource(`/api/notifications/stream?userId=${userId}`);
    esRef.current = es;

    es.addEventListener("open", () => {
      setConnectionState("open");
      setLastError(null);
    });

    es.addEventListener("notification", (ev: MessageEvent<string>) => {
      try {
        const payload: ClientNotificationPayload = JSON.parse(ev.data);
        const notification = toPolledNotification(payload);
        setNotifications((prev) => {
          if (prev.some((n) => n.id === notification.id)) return prev; // dedupe phòng hờ
          return [notification, ...prev];
        });
      } catch (err) {
        setLastError(
          `Không parse được event: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    es.addEventListener("error", () => {
      // EventSource tự reconnect ở background (readyState sẽ về CONNECTING),
      // nên chỉ cập nhật UI, KHÔNG tự ý đóng kết nối ở đây.
      setConnectionState(
        es.readyState === EventSource.CLOSED ? "closed" : "connecting"
      );
      setLastError("Mất kết nối SSE, trình duyệt đang tự reconnect...");
    });

    return () => {
      es.close();
      esRef.current = null;
      setConnectionState("closed");
    };
  }, [userId, enabled]);

  return { notifications, connectionState, lastError };
}
