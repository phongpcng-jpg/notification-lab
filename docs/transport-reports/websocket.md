# Transport Report: WebSocket

**Technique:** WebSocket

**Architecture:**
`GET /ws?userId=&after=` — upgrade qua `@fastify/websocket` (dựa trên thư
viện `ws`, đúng ADR-001: không dùng Socket.IO để đo đúng hành vi WebSocket
thuần theo RFC 6455). Catch-up giống SSE (`after` param, không có cơ chế
`Last-Event-ID` built-in như SSE nên tự truyền qua query string). Đăng ký
subscription sống suốt kết nối qua `WsHub` (dùng chung `PushHub` với SSE).

**Đây là transport 2 CHIỀU DUY NHẤT trong 5 transport của project:**
Client gửi `{type:'ack', notificationId}` sau khi nhận mỗi notification →
server cập nhật `status='acknowledged'` (khác `'delivered'`) — thể hiện đúng
khả năng bidirectional mà 4 transport còn lại không có trên cùng 1 kết nối.

## Lifecycle được xử lý (theo yêu cầu Section 15)
| Case | Xử lý |
|---|---|
| Connection | Upgrade qua `@fastify/websocket`, ghi `connections` table (transport='websocket') |
| Authentication | Giống các transport khác — `userId` qua query param (đã ghi trong ADR: auth tối giản theo yêu cầu gốc, không phải OAuth/JWT thật) |
| Heartbeat/ping-pong | Server ping định kỳ (`WS_HEARTBEAT_MS`) ở TẦNG GIAO THỨC WS (không phải app-level message); nếu không có pong trước lần ping kế tiếp → `socket.terminate()` |
| Reconnect | Client tự làm (browser KHÔNG có built-in reconnect cho WebSocket, khác EventSource) — dùng lại `computeBackoffDelay` |
| Connection cleanup | `socket.on('close'/'error', cleanup)` → hủy subscription, clear heartbeat timer, ghi `disconnected_at`/`disconnect_reason` |
| Backpressure | Check `socket.bufferedAmount` trước khi gửi; vượt ngưỡng 1MB → bỏ gửi, ghi `delivery_attempts.result='failed'`, KHÔNG block event loop |
| Message ordering | Đảm bảo trong 1 kết nối (TCP + gửi tuần tự theo id ASC); KHÔNG đảm bảo giữa nhiều tab/kết nối của cùng 1 user |
| Duplicate messages | Có thể xảy ra khi reconnect với `after` cũ — client tự dedupe theo id (giống mọi transport khác trong project) |
| Graceful shutdown | `wsHub.closeAll()` gọi trong `server.ts` trước `app.close()`, gửi close code 1001 |
| Broadcasting | Không cần — domain chỉ yêu cầu targeted notification (1 user cụ thể), không có tính năng "gửi cho tất cả user" |
| Targeted notification | `wsHub.publish(recipientId, row)` — đúng đích, không phát tán thừa |

## Strengths
- Duy nhất hỗ trợ bidirectional thật — minh chứng bằng cơ chế ack.
- Heartbeat ở tầng giao thức, không tốn băng thông app-level như polling.
- Độ trễ lý thuyết thấp nhất (không có "chờ" ở giữa, giống SSE) — PENDING đo.

## Weaknesses
- Phức tạp vận hành cao nhất trong 5 transport: heartbeat, reconnect
  (client tự viết vì không có built-in), backpressure, cleanup — đúng đánh
  giá "Cao" trong bảng so sánh research report gốc.
- `WsHub` in-process — cùng giới hạn multi-instance như SSE/Long Polling.
  Với WebSocket, giới hạn này nghiêm trọng hơn vì WS thường được chọn khi
  cần scale lớn — ADR-001 đã ghi rõ Redis Pub/Sub là bước tiếp theo bắt
  buộc nếu multi-instance, out of scope hiện tại.
- Không debug được bằng `curl` — đã dùng thư viện `ws` làm test client thay
  vì `fastify.inject()` (không phù hợp cho protocol upgrade).
- Cần load balancer/proxy hỗ trợ WS-aware nếu deploy multi-instance sau này
  (chưa tới phase deploy).

## Implementation complexity
Cao nhất trong 4 transport đã làm — đúng dự đoán trong ADR-001 và research
report gốc.

## Testing
`backend/src/routes/websocket.test.ts` — dùng **thư viện `ws` thật** (thêm
làm devDependency) làm client, kết nối tới `app.listen({port:0})` thật
(không dùng `fastify.inject()` vì đây là protocol upgrade, inject không mô
phỏng được). 7 test: connected message, catch-up, realtime, **ack →
acknowledged** (test riêng cho tính bidirectional), reconnect với `after`,
cleanup vào bảng `connections`, thiếu `userId` → đóng kết nối code 1008.

**Chưa test được** (ghi rõ, không giấu):
- Heartbeat timeout/stale connection: thư viện `ws` ở phía client TỰ ĐỘNG
  trả `pong` khi nhận `ping` (đúng theo protocol), nên không thể mô phỏng
  "client không phản hồi" chỉ bằng cách dùng `ws` client bình thường — cần
  can thiệp sâu hơn (custom client giả không trả pong) hoặc test thủ công.
  Để dành cho benchmark Scenario F (Reconnection Storm).
- Backpressure thật sự (buffer đầy): khó trigger deterministic trên
  loopback localhost vì băng thông rất cao, buffer hiếm khi đầy trong test
  ngắn. Để dành cho benchmark Scenario G (Slow Client) với payload lớn +
  nhiều message dồn dập.

**Chưa chạy thật** trong sandbox này (không có network để `npm install`).

## Benchmark status
PENDING.

## Best suited for
Domain nào thực sự cần 2 chiều tần suất cao (không phải trường hợp chính
của project này, vốn chỉ cần server→client, nhưng đã implement đầy đủ theo
yêu cầu để so sánh thực nghiệm với SSE — đúng tinh thần "không kết luận
tuyệt đối, phải benchmark" của toàn bộ yêu cầu gốc).

## Poorly suited for
Chỉ cần thông báo 1 chiều đơn giản — SSE đạt được ~90% lợi ích với ít hơn
hẳn độ phức tạp vận hành (nhận định trong research report gốc, sẽ được
kiểm chứng lại bằng benchmark thực tế ở Phase 9, không mặc định đúng).

---

| Category | Assessment |
|---|---|
| Complexity | Cao |
| Latency | Lý thuyết thấp nhất — PENDING đo thật |
| Throughput | Chưa đo (PENDING) |
| Scalability | Cần Redis nếu multi-instance (chưa làm) |
| Reliability | At-least-once + ack thật (acknowledged) — mức delivery semantics chi tiết nhất trong 4 transport |
| Browser support | Tốt (WebSocket API chuẩn) |
| Infrastructure | Cần WS-aware proxy/LB nếu deploy multi-instance sau này |
| Operational complexity | Cao (heartbeat, reconnect tự viết, backpressure) |
| Best use case | Cần bidirectional thật (chat, collaborative editing, agent control) |
