# Transport Report: Server-Sent Events (SSE)

**Technique:** SSE

**Architecture:**
`GET /notifications/stream?userId=&lastEventId=`. Server dùng `reply.hijack()`
để tự quản lý `reply.raw` (Fastify không tự gửi response nữa), viết header
`Content-Type: text/event-stream`, `X-Accel-Buffering: no` (tắt buffer ở
Nginx nếu có). Sau đó: (1) catch-up mọi notification bị lỡ, (2) đăng ký
subscription sống suốt đời kết nối qua `SseHub`, (3) heartbeat định kỳ giữ
kết nối "sống" qua proxy, (4) cleanup khi client đóng kết nối.

**Điểm khác biệt kiến trúc quan trọng so với Long Polling:**
Long Polling dùng `NotificationWaiters` — 1 waiter chỉ **resolve một lần**
rồi bị hủy. SSE dùng `SseHub` — 1 subscription **sống liên tục**, nhận nhiều
event theo thời gian mà không cần client mở lại request. Đây là lý do 2 module
domain tách riêng dù ý tưởng pub/sub tương tự nhau (không dùng chung để tránh
một abstraction gượng ép giữa 2 lifecycle khác bản chất — đúng nguyên tắc
"không over-abstract nếu làm mất fidelity" trong yêu cầu gốc).

## Strengths
- Client cực đơn giản: dùng `EventSource` built-in, KHÔNG cần tự viết
  reconnect/backoff (khác hẳn 2 transport trước) — trình duyệt tự làm, và tự
  gửi `Last-Event-ID` khi reconnect để server catch-up đúng chỗ.
- 1 kết nối phục vụ nhiều event liên tục, không tốn request mới mỗi lần.
- Latency lý thuyết thấp nhất trong 3 transport đã làm (server đẩy ngay khi
  có notification, không có "chờ" nào ở giữa) — **chưa benchmark để xác nhận
  con số cụ thể (PENDING)**.

## Weaknesses
- Một chiều tuyệt đối: client hoàn toàn không gửi được gì qua kết nối này
  (đã đúng như research report mô tả) — muốn "mark as read" vẫn phải gọi
  REST `/notifications/:id/read` riêng (route đã có từ Phase 1).
- `SseHub` in-process — cùng giới hạn multi-instance như `NotificationWaiters`.
- Cần `reply.hijack()` — thoát khỏi lifecycle bình thường của Fastify, nghĩa
  là error handling/logging mặc định của Fastify không còn áp dụng cho
  route này, phải tự xử lý lỗi thủ công (đã làm qua `req.raw.on('error', cleanup)`).
- Giữ 1 socket mở/user liên tục — chi phí giống Long Polling nhưng KHÔNG có
  giới hạn thời gian timeout tự nhiên (Long Polling tự đóng sau
  `LONG_POLL_TIMEOUT_MS`, SSE thì mở tới khi client/server chủ động đóng).

## Implementation complexity
Thấp–Trung bình. Phần khó nhất không phải logic nghiệp vụ mà là quản lý
raw HTTP response đúng cách (`hijack()`, `writeHead`, heartbeat, cleanup) —
khớp với đánh giá "Thấp–Trung bình" trong bảng so sánh ở research report gốc.

## Testing
`backend/src/routes/sse.test.ts` — dùng **`app.listen({port:0})` thật** +
client HTTP thuần (`node:http`), KHÔNG dùng `fastify.inject()`, vì `inject()`
không phù hợp để test luồng phản hồi vô hạn (route sẽ treo mãi chờ response
kết thúc). Đây là lựa chọn kỹ thuật có chủ đích, ghi rõ trong comment đầu
file test.

5 test: (1) catch-up khi connect với notification có sẵn, (2) nhận realtime
sau khi đã connect, (3) reconnect với `lastEventId` không nhận lại
notification cũ, (4) cleanup ghi đúng vào bảng `connections` khi client đóng
kết nối, (5) thiếu `userId` → 400.

**Chưa test được:** hành vi thật của `EventSource` trên trình duyệt (auto-
reconnect, xử lý khi tab chuyển background trên iOS Safari — vấn đề đã nêu
trong research report 2.3) — cần test thủ công trên browser thật, không thể
test bằng Node.js client thuần vì đó là hành vi của trình duyệt, không phải
của giao thức SSE.

**Chưa chạy thật** trong sandbox này (không có network để `npm install`).

## Benchmark status
PENDING.

## Best suited for
Đúng use case chính của project này: đẩy notification server→client một
chiều khi user đang mở tab — khớp với khuyến nghị "mặc định" trong research
report gốc (mục 4.5).

## Poorly suất for
Cần gửi dữ liệu ngược từ client trong cùng kết nối; cần truyền binary lớn;
hosting serverless có giới hạn thời gian streaming ngắn (đã ghi trong
research report, chưa kiểm chứng lại vì phase deploy chưa tới).

---

| Category | Assessment |
|---|---|
| Complexity | Thấp–Trung bình |
| Latency | Lý thuyết thấp nhất trong 3 transport đã làm — PENDING đo thật |
| Throughput | Chưa đo (PENDING) |
| Scalability | Cần Redis nếu multi-instance (chưa làm); 1 kết nối/user liên tục |
| Reliability | At-least-once (catch-up theo lastEventId), reconnect do browser tự lo |
| Browser support | Tốt (không hỗ trợ ở IE cũ — không liên quan ở đây) |
| Infrastructure | Cần chú ý cấu hình buffer nếu có reverse proxy (đã set `X-Accel-Buffering`) |
| Operational complexity | Trung bình (quản lý raw response, hijack) |
| Best use case | Notification server→client 1 chiều, tab đang mở |
