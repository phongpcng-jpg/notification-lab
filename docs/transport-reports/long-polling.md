# Transport Report: Long Polling

**Technique:** Long Polling

**Architecture:**
`GET /notifications/long-poll?userId=&after=&limit=`. Nếu đã có notification
(`id > after`) → trả ngay. Nếu chưa → giữ request mở, đăng ký chờ qua
`NotificationWaiters` (in-process pub/sub) tới khi có notification mới, hết
`LONG_POLL_TIMEOUT_MS` (mặc định 25s, cấu hình qua env), hoặc client tự ngắt
kết nối (`req.raw` `'close'` event). Dùng chung query/delivery-recording
helper (`notificationQueries.ts`) với Short Polling.

## Lifecycle được xử lý (theo yêu cầu Section 13)
| Case | Xử lý |
|---|---|
| Timeout server | `setTimeout` set `settledReason='timeout'`, sau đó re-query DB (rỗng) → trả `timedOut:true` |
| Timeout client | Client (`useLongPolling`) dùng `AbortController`; nếu abort chủ động thì không coi là lỗi/không retry |
| Cancellation | `stop()` gọi `abortRef.current?.abort()`, cleanup effect khi unmount/đổi user |
| Concurrent requests (cùng user) | `NotificationWaiters` hỗ trợ nhiều waiter/user, tất cả được đánh thức cùng lúc — có test riêng |
| Duplicate request | Không chặn — hệ quả là duplicate delivery, chấp nhận được vì at-least-once |
| Disconnected clients | Lắng nghe `req.raw.on('close', ...)`, dọn waiter qua `cancel()`, ghi `disconnect_reason='client_disconnect'` vào bảng `connections`, KHÔNG gọi `reply.send()` (tránh crash) |

## Strengths
- Độ trễ thấp hơn Short Polling đáng kể khi có event (trả gần như ngay, đo
  được qua `delivery_attempts.latency_ms` một khi benchmark chạy).
- Giảm mạnh số request "rỗng" so với short polling (chỉ 1 request treo thay
  vì N request/interval).
- Vẫn là HTTP thuần → tương thích proxy/firewall tốt hơn WebSocket.

## Weaknesses
- Phức tạp hơn short polling đáng kể: cần quản lý waiter registry, timeout,
  disconnect, concurrent requests (đã implement, nhưng là 4 lần khối lượng
  code so với short polling).
- **In-process waiter registry** — giới hạn quan trọng nhất: chỉ hoạt động
  đúng trong 1 Fastify instance. Multi-instance cần Redis Pub/Sub (ghi rõ
  trong `notificationWaiters.ts` và `docs/architecture.md`, out of scope
  hiện tại).
- Giữ request mở → tốn 1 socket/thread trong suốt thời gian chờ (tối đa 25s
  mặc định) — với nhiều user đồng thời, cần Node.js non-blocking I/O (có sẵn
  vì Fastify async), nhưng vẫn tốn file descriptor/memory hơn short polling.

## Implementation complexity
Trung bình. Route handler dùng `Promise.race` + polling nội bộ 25ms để phát
hiện timeout/disconnect đã xảy ra trong lúc `await` promise gốc — cách đơn
giản hóa có chủ đích, đánh đổi độ chính xác timing (~25ms sai số) lấy code
dễ hiểu hơn so với dùng thêm `AbortController` lồng nhau ở phía server.

## Testing
`backend/src/routes/longPolling.test.ts` — 5 integration test:
1. Trả ngay khi đã có data sẵn (không chờ tới timeout).
2. Giữ request mở, trả về đúng lúc có post mới xuất hiện giữa chừng.
3. Timeout đúng hạn (~300ms trong test, cấu hình qua `vitest.config.ts`) khi
   không có gì mới.
4. 2 long-poll request đồng thời cho cùng 1 user đều được đánh thức và nhận
   cùng 1 notification (duplicate delivery — chủ định).
5. Thiếu `userId` → 400.

**Chưa test được** (ghi rõ giới hạn, không giấu): client thật sự đóng kết nối
giữa chừng (`client_disconnect` path) — khó mô phỏng qua `fastify.inject()`
vì nó không simulate việc client abort request đang treo. Cần test thủ công
qua browser (đóng tab trong lúc đang long-poll) hoặc integration test dùng
`app.listen()` thật + `fetch` với `AbortController` — để ở benchmark/failure
test phase (Section 42 — Failure tests) thay vì unit test.

**Chưa chạy thật** trong sandbox này (không có network để `npm install`).

## Benchmark status
PENDING.

## Best suited for
Cần độ trễ thấp nhưng không có/không muốn setup hạ tầng WebSocket-aware
(proxy doanh nghiệp khó tính); dùng làm fallback khi SSE/WS bị chặn.

## Poorly suited for
Rất nhiều concurrent user với server không dùng non-blocking I/O tốt (không
áp dụng ở đây vì Fastify/Node.js đã async by default, nhưng vẫn là giới hạn
lý thuyết cần benchmark xác nhận ở quy mô lớn — Scenario E/C).

---

| Category | Assessment |
|---|---|
| Complexity | Trung bình |
| Latency | Gần tức thời khi có event (chưa đo số cụ thể — PENDING) |
| Throughput | Chưa đo (PENDING) |
| Scalability | Cần benchmark xác nhận số connection đồng thời tối đa trước khi kết luận |
| Reliability | At-least-once, có xử lý disconnect/timeout/concurrent rõ ràng |
| Browser support | Universal (chỉ cần `fetch`) |
| Infrastructure | Không cần thêm gì (single instance); cần Redis nếu multi-instance (chưa làm) |
| Operational complexity | Trung bình |
| Best use case | Độ trễ thấp, hạ tầng hạn chế, fallback cho WS/SSE |
