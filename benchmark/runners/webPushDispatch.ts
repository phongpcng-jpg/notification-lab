/**
 * Web Push KHÔNG chạy qua `run.ts` như 4 transport kia — lý do đã ghi trong
 * benchmark/README.md. Script này đo được PHẦN DUY NHẤT có thể đo tự động mà
 * không cần browser thật: thời gian + tỷ lệ thành công khi server gọi
 * `webpush.sendNotification()` (gửi TỚI Push Service, không phải tới browser).
 *
 * YÊU CẦU: đã có ít nhất 1 subscription thật trong bảng `push_subscriptions`
 * (tức là bạn đã tự bật Web Push qua UI trên 1 trình duyệt thật trước đó).
 * Script này KHÔNG tự tạo subscription giả — subscription giả (p256dh/auth
 * không hợp lệ) sẽ khiến `web-push` throw lỗi mã hoá trước khi kịp gửi,
 * không đo được gì có ý nghĩa.
 *
 * Đo được: server-side dispatch latency, success/failure rate theo Push
 * Service thật.
 * KHÔNG đo được: liệu Service Worker có thực sự nhận và hiển thị notification
 * hay không — chỉ quan sát được bằng mắt trên trình duyệt thật.
 */
import { checkHealth, createPost } from "../lib/apiClient.js";
import { computePercentiles } from "../lib/metrics.js";

function parseArgs(): Record<string, string> {
  return Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...rest] = a.replace(/^--/, "").split("=");
      return [k, rest.join("=")];
    })
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  const authorId = Number(args.authorId);
  const postCount = Number(args.posts ?? 10);
  const intervalMs = Number(args.intervalMs ?? 2000);

  if (!authorId) {
    console.error(
      "Thiếu --authorId=<id>. Đây phải là user MÀ người đã subscribe Web Push " +
        "đang follow (để notification thật sự được tạo và gửi)."
    );
    process.exit(1);
  }

  const healthy = await checkHealth();
  if (!healthy) {
    console.error("Backend không phản hồi tại /health.");
    process.exit(1);
  }

  console.log(
    `Tạo ${postCount} post từ user#${authorId}, cách nhau ${intervalMs}ms.\n` +
      "Kiểm tra log backend (npm run dev) để xem [webPush] có gửi thành công không, " +
      "và kiểm tra trình duyệt đã subscribe để xem notification thật có hiện ra không."
  );

  const dispatchLatenciesMs: number[] = [];
  for (let i = 0; i < postCount; i++) {
    const startedAt = Date.now();
    await createPost(authorId, `Web Push dispatch benchmark post #${i + 1}`);
    // Lưu ý: latency đo ở đây là thời gian route /posts xử lý xong, KHÔNG
    // phải thời gian webpush.sendNotification() hoàn tất — vì việc gửi push
    // chạy fire-and-forget trong notificationService listener (xem app.ts),
    // không nằm trong response time của /posts. Muốn đo đúng dispatch latency
    // thật, cần xem delivery_attempts.latency_ms trong DB sau khi chạy xong
    // (query thủ công hoặc thêm endpoint riêng nếu cần — chưa làm ở bước này).
    dispatchLatenciesMs.push(Date.now() - startedAt);
    if (i < postCount - 1) await sleep(intervalMs);
  }

  const stats = computePercentiles(dispatchLatenciesMs);
  console.log("\nThời gian response của POST /posts (KHÔNG phải dispatch latency thật):");
  console.log(stats);
  console.log(
    "\nĐể xem dispatch latency/kết quả gửi THẬT của Web Push, query trực tiếp:\n" +
      "  SELECT * FROM delivery_attempts WHERE transport='web_push' ORDER BY id DESC LIMIT 20;\n" +
      "trên file DB (backend/data/notification-lab.db) sau khi chạy xong."
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
