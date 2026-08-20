# Scenario H — Poor Network (dùng Toxiproxy)

**Trạng thái: đã implement, CHƯA CÓ LẦN CHẠY THẬT** (cùng lý do với mọi
benchmark khác trong repo — sandbox viết code không có network).

## Vì sao dùng Toxiproxy thay vì tự viết delay/loss trong code

Đã thử và từ bỏ cách "tự thêm `setTimeout` giả lập độ trễ" — cách đó **sai về
bản chất**: mất gói tin/độ trễ mạng là hiện tượng ở tầng TCP/network, không
phải tầng code JS phía trên. Toxiproxy là 1 proxy TCP thật, chèn latency/ngắt
kết nối THẬT vào luồng dữ liệu thật, nên kết quả đo được phản ánh đúng hành
vi mạng kém, không phải số liệu bịa.

## Thiết kế độc lập — chỉ Scenario H cần Toxiproxy

- **`runners/run.ts`, `runners/compareTransports.ts`, `runners/webPushDispatch.ts`
  hoàn toàn KHÔNG import bất cứ thứ gì liên quan Toxiproxy.** Chạy các scenario
  A-G, I, J như bình thường, không cần Toxiproxy chạy, không bị ảnh hưởng bởi
  việc Toxiproxy có cài hay không.
- Chỉ `runners/runNetworkScenario.ts` import `lib/toxiproxyClient.ts`.
- Cơ chế: `lib/apiClient.ts` có `setApiBaseUrl()`/`resetApiBaseUrl()` — mặc
  định các client vẫn gọi thẳng backend (`localhost:3000`). CHỈ khi
  `runNetworkScenario.ts` chủ động gọi `setApiBaseUrl('http://localhost:8666')`
  (địa chỉ Toxiproxy lắng nghe) thì mọi request mới đi qua proxy. Sau khi
  chạy xong, `resetApiBaseUrl()` được gọi trong khối `finally` — đảm bảo dù
  scenario lỗi giữa chừng, trạng thái vẫn được dọn sạch, không ảnh hưởng lần
  chạy scenario khác sau đó trong cùng tiến trình.
- `runNetworkScenario.ts` tái sử dụng NGUYÊN VẸN `runScenario()` từ `run.ts`
  — không có logic orchestrate riêng, chỉ "bọc" thêm bước setup/dọn proxy ở
  ngoài. Toàn bộ logic connect/post-generator/metrics giống hệt 9 scenario kia.

## Cách chạy

```bash
# 1. Cài Toxiproxy (đã cài theo bạn xác nhận), chạy server:
toxiproxy-server
# mặc định lắng nghe Admin API ở http://localhost:8474

# 2. Chạy backend như bình thường (KHÔNG cần biết gì về Toxiproxy):
cd backend && npm run dev

# 3. Chạy Scenario H:
cd benchmark
npm run run-network -- --scenario=H --transport=sse
```

Nếu Toxiproxy chưa chạy, lệnh trên báo lỗi rõ ràng và dừng ngay — không chạy
sai/chạy thiếu toxic mà không cảnh báo.

## Toxic mặc định trong `H.json`

| Toxic | Loại | Khi nào bật | Ý nghĩa |
|---|---|---|---|
| `h-latency` | `latency` (400ms ± 150ms jitter) | Suốt scenario | Mạng chậm liên tục |
| `h-reset-peer` | `reset_peer` (5% kết nối mới) | Chỉ từ giây 20 tới giây 35 | Giai đoạn mạng bất ổn xen giữa — mô phỏng "intermittent disconnect" |

Có thể chỉnh trực tiếp trong `scenarios/H.json` hoặc tạo file config riêng
(`--config=path/to/custom.json`) theo đúng type `NetworkScenarioConfig`
(`lib/types.ts`) — ví dụ đổi `attributes.latency`, thêm toxic `bandwidth` để
giới hạn băng thông, hoặc đổi `toxicity` (xác suất áp dụng) của `reset_peer`.

## Giới hạn còn lại (dù đã dùng Toxiproxy thật)

- Toxiproxy mô phỏng ở tầng TCP proxy trên **cùng máy** — vẫn không hoàn
  toàn giống mạng di động/WiFi kém thật ngoài đời (jitter thực tế phức tạp
  hơn phân phối ngẫu nhiên đơn giản Toxiproxy dùng).
- `reset_peer` là cách gần nhất Toxiproxy hỗ trợ để mô phỏng "kết nối chập
  chờn", nhưng về bản chất là NGẮT HẲN kết nối (giống rút dây mạng rồi cắm
  lại), không hoàn toàn giống "rớt vài gói tin nhưng kết nối vẫn còn" (packet
  loss thật ở tầng UDP/IP thấp hơn nữa mà TCP tự retransmit che giấu đi —
  Toxiproxy không có toxic mô phỏng đúng mức packet loss này vì nó proxy ở
  tầng TCP đã established).
- 1 lần chạy không đủ để kết luận — như mọi scenario khác, cần chạy lại nhiều
  lần trước khi so sánh giữa các transport dưới điều kiện mạng kém.
