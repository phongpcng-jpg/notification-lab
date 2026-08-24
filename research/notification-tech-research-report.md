# Báo cáo nghiên cứu: Các kỹ thuật xây dựng Notification trên Web

> Phạm vi: đây là **báo cáo lý thuyết** (research report), chưa bao gồm code/POC. Mục tiêu là giúp team hiểu bản chất, ưu/nhược điểm, xu hướng sử dụng và cơ sở lựa chọn cho từng kỹ thuật. Các số liệu về xu hướng/thị phần/dự án thực tế đều có dẫn nguồn ở mục "Tham khảo" cuối mỗi phần; những chỗ không tìm được số liệu định lượng đáng tin cậy được ghi rõ là **qualitative/nhận định của cộng đồng kỹ thuật**, không phải số liệu khảo sát chính thức.

---

## 1. Notification là gì? Phân biệt với CRUD/Request-Response

Một hệ thống "notification" trên web **không phải là một công nghệ**, mà là sự kết hợp của 3 lớp độc lập:

| Lớp | Vai trò | Ví dụ |
|---|---|---|
| **Business event** | Sự kiện nghiệp vụ xảy ra trong hệ thống | `AppointmentCreated`, `TaskAssigned` |
| **Delivery mechanism (Communication)** | Cách server đưa thông tin đến client | Polling, Long Polling, SSE, WebSocket, Web Push |
| **Notification UI/Persistence** | Cách hiển thị & lưu trữ cho người dùng | Toast, badge unread, DB record, OS notification |

CRUD/request-response truyền thống là **client chủ động hỏi, server trả lời một lần rồi kết thúc**. Notification về bản chất là **server cần chủ động (hoặc gần như chủ động) đẩy thông tin về phía client mà client không hề yêu cầu tại đúng thời điểm đó** — đây là điểm khác biệt cốt lõi, vì giao thức HTTP nguyên bản được thiết kế theo mô hình pull (client hỏi trước), không phải push.

Do đó mọi kỹ thuật notification thực chất là các cách khác nhau để "giả lập" hoặc thực sự đạt được khả năng server→client push trên nền một giao thức vốn là pull-based (HTTP) hoặc dùng giao thức khác hỗ trợ push thật (WebSocket, Web Push).

---

## 2. Các kỹ thuật chính

### 2.1 Short Polling

**Mô tả:** Client gọi định kỳ (ví dụ mỗi 5–15 giây) một REST endpoint để hỏi "có gì mới không". Server trả lời ngay lập tức, dù có dữ liệu mới hay không.

**Đặc điểm nổi bật:**
- Không cần hạ tầng đặc biệt — chạy tốt trên mọi hosting, mọi proxy, mọi load balancer.
- Độ trễ = tối đa bằng khoảng polling interval.
- Số lượng request tăng tuyến tính theo số user × tần suất poll, phần lớn request trả về "không có gì mới" (empty response) → lãng phí băng thông và tải server.

**Ưu điểm:**
- Triển khai đơn giản nhất, dùng HTTP thuần, không cần thư viện.
- Hoạt động ổn định qua mọi firewall/proxy doanh nghiệp.
- Dễ debug (chỉ là REST call bình thường, `curl` được).
- Không cần giữ connection mở → không tốn socket/thread lâu dài trên server.

**Nhược điểm:**
- Overhead cao nhất trong các kỹ thuật (nhiều request rỗng).
- Độ trễ không thể thấp nếu muốn tiết kiệm tài nguyên (trade-off latency vs. cost).
- Không phù hợp khi cần "gần real-time" (<1s) ở quy mô lớn.

**Khi nên dùng:** thông báo không khẩn cấp, tần suất thay đổi dữ liệu thấp, môi trường hạ tầng hạn chế (serverless function timeout ngắn, free hosting, mobile network kém ổn định).

**Khi không nên dùng:** chat, dashboard tài chính, hệ thống cần độ trễ dưới vài giây với lượng user lớn.

---

### 2.2 Long Polling

**Mô tả:** Client gửi request, nhưng server **giữ request mở** (không trả lời ngay) cho đến khi có dữ liệu mới hoặc hết timeout. Khi có phản hồi (dữ liệu hoặc timeout), client lập tức mở lại một request mới.

