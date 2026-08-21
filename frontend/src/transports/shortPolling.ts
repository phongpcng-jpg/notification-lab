import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "../config.js";
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
 * Recursive setTimeout đảm bảo request kế tiếp chỉ bắt đầu sau khi request
 * trước đã hoàn tất. Khi thành công dùng interval server gợi ý; khi lỗi dùng
 * exponential backoff + jitter. Cursor `after` được giữ ở client để bảo đảm
 * at-least-once delivery và client tự dedupe theo notification id.
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
        `${API_BASE_URL}/notifications/poll?userId=${userId}&after=${afterRef.current}`
      );
      if (!res.ok) {
        throw new Error(`Poll failed: HTTP ${res.status}`);
      }
      const body: PollResponse = await res.json();

      if (body.notifications.length > 0) {
        setNotifications((prev) => {
          const seen = new Set(prev.map((n) => n.id));
          const fresh = body.notifications.filter((n) => !seen.has(n.id));
          return [...fresh.reverse(), ...prev];
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
