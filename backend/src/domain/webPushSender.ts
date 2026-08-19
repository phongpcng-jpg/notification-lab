import webpush from "web-push";
import { getDb } from "../db/index.js";
import { notificationService } from "./notificationService.js";
import type { NotificationView, PushSubscriptionRecord } from "./types.js";

/**
 * WEB PUSH
 * ────────
 * Khác biệt hoàn toàn với 4 transport kia: không có "kết nối đang mở" —
 * client đăng ký 1 lần (`push_subscriptions`), sau đó server gửi qua PUSH
 * SERVICE trung gian (do trình duyệt vận hành: FCM cho Chrome, Mozilla
 * Autopush cho Firefox...), KHÔNG gửi trực tiếp tới browser. Vì vậy không
 * có "SseHub"/"WsHub" ở đây — chỉ có 1 hàm gửi, gọi mỗi khi có notification
 * mới, độc lập hoàn toàn với việc tab có đang mở hay không.
 *
 * VAPID đọc TRỰC TIẾP từ process.env (không qua `config` singleton) để có
 * thể set/unset trong lúc test (config vốn chỉ đọc env 1 lần lúc import
 * module, không phù hợp để test nhiều trạng thái VAPID khác nhau trong
 * cùng 1 process).
 */

export function getVapidConfig(): {
  publicKey: string;
  privateKey: string;
  subject: string;
} {
  return {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
    subject: process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
  };
}

let configuredWithKey: string | null = null;

function ensureVapidConfigured(): boolean {
  const { publicKey, privateKey, subject } = getVapidConfig();
  if (!publicKey || !privateKey) return false;
  if (configuredWithKey !== publicKey) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    configuredWithKey = publicKey;
  }
  return true;
}

/**
 * Gửi Web Push cho TẤT CẢ subscription còn hợp lệ của 1 notification.
 * KHÔNG throw — Web Push là "best-effort" theo đúng bản chất kỹ thuật (research
 * report mục 2.5), lỗi gửi cho 1 subscription không được làm hỏng luồng chính
 * (tạo post/fan-out notification vẫn phải thành công dù Web Push thất bại).
 */
export async function sendWebPushForNotification(
  row: NotificationView & { recipient_id: number }
): Promise<void> {
  if (!ensureVapidConfigured()) {
    // Web Push là optional/chưa cấu hình — bỏ qua, không log ồn ào mỗi lần.
    return;
  }

  const db = getDb();
  const subs = db
    .prepare(
      `SELECT * FROM push_subscriptions WHERE user_id = ? AND invalid_at IS NULL`
    )
    .all(row.recipient_id) as PushSubscriptionRecord[];

  if (subs.length === 0) return;

  const payload = JSON.stringify({
    title: `${row.actor_display_name} vừa đăng bài mới`,
    body: row.script_preview ?? "",
    notificationId: row.id,
    postId: row.post_id,
  });

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payload
      );
      notificationService.markDelivered(row.id);
      notificationService.recordDeliveryAttempt({
        notificationId: row.id,
        transport: "web_push",
        result: "success",
      });
      db.prepare(
        `UPDATE push_subscriptions SET last_seen_at = unixepoch() WHERE id = ?`
      ).run(sub.id);
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number } | undefined)
        ?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        // Subscription hết hạn/không còn hợp lệ — dọn để không gửi lại vô ích
        // (đúng yêu cầu: "server phải xử lý lỗi 404/410 khi gửi và tự dọn
        // subscription cũ" trong research report mục 2.5).
        db.prepare(
          `UPDATE push_subscriptions SET invalid_at = unixepoch() WHERE id = ?`
        ).run(sub.id);
        notificationService.recordDeliveryAttempt({
          notificationId: row.id,
          transport: "web_push",
          result: "failed",
          errorReason: `subscription expired (HTTP ${statusCode})`,
        });
      } else {
        notificationService.recordDeliveryAttempt({
          notificationId: row.id,
          transport: "web_push",
          result: "failed",
          errorReason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