**Đặc điểm nổi bật:**
- Giảm đáng kể số lượng request "rỗng" so với short polling, đồng thời độ trễ gần với real-time hơn (khi có event, response trả về gần như ngay lập tức).
- Về bản chất vẫn là HTTP request/response — tương thích proxy tốt hơn WebSocket.
- Server phải giữ connection/thread mở trong thời gian chờ → tốn tài nguyên hơn short polling nếu không dùng mô hình non-blocking I/O.

**Ưu điểm:**
- Độ trễ thấp hơn short polling đáng kể.
- Vẫn dùng HTTP thuần → tương thích hạ tầng cũ, proxy khó tính.
- Có thể làm fallback khi WebSocket/SSE không phù hợp, nhưng đây là lựa chọn kiến trúc chứ không phải một fallback bắt buộc của mọi WebSocket framework.

**Nhược điểm:**
- Lifecycle quản lý phức tạp hơn short polling: phải xử lý timeout server, timeout client, race condition khi nhiều request được mở đồng thời, dedupe event.
- Nếu server dùng mô hình thread-per-request (không async), số lượng long-polling connection đồng thời có thể làm cạn kiệt thread pool.
- Không có cơ chế chuẩn hóa qua trình duyệt (không có API native như `EventSource`/`WebSocket`) → phải tự viết retry logic.

**Khi nên dùng:** cần độ trễ thấp nhưng hạ tầng/mạng không đảm bảo hỗ trợ WebSocket/SSE; dùng làm fallback transport.

**Khi không nên dùng:** ứng dụng cần giao tiếp hai chiều liên tục, hoặc cần hàng nghìn kết nối đồng thời trên server không hỗ trợ non-blocking I/O tốt.

### 2.3 Server-Sent Events (SSE)

**Mô tả:** Client mở một kết nối HTTP duy nhất tới server với header `Accept: text/event-stream`; server giữ kết nối này mở và **liên tục stream** các sự kiện dạng text (`data: ...\n\n`) khi có dữ liệu mới. Chuẩn hóa qua HTML Living Standard, dùng qua `EventSource` API có sẵn trên trình duyệt.

**Đặc điểm nổi bật:**
- Một chiều: server → client. Client **không thể gửi dữ liệu qua cùng kết nối này**.
- `EventSource` có **auto-reconnect built-in**, hỗ trợ `Last-Event-ID` để phục hồi các event bị lỡ.
- Chạy trên HTTP/HTTPS thuần → dễ đi qua CDN, proxy, load balancer hơn WebSocket (không cần handshake upgrade đặc biệt), nhưng vẫn có rủi ro bị **buffer bởi proxy trung gian** trong một số mạng doanh nghiệp — cần header `X-Accel-Buffering: no` (Nginx) hoặc tương đương.
- Giới hạn lịch sử: qua HTTP/1.1, trình duyệt giới hạn 6 kết nối đồng thời/domain (nhiều tab cùng mở SSE tới cùng domain có thể bị nghẽn); qua HTTP/2 giới hạn này được giải quyết vì multiplexing.

**Ưu điểm:**
- Rất đơn giản để triển khai (không cần thư viện, ~30 dòng code cho use case cơ bản).
- Cơ chế reconnect + event-id built-in trong trình duyệt, giảm code phải tự viết.
- Hoạt động tốt qua HTTP/S tiêu chuẩn — không cần WebSocket-aware load balancer.
- Là lựa chọn phổ biến cho các workload streaming một chiều; một số API/SDK AI sử dụng streaming HTTP theo nhiều hình thức khác nhau. Không nên coi việc một nhà cung cấp sử dụng SSE là bằng chứng rằng SSE luôn là lựa chọn mặc định cho mọi streaming API.

**Nhược điểm:**
- Chỉ hỗ trợ text UTF-8, không gửi được binary trực tiếp (phải encode base64 nếu cần).
- Không có kênh client→server trên cùng kết nối (muốn gửi dữ liệu ngược lại phải mở request HTTP riêng).
- Một số browser/OS có thể hạn chế hoạt động background; cần thiết kế reconnect/recovery phù hợp.
- Một số hạ tầng serverless/edge có giới hạn thời gian streaming khiến kết nối dài hạn bị cắt giữa chừng; giới hạn cụ thể phụ thuộc platform và plan, nên cần kiểm tra tài liệu hiện hành thay vì coi các con số cố định là đặc tính của SSE.

