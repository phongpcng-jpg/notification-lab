import type { NotificationView } from "./types.js";

/**
 * PushHub<TSub> — dùng chung cho SSE và WebSocket vì cả 2 có cùng lifecycle:
 * 1 subscription đăng ký MỘT LẦN khi kết nối mở, rồi SỐNG SUỐT thời gian kết
 * nối để nhận nhiều event liên tục — khác hẳn NotificationWaiters (Long
 * Polling) vốn resolve đúng 1 lần rồi bị hủy ngay.
 *
 * Generic theo TSub để mỗi transport có thể đính kèm dữ liệu riêng (ví dụ
 * WebSocket cần giữ tham chiếu tới `socket` để publish/heartbeat, SSE chỉ
 * cần closure `onNotification`/`forceClose`).
 *
 * Giới hạn (nhắc lại, áp dụng cho mọi hub loại này trong project):
 * in-process, không hoạt động qua nhiều Fastify instance.
 */
export interface PushSubscriptionBase {
  onNotification: (row: NotificationView) => void;
  forceClose: () => void;
}

export class PushHub<TSub extends PushSubscriptionBase = PushSubscriptionBase> {
  private subscriptions = new Map<number, Set<TSub>>();

  subscribe(userId: number, sub: TSub): () => void {
    if (!this.subscriptions.has(userId)) {
      this.subscriptions.set(userId, new Set());
    }
    const set = this.subscriptions.get(userId)!;
    set.add(sub);

    return () => {
      set.delete(sub);
      if (set.size === 0) this.subscriptions.delete(userId);
    };
  }

  publish(userId: number, row: NotificationView): void {
    const set = this.subscriptions.get(userId);
    if (!set) return;
    for (const sub of set) {
      try {
        sub.onNotification(row);
      } catch (err) {
        console.error("[PushHub] subscriber threw while receiving event:", err);
      }
    }
  }

  /** Dùng cho graceful shutdown. */
  closeAll(): void {
    for (const set of this.subscriptions.values()) {
      for (const sub of set) {
        try {
          sub.forceClose();
        } catch {
          // đã đóng hoặc lỗi khi đóng — bỏ qua, không được làm crash shutdown
        }
      }
    }
  }

  subscriberCount(userId: number): number {
    return this.subscriptions.get(userId)?.size ?? 0;
  }

  totalSubscriberCount(): number {
    let total = 0;
    for (const set of this.subscriptions.values()) total += set.size;
    return total;
  }
}
