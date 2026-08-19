import { useCallback, useState } from "react";

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

/**
 * WEB PUSH client.
 *
 * Khác biệt lớn nhất so với 4 hook kia: KHÔNG có "subscribe tự động khi
 * chọn transport". Trình duyệt yêu cầu `Notification.requestPermission()`
 * phải xuất phát từ 1 user gesture (click) ở phần lớn trình duyệt hiện đại
 * — không thể tự động hoá bằng useEffect khi component mount. Vì vậy UI
 * phải có nút bấm rõ ràng ("Bật thông báo đẩy"), gọi `subscribe()`.
 *
 * Cũng KHÔNG có danh sách notification hiển thị trong panel này — vì đúng
 * bản chất Web Push, notification hiện ra qua OS-level Notification API
 * (trong Service Worker), không đi qua React state. Panel chỉ hiển thị
 * trạng thái subscription.
 */
export function useWebPush(userId: number | null) {
  const [status, setStatus] = useState<WebPushStatus>("idle");
  const [lastError, setLastError] = useState<string | null>(null);

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

      const keyRes = await fetch("/api/push/vapid-public-key");
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

      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          subscription: pushSubscription.toJSON(),
        }),
      });

      setStatus("subscribed");
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [userId]);

  const unsubscribe = useCallback(async () => {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const pushSubscription = await registration?.pushManager.getSubscription();
      if (pushSubscription) {
        await fetch("/api/push/unsubscribe", {
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

  return { status, lastError, subscribe, unsubscribe };
}