**Khi nên dùng:** notification server→client một chiều khi browser đang mở (dashboard, live feed, activity feed).

**Khi không nên dùng:** cần client gửi dữ liệu trở lại real-time trên cùng kết nối (chat 2 chiều, game), cần truyền binary lớn.

### 2.4 WebSocket

**Mô tả:** Giao thức riêng (RFC 6455), bắt đầu bằng một HTTP handshake (`Upgrade: websocket`) rồi chuyển sang kết nối TCP **song công (full-duplex)** — cả client và server có thể gửi message bất kỳ lúc nào trên cùng một kết nối.

**Đặc điểm nổi bật:**
- Hai chiều thực sự và thường có latency thấp, nhưng **không có một con số cố định áp dụng cho mọi môi trường**. Latency thực tế phụ thuộc network RTT, server/client workload và implementation; không nên dùng một con số benchmark bên ngoài để kết luận WebSocket luôn nhanh hơn SSE.
- Phức tạp hơn đáng kể để vận hành production: cần tự quản lý reconnect, heartbeat (ping/pong) để phát hiện stale connection, xử lý multiple instance (một client kết nối vào server A, nhưng event lại phát sinh ở server B → cần cơ chế broadcast liên instance, thường dùng Redis Pub/Sub hoặc message broker).
- Cần load balancer/proxy hỗ trợ WebSocket upgrade; chiến lược sticky session hay pub/sub phụ thuộc kiến trúc và không phải deployment nào cũng cần cả hai.

**Ưu điểm:**
- Giao tiếp hai chiều thật, phù hợp cho tương tác liên tục tần suất cao (chat, collaborative editing, multiplayer game, typing indicator).
- Một kết nối phục vụ được cả gửi lẫn nhận, giảm số lượng HTTP request rời rạc.
- Hệ sinh thái thư viện trưởng thành (Socket.IO, ws, uWebSockets.js) hỗ trợ nhiều mức abstraction khác nhau.

**Nhược điểm:**
- Chi phí vận hành/độ phức tạp cao: heartbeat, reconnect logic, connection state, xử lý multi-instance.
- Không debug được bằng `curl` HTTP thông thường; cần công cụ WebSocket chuyên dụng.
- Với hosting có spin-down hoặc giới hạn connection, kết nối WebSocket có thể bị ngắt; client phải xử lý reconnect.
- Dễ bị dùng quá mức cho use case chỉ cần server→client một chiều, khiến hệ thống phức tạp hơn SSE mà không nhận được lợi ích full-duplex.

**Khi nên dùng:** giao tiếp hai chiều liên tục tần suất cao — chat, collaborative editing, multiplayer, presence/typing indicator, hoặc các protocol tương tác cần client gửi lệnh trong khi server đang stream.

**Khi không nên dùng:** khi nhu cầu thực tế chỉ là server đẩy thông báo một chiều — SSE thường đơn giản hơn và có thể đáp ứng tốt mà không cần full-duplex.

### 2.5 Web Push (Push API + Service Worker + Notification API)

Đây là nhóm kỹ thuật khác hẳn về bản chất so với 4 kỹ thuật trên: mục tiêu không phải "cập nhật UI khi tab đang mở" mà là **đưa thông báo tới người dùng ngay cả khi họ không mở trang web**, tương tự push notification trên mobile app.

**Các thành phần bắt buộc:**
1. **Service Worker** — một script chạy nền, độc lập với vòng đời của tab trình duyệt, bắt buộc phải chạy trên **secure context (HTTPS)**.
2. **Push API** — cho phép Service Worker đăng ký một `PushSubscription` (endpoint duy nhất do Push Service của trình duyệt cấp phát).
3. **VAPID (Voluntary Application Server Identification)** — cặp khóa public/private để application server tự xác thực với Push Service mà không cần đăng ký tài khoản với từng hãng.
4. **Notification API** — API để Service Worker hiển thị notification của OS.

**Ưu điểm:**
- Hoạt động ngay cả khi tab/browser không mở (tùy browser/OS và quyền user).
- Tiết kiệm pin/băng thông hơn so với giữ một WebSocket/SSE connection liên tục.
- Phù hợp cho notification quan trọng, background notification, reminder.

