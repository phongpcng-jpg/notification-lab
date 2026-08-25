import webpush from "web-push";
import { getDb } from "../db/index.js";
import { notificationService } from "./notificationService.js";
import type { NotificationView, PushSubscriptionRecord } from "./types.js";

const WEB_PUSH_TRACE = "[WebPush][BE]";

function trace(...args: unknown[]) {
  console.log(WEB_PUSH_TRACE, ...args);
}

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

export async function sendWebPushForNotification(
  row: NotificationView & { recipient_id: number }
): Promise<void> {
  trace("send started", { notificationId: row.id, recipientId: row.recipient_id, postId: row.post_id });

  if (!ensureVapidConfigured()) {
    trace("send skipped: VAPID not configured", { notificationId: row.id });
    return;
  }

  const db = getDb();
  const subs = db
    .prepare(`SELECT * FROM push_subscriptions WHERE user_id = ? AND invalid_at IS NULL`)
    .all(row.recipient_id) as PushSubscriptionRecord[];

  trace("subscriptions loaded", { notificationId: row.id, recipientId: row.recipient_id, count: subs.length });
  if (subs.length === 0) return;

  const payload = JSON.stringify({
    title: `${row.actor_display_name} vừa đăng bài mới`,
    body: row.script_preview ?? "",
    notificationId: row.id,
    postId: row.post_id,
  });

  for (const sub of subs) {
    try {
      trace("sendNotification started", { notificationId: row.id, subscriptionId: sub.id });
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      trace("sendNotification succeeded", { notificationId: row.id, subscriptionId: sub.id });

      notificationService.markDelivered(row.id);
      notificationService.recordDeliveryAttempt({ notificationId: row.id, transport: "web_push", result: "success" });
      db.prepare(`UPDATE push_subscriptions SET last_seen_at = unixepoch() WHERE id = ?`).run(sub.id);
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number } | undefined)?.statusCode;
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(WEB_PUSH_TRACE, "sendNotification failed", {
        notificationId: row.id, subscriptionId: sub.id, statusCode: statusCode ?? null, error: errorMessage,
      });

      if (statusCode === 404 || statusCode === 410) {
        db.prepare(`UPDATE push_subscriptions SET invalid_at = unixepoch() WHERE id = ?`).run(sub.id);
        notificationService.recordDeliveryAttempt({
          notificationId: row.id, transport: "web_push", result: "failed",
          errorReason: `subscription expired (HTTP ${statusCode})`,
        });
      } else {
        notificationService.recordDeliveryAttempt({
          notificationId: row.id, transport: "web_push", result: "failed", errorReason: errorMessage,
        });
      }
    }
  }
}
