import { useCallback, useEffect, useRef, useState } from "react";
import { computeBackoffDelay } from "./backoff.js";
import type { PolledNotification } from "./types.js";

interface PollResponse {
  notifications: PolledNotification[];
  nextAfter: number;
  suggestedIntervalMs: number;
  serverTime: number;
}

const MAX_RETRY_DELAY_MS = 30_000;
const BASE_RETRY_DELAY_MS = 1_000;

/**
 * SHORT POLLING client.
 *
 * Thiết kế lifecycle:
 * - Dùng recursive setTimeout (không dùng setInterval) để đảm bảo request
 *   tiếp theo chỉ bắt đầu SAU KHI request trước đã xong — tránh chồng request
 *   khi server chậm hơn interval cấu hình (Rule Section 40: không reconnect
 *   kiểu setInterval vô điều kiện).
 * - Khi thành công: dùng `suggestedIntervalMs` server trả về làm delay tiếp theo,
 *   reset backoff attempt counter về 0.
 * - Khi lỗi: dùng exponential backoff + jitter (computeBackoffDelay), KHÔNG
 *   retry ngay lập tức, để tránh làm nặng thêm server đang gặp sự cố.
 * - Cursor `after` lưu ở client (useRef, không phải state) — vì tăng liên tục
 *   theo mỗi lần poll, không cần re-render khi nó đổi một mình.
 */
export function useShortPolling(userId: number | null, enabled: boolean) {
  const [notifications, setNotifications] = useState<PolledNotification[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const afterRef = useRef(0);
  const attemptRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(true);

  const clearScheduled = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const pollOnce = useCallback(async () => {
    if (!userId || stoppedRef.current) return;

    try {
      const res = await fetch(
        `/api/notifications/poll?userId=${userId}&after=${afterRef.current}`
      );
      if (!res.ok) {
        throw new Error(`Poll failed: HTTP ${res.status}`);
      }
      const body: PollResponse = await res.json();

      if (body.notifications.length > 0) {
        setNotifications((prev) => {
          // Dedupe theo id — cần thiết vì delivery semantics là at-least-once
          const seen = new Set(prev.map((n) => n.id));
          const fresh = body.notifications.filter((n) => !seen.has(n.id));
          return [...fresh.reverse(), ...prev]; // mới nhất lên đầu
        });
      }
      afterRef.current = body.nextAfter;
      attemptRef.current = 0;
      setLastError(null);

      if (!stoppedRef.current) {
        timeoutRef.current = setTimeout(pollOnce, body.suggestedIntervalMs);
      }
    } catch (err) {
      attemptRef.current += 1;
      const delay = computeBackoffDelay(attemptRef.current, {
        baseMs: BASE_RETRY_DELAY_MS,
        maxMs: MAX_RETRY_DELAY_MS,
      });
      setLastError(err instanceof Error ? err.message : String(err));
      if (!stoppedRef.current) {
        timeoutRef.current = setTimeout(pollOnce, delay);
      }
    }
  }, [userId]);

  const start = useCallback(() => {
    if (!userId) return;
    stoppedRef.current = false;
    setIsPolling(true);
    clearScheduled();
    void pollOnce();
  }, [userId, pollOnce]);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    setIsPolling(false);
    clearScheduled();
  }, []);

  // Tự stop khi unmount hoặc khi `enabled`/`userId` đổi, tránh leak timeout
  // giữa các lần chuyển transport/chuyển user.
  useEffect(() => {
    if (enabled && userId) {
      start();
    } else {
      stop();
    }
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userId]);

  return { notifications, isPolling, lastError, start, stop };
}
