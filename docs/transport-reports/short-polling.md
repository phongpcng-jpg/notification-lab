# Transport Report: Short Polling

**Technique:** Short Polling

**Architecture:**
Client gọi `GET /notifications/poll?userId=&after=&limit=` định kỳ. Server trả
lời ngay lập tức, không giữ request mở. Cursor (`after`) do **client** giữ và
tự truyền lên mỗi lần, server không dùng `status` để quyết định trả gì —
tránh mất dữ liệu nếu client rớt kết nối trước khi xử lý xong response cũ
(xem chi tiết trong comment đầu file `backend/src/routes/shortPolling.ts`).

**Use case (trong project này):** hiển thị notification khi user đang mở tab
app, chấp nhận độ trễ tối đa = `suggestedIntervalMs` (mặc định 5000ms, cấu
hình qua `SHORT_POLL_INTERVAL_MS`).

## Strengths
- Không cần hạ tầng đặc biệt, không cần WebSocket-aware proxy.
- Stateless ở tầng server (không giữ connection) → dễ scale ngang, không cần
  sticky session.
- Debug dễ: `curl http://localhost:3000/notifications/poll?userId=1&after=0`.
- Cursor-based (id) thay vì status-based → đạt at-least-once delivery mà
  không cần cơ chế ack riêng.

## Weaknesses
- Overhead: mỗi user tạo 1 request/interval kể cả khi không có gì mới —
  phần lớn response sẽ có `notifications: []`.
- Độ trễ tối đa = `suggestedIntervalMs`, không thể "gần tức thời" nếu muốn
  giữ tải server thấp.
- Client phải tự dedupe theo `id` (do at-least-once) — logic không phức tạp
  nhưng là trách nhiệm thêm cho client.

## Implementation complexity
Thấp. ~70 dòng route handler, ~110 dòng React hook (phần lớn là backoff +
lifecycle cleanup, không phải logic nghiệp vụ).

## Infrastructure
Không cần gì thêm ngoài Fastify + SQLite đã có sẵn từ Phase 1.

## Delivery semantics
**At-least-once.** Server không bao giờ tự ý bỏ sót notification trong
khoảng `(after, latest]`; nhưng có thể gửi trùng nếu client poll lại với
`after` cũ (do lỗi/retry). Đã unit test 2 trường hợp: (1) không lặp lại khi
cursor tiến đúng, (2) có lặp lại khi client cố tình poll lại với `after` cũ.

## Testing
- `backend/src/routes/shortPolling.test.ts` — 5 integration test (fastify
  `.inject()`, SQLite in-memory): fan-out đúng follower, cursor tiến đúng,
  at-least-once khi retry, không rò rỉ notification sang user không follow,
  400 khi thiếu `userId`.
- `frontend/src/transports/backoff.test.ts` — 4 unit test cho backoff thuần
  (exponential, cap ở maxMs, không âm, xử lý attempt âm).
- **Chưa chạy được thật** trong sandbox này (không có network để
  `npm install`). Cần bạn chạy `npm test` ở cả `backend/` và `frontend/`
  trên máy có mạng để xác nhận pass.

## Benchmark status
**PENDING — chưa chạy.** Sẽ đo ở Phase 9+ cùng các transport khác, dùng
chung benchmark runner, cùng workload (Rule 28 — benchmark fairness).

## Best suited for
Thông báo không cần độ trễ dưới ~1s, ưu tiên đơn giản/rẻ hạ tầng, hoặc làm
fallback cuối cùng khi mọi transport khác bị chặn.

## Poorly suited for
Chat, dashboard cần cập nhật gần tức thời, hệ thống có rất nhiều user đồng
thời nhạy cảm với chi phí request rỗng.

---

| Category | Assessment |
|---|---|
| Complexity | Thấp |
| Latency | = suggestedIntervalMs (mặc định 5s), chưa đo thực tế |
| Throughput | Chưa đo (PENDING) |
| Scalability | Tốt về mặt lý thuyết (stateless), chưa benchmark xác nhận |
| Reliability | At-least-once theo thiết kế, client tự dedupe |
| Browser support | Universal (chỉ cần `fetch`) |
| Infrastructure | Không cần gì thêm |
| Operational complexity | Thấp |
| Best use case | Notification không khẩn, ưu tiên đơn giản |
