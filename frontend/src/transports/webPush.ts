import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "../config.js";
import { api } from "../api.js";
import type { PolledNotification } from "./types.js";

export type WebPushStatus =
  | "idle"
  | "unsupported"
  | "permission-denied"
  | "subscribing"
  | "subscribed"
  | "error";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

interface WebPushServiceWorkerMessage {
  type: "notification";
  notificationId: number | null;
}

/**
 * WEB PUSH client.
 *
 * Web Push remains independent from the other notification transports.
 * The Service Worker owns OS-level notifications and reports a push event
 * to an active tab. This hook owns the React notification state and uses
 * the canonical /notifications endpoint for history/recovery.
 */
export function useWebPush(userId: number | null, enabled: boolean) {
  const [status, setStatus] = useState<WebPushStatus>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<PolledNotification[]>([]);

  const afterRef = useRef(0);

  const mergeNotifications = useCallback((incoming: PolledNotification[]) => {
    if (incoming.length === 0) return;

    setNotifications((prev) => {
      const seen = new Set(prev.map((notification) => notification.id));
      const fresh = incoming.filter((notification) => !seen.has(notification.id));

      if (fresh.length === 0) return prev;
      return [...fresh.reverse(), ...prev];
    });

    afterRef.current = Math.max(
      afterRef.current,
      ...incoming.map((notification) => notification.id)
    );
  }, []);

  const loadHistory = useCallback(async () => {
    if (!userId) return;

    try {
      const response = await api.listNotifications(userId, 0);
      mergeNotifications(response.notifications);
      afterRef.current = Math.max(afterRef.current, response.nextAfter);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, [userId, mergeNotifications]);

  const recoverAfterPush = useCallback(async () => {
    if (!userId) return;

    try {
      const response = await api.listNotifications(userId, afterRef.current);
      mergeNotifications(response.notifications);
      afterRef.current = Math.max(afterRef.current, response.nextAfter);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, [userId, mergeNotifications]);

  const subscribe = useCallback(async () => {
    if (!userId) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }

    try {
      setStatus("subscribing");
      setLastError(null);

      const registration = await navigator.serviceWorker.register("/sw.js");

      // BẮT BUỘC gọi trong ngữ cảnh user gesture (hàm này được gọi từ
      // onClick của nút "Bật thông báo đẩy" ở App.tsx).
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("permission-denied");
        return;
      }

      const keyRes = await fetch(`${API_BASE_URL}/push/vapid-public-key`);
      const { publicKey } = await keyRes.json();
      if (!publicKey) {
        setLastError(
          "Server chưa cấu hình VAPID (.env thiếu VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY). " +
            "Chạy `npm run generate-vapid-keys` trong backend/ rồi dán vào .env."
        );
        setStatus("error");
        return;
      }

      const pushSubscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      await fetch(`${API_BASE_URL}/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          subscription: pushSubscription.toJSON(),
        }),
      });

      setStatus("subscribed");
      await loadHistory();
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [userId, loadHistory]);

  const unsubscribe = useCallback(async () => {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const pushSubscription = await registration?.pushManager.getSubscription();
      if (pushSubscription) {
        await fetch(`${API_BASE_URL}/push/unsubscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: pushSubscription.endpoint }),
        });
        await pushSubscription.unsubscribe();
      }
      setStatus("idle");
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!enabled || !userId) return;

    afterRef.current = 0;
    setNotifications([]);
    void loadHistory();
  }, [enabled, userId, loadHistory]);

  useEffect(() => {
    if (!enabled || !userId || !("serviceWorker" in navigator)) return;

    const handleMessage = (event: MessageEvent<WebPushServiceWorkerMessage>) => {
      if (event.data?.type !== "notification") return;
      if (event.data.notificationId == null) return;
      void recoverAfterPush();
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handleMessage);
    };
  }, [enabled, userId, recoverAfterPush]);

  return {
    status,
    lastError,
    notifications,
    subscribe,
    unsubscribe,
  };
}