**Nhược điểm:**
- Setup phức tạp: HTTPS, Service Worker, permission UX, VAPID, Push Service.
- Delivery không deterministic — browser/OS có thể trì hoãn hoặc giới hạn push để tiết kiệm pin.
- Không phù hợp để stream dữ liệu liên tục hoặc chat real-time.
- Phụ thuộc browser/OS support và permission của user.

**Khi nên dùng:** notification cần tới user khi web app không foreground, reminder, mention, task assignment quan trọng.

**Khi không nên dùng:** realtime feed khi user đang mở tab, streaming liên tục, dữ liệu cần latency deterministic.

---

## 3. So sánh tổng quan

| Tiêu chí | Short Polling | Long Polling | SSE | WebSocket | Web Push |
|---|---|---|---|---|---|
| Hướng | C→S→C | C→S→C | S→C | C↔S | S→SW→User |
| Kết nối | Mỗi request | Giữ mở rồi reconnect | Persistent HTTP | Persistent TCP | Managed Push |
| Real-time | ⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ (không deterministic) |
| 2 chiều | ✗ | ✗ | ✗ | ✓ | ✗ |
| Binary | ✓ | ✓ | ✗ (text) | ✓ | Payload encrypted |
| Auto reconnect | Tự viết | Tự viết | Built-in | Tự viết | Managed by browser |
| Offline | ✗ | ✗ | ✗ | ✗ | ✓ |
| Độ phức tạp | ⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Firewall friendly | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

> Đây là **đánh giá định tính** để định hướng lựa chọn kiến trúc, không phải điểm benchmark của project.

---

## 4. Khi nào dùng kỹ thuật nào?

### Decision Tree

```text
                    Cần notification?
                           |
                          YES
                           |
              +------------+------------+
              |                         |
      Browser/tab có thể           User có thể offline/
      đang mở và active?            browser đóng?
              |                         |
             YES                       YES
              |                         |
       +------+-------+                 |
       |              |                 |
   Chỉ cần S→C?    C↔S hai chiều?       |
       |              |                 |
      YES            YES                |
       |              |                 |
      SSE          WebSocket        Web Push
       |
   Nếu không cần
   real-time cao
       |
   Short/Long Polling
```

---

## 5. Kết luận

Không có một kỹ thuật notification "tốt nhất" cho mọi trường hợp. Lựa chọn phụ thuộc vào:

- **Hướng giao tiếp:** one-way hay two-way.
- **Latency requirement:** vài giây hay vài trăm ms.
- **Offline requirement:** có cần notification khi browser đóng không.
- **Infrastructure:** proxy, load balancer, serverless limits.
- **Scale:** số lượng concurrent connections.
- **Complexity budget:** team có chấp nhận heartbeat/reconnect/multi-instance không.

Trong một production system, hoàn toàn có thể **kết hợp nhiều kỹ thuật**:

```text
                    Notification System
                           |
          +----------------+----------------+
          |                |                |
        SSE            Web Push        REST / DB
          |                |                |
    In-app realtime   Background       History / recovery
```

Ví dụ:
- User đang mở web → SSE để nhận notification realtime.
- User đã đóng web → Web Push để gửi notification quan trọng.
- User mở lại web → REST/DB để lấy notification history và phục hồi trạng thái.

Đây cũng là lý do project `notification-lab` implement cả 5 transport: mục tiêu không phải chứng minh một transport luôn thắng, mà là **hiểu trade-off và đo chúng trong cùng một application workload**.

---

## 6. Nguồn tham khảo

### Official / Standards

- WHATWG — Server-sent events / EventSource
- WHATWG — WebSockets
- W3C — Push API
- MDN — Server-sent events
- MDN — WebSocket API
- MDN — Push API
- RFC 6455 — The WebSocket Protocol
- RFC 8030 — Generic Event Delivery Using HTTP Push
- RFC 8292 — Voluntary Application Server Identification (VAPID) for Web Push

### Industry / Technical References

- Socket.IO documentation — transport/fallback discussion
- Fastify documentation — WebSocket support
- GitHub documentation / API references
- OpenAI, Anthropic and Google streaming API documentation
- Các nguồn bên thứ ba trong từng phần của report được dùng để bổ sung góc nhìn; chúng không được coi là authoritative benchmark data cho `notification-lab`.
