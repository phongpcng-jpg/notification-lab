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

const WEB_PUSH_TRACE = "[WebPush][UI]";

function trace(...args: unknown[]) {
  console.log(WEB_PUSH_TRACE, ...args);
}

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
    trace("mergeNotifications", { incomingCount: incoming.length });
    if (incoming.length === 0) return;

    setNotifications((prev) => {
      const seen = new Set(prev.map((notification) => notification.id));
      const fresh = incoming.filter((notification) => !seen.has(notification.id));

      trace("merge result", {
        previousCount: prev.length,
        incomingCount: incoming.length,
        freshCount: fresh.length,
        freshIds: fresh.map((notification) => notification.id),
      });

      if (fresh.length === 0) return prev;
      return [...fresh.reverse(), ...prev];
    });

    afterRef.current = Math.max(
      afterRef.current,
      ...incoming.map((notification) => notification.id)
    );
    trace("afterRef updated", { after: afterRef.current });
  }, []);

  const loadHistory = useCallback(async () => {
    if (!userId) return;

    trace("history load started", { userId, after: 0 });
    try {
      const response = await api.listNotifications(userId, 0);
      trace("history load completed", {
        userId,
        count: response.notifications.length,
        nextAfter: response.nextAfter,
        ids: response.notifications.map((notification) => notification.id),
      });
      mergeNotifications(response.notifications);
      afterRef.current = Math.max(afterRef.current, response.nextAfter);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(WEB_PUSH_TRACE, "history load failed", { userId, message });
      setLastError(message);
    }
  }, [userId, mergeNotifications]);

  const recoverAfterPush = useCallback(async (notificationId?: number | null) => {
    if (!userId) return;

    const after = afterRef.current;
    trace("recovery started", { userId, notificationId: notificationId ?? null, after });
    try {
      const response = await api.listNotifications(userId, after);
      trace("recovery completed", {
        userId,
        notificationId: notificationId ?? null,
        requestedAfter: after,
        count: response.notifications.length,
        nextAfter: response.nextAfter,
        ids: response.notifications.map((notification) => notification.id),
      });
      mergeNotifications(response.notifications);
      afterRef.current = Math.max(afterRef.current, response.nextAfter);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(WEB_PUSH_TRACE, "recovery failed", {
        userId,
        notificationId: notificationId ?? null,
        after,
        message,
      });
      setLastError(message);
    }
  }, [userId, mergeNotifications]);

  const subscribe = useCallback(async () => {
    if (!userId) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      trace("subscribe unsupported", { userId });
      setStatus("unsupported");
      return;
    }

    try {
      setStatus("subscribing");
      setLastError(null);
      trace("subscribe started", { userId });

      const registration = await navigator.serviceWorker.register("/sw.js");
      trace("service worker registered", {
        userId,
        scope: registration.scope,
        active: Boolean(registration.active),
        controller: Boolean(navigator.serviceWorker.controller),
      });

      // BẮT BUỘC gọi trong ngữ cảnh user gesture (hàm này được gọi từ
      // onClick của nút "Bật thông báo đẩy" ở App.tsx).
      const permission = await Notification.requestPermission();
      trace("notification permission", { userId, permission });
      if (permission !== "granted") {
        setStatus("permission-denied");
        return;
      }

      const keyRes = await fetch(`${API_BASE_URL}/push/vapid-public-key`);
      const { publicKey } = await keyRes.json();
      trace("vapid public key fetched", { userId, available: Boolean(publicKey) });
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

      trace("push subscription created", {
        userId,
        endpoint: pushSubscription.endpoint,
      });

      await fetch(`${API_BASE_URL}/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          subscription: pushSubscription.toJSON(),
        }),
      });

      trace("push subscription registered on backend", { userId });
      setStatus("subscribed");
      await loadHistory();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(WEB_PUSH_TRACE, "subscribe failed", { userId, message });
      setLastError(message);
      setStatus("error");
    }
  }, [userId, loadHistory]);

  const unsubscribe = useCallback(async () => {
    try {
      trace("unsubscribe started", { userId });
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
      trace("unsubscribe completed", { userId, hadSubscription: Boolean(pushSubscription) });
      setStatus("idle");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(WEB_PUSH_TRACE, "unsubscribe failed", { userId, message });
      setLastError(message);
    }
  }, [userId]);

  useEffect(() => {
    if (!enabled || !userId) return;

    afterRef.current = 0;
    setNotifications([]);
    trace("web push enabled", { userId });
    void loadHistory();
  }, [enabled, userId, loadHistory]);

  useEffect(() => {
    if (!enabled || !userId || !("serviceWorker" in navigator)) return;

    const handleMessage = (event: MessageEvent<WebPushServiceWorkerMessage>) => {
      trace("service worker message received", {
        userId,
        type: event.data?.type,
        notificationId: event.data?.notificationId ?? null,
      });
      if (event.data?.type !== "notification") return;
      if (event.data.notificationId == null) {
        trace("service worker message ignored: missing notificationId", { userId });
        return;
      }
      void recoverAfterPush(event.data.notificationId);
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);
    trace("service worker message listener registered", {
      userId,
      controller: Boolean(navigator.serviceWorker.controller),
    });
    return () => {
      navigator.serviceWorker.removeEventListener("message", handleMessage);
      trace("service worker message listener removed", { userId });
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
