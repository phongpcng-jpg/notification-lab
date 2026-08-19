/**
 * NotificationWaiters — registry in-memory, cho phép route Long Polling
 * "chờ" tới khi có notification mới cho 1 userId cụ thể, thay vì phải tự
 * polling DB trong lúc giữ request mở.
 *
 * GIỚI HẠN QUAN TRỌNG (ghi rõ vì đây là điểm khác biệt với production thật):
 * Đây là in-process pub/sub — chỉ hoạt động đúng trong 1 Fastify instance.
 * Nếu chạy nhiều instance (multi-instance), notification được tạo ở instance A
 * sẽ KHÔNG đánh thức được waiter đang chờ ở instance B. Muốn multi-instance
 * cần Redis Pub/Sub hoặc message broker (đã ghi trong research report, mục 2.4
 * và trong docs/architecture.md) — out of scope ở phase hiện tại.
 *
 * Hỗ trợ nhiều waiter cùng lúc cho 1 userId (concurrent long-poll requests) —
 * khi notify() được gọi, TẤT CẢ waiter của userId đó đều được đánh thức, dẫn
 * tới khả năng cả hai cùng trả về cùng 1 notification cho client (duplicate
 * delivery) — đây là hành vi CHỦ ĐỊNH, chấp nhận được vì delivery semantics
 * của toàn bộ hệ thống là at-least-once (client tự dedupe theo id).
 */

type Waiter = () => void;

class NotificationWaiters {
  private waiters = new Map<number, Set<Waiter>>();

  /**
   * Đăng ký chờ notification mới cho userId. Trả về promise sẽ resolve khi
   * notify(userId) được gọi, và hàm cancel() để hủy đăng ký (dùng khi timeout
   * hoặc client disconnect, tránh leak waiter không bao giờ được dọn).
   */
  waitFor(userId: number): { promise: Promise<void>; cancel: () => void } {
    let resolveFn!: Waiter;
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });

    if (!this.waiters.has(userId)) {
      this.waiters.set(userId, new Set());
    }
    const set = this.waiters.get(userId)!;
    set.add(resolveFn);

    const cancel = () => {
      set.delete(resolveFn);
      if (set.size === 0) {
        this.waiters.delete(userId);
      }
    };

    return { promise, cancel };
  }

  /** Đánh thức toàn bộ waiter đang chờ userId này. */
  notify(userId: number): void {
    const set = this.waiters.get(userId);
    if (!set || set.size === 0) return;
    // Copy trước khi iterate vì resolve() có thể trigger cancel() đồng bộ
    // (nếu code gọi await promise rồi cancel ngay sau đó), làm set bị mutate
    // giữa lúc đang for-of.
    const resolvers = Array.from(set);
    for (const resolve of resolvers) resolve();
  }

  /** Chỉ dùng cho test: biết hiện có bao nhiêu waiter đang chờ 1 user. */
  waiterCount(userId: number): number {
    return this.waiters.get(userId)?.size ?? 0;
  }
}

export const notificationWaiters = new NotificationWaiters();
