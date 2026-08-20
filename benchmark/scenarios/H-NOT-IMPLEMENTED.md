# Scenario H — Poor Network — CHƯA IMPLEMENT

**Không có file `H.json`** — cố tình, không phải thiếu sót.

## Vì sao không thể implement bằng Node.js thuần

Scenario H yêu cầu mô phỏng: high latency, packet loss, unstable connection,
intermittent disconnect. Đây là các điều kiện ở **tầng mạng (network layer)**,
không phải tầng ứng dụng — một Node.js client bình thường (`fetch`, `ws`,
`http.request`) không có khả năng tự làm rớt gói tin hay thêm độ trễ giả vào
chính kết nối TCP của nó một cách trung thực. Cố "giả lập" bằng cách tự thêm
`setTimeout` trước khi gửi/nhận (giống cách Scenario G mô phỏng "xử lý chậm")
sẽ cho ra kết quả **sai lệch, không phản ánh đúng bản chất vấn đề mạng thật**
(ví dụ: mất gói tin giữa chừng khiến TCP phải retransmit, khác hẳn với việc
code chỉ đơn giản "chờ lâu hơn rồi mới gửi").

Làm sai ở đây vi phạm trực tiếp Rule 51 (No Fake Benchmark) nếu trình bày kết
quả như thể đó là hành vi mạng thật.

## Cách làm đúng (cần công cụ ngoài Node.js)

Để test scenario này đúng cách, cần một trong các công cụ sau, chạy Ở TẦNG HỆ
ĐIỀU HÀNH/MẠNG (ngoài phạm vi code trong repo này):

- **Linux**: `tc netem` (traffic control) — có thể thêm delay/loss/jitter cho
  1 interface hoặc 1 port cụ thể một cách trung thực ở tầng kernel.
- **Toxiproxy** (Shopify) — proxy TCP có thể chèn latency/timeout/bandwidth
  limit/connection reset giữa client và server, điều khiển được qua API,
  phù hợp để tích hợp vào benchmark runner sau này nếu cần.
- **Clumsy** (Windows) — tương tự `tc netem` nhưng cho Windows.

## Đề xuất nếu cần scenario này trong tương lai

1. Cài Toxiproxy, đặt nó làm proxy trung gian giữa `benchmark/generators/*`
   và backend thật (thay vì gọi thẳng `BENCHMARK_API_BASE_URL=localhost:3000`,
   trỏ về `localhost:<toxiproxy-port>`).
2. Viết 1 script nhỏ gọi Toxiproxy API để bật/tắt "toxic" (latency, packet
   loss) theo lịch trình trong lúc benchmark chạy — tương tự cách
   `reconnectStorm` đã lên lịch sự kiện trong `runners/run.ts`.
3. Chạy lại 4 transport qua `compareTransports.ts` với proxy này để so sánh
   khả năng chịu lỗi mạng thực sự giữa các transport.

Đây là việc nằm ngoài phạm vi "framework JavaScript thuần" của phase hiện tại
— cần xác nhận với bạn trước khi thêm dependency vào 1 công cụ ngoài (Toxiproxy)
nếu muốn làm scenario này trong tương lai.
