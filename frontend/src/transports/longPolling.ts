import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "../config.js";
import { computeBackoffDelay } from "./backoff.js";
import type { PolledNotification } from "./types.js";

interface LongPollResponse {
  notifications: PolledNotification[];
  nextAfter: number;
  timedOut: boolean;
  serverTime: number;
}

const MAX_RETRY_DELAY_MS = 30_000;
const BASE_RETRY_DELAY_MS = 1_000;

/**
 * LONG POLLING client.
 *
 * Server giữ request tới khi có dữ liệu hoặc timeout, nên client mở lại
 * request ngay sau response thành công. AbortController hủy request đang
 * treo khi đổi transport/user; lỗi mạng thật được retry bằng backoff + jitter.
 */
export function useLongPolling(userId: number | null, enabled: boolean) {
  const [notifications, setNotifications] = useState<PolledNotification[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const afterRef = useRef(0);
  const attemptRef = useRef(0);
  const stoppedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRetryTimer = () => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  };

  const loop = useCallback(async () => {
    if (!userId || stoppedRef.current) return;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(
        `${API_BASE_URL}/notifications/long-poll?userId=${userId}&after=${afterRef.current}`,
        { signal: controller.signal }
      );
      if (!res.ok) {
        throw new Error(`Long poll failed: HTTP ${res.status}`);
      }
      const body: LongPollResponse = await res.json();

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
        void loop();
      }
    } catch (err) {
      if (controller.signal.aborted) return;

      attemptRef.current += 1;
      const delay = computeBackoffDelay(attemptRef.current, {
        baseMs: BASE_RETRY_DELAY_MS,
        maxMs: MAX_RETRY_DELAY_MS,
      });
      setLastError(err instanceof Error ? err.message : String(err));
      if (!stoppedRef.current) {
        retryTimeoutRef.current = setTimeout(loop, delay);
      }
    }
  }, [userId]);

  const start = useCallback(() => {
    if (!userId) return;
    stoppedRef.current = false;
    setIsPolling(true);
    clearRetryTimer();
    void loop();
  }, [userId, loop]);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    setIsPolling(false);
    clearRetryTimer();
    abortRef.current?.abort();
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
