# Benchmark Framework

> **Trạng thái: framework đã implement đầy đủ, CHƯA CÓ LẦN CHẠY THẬT NÀO.**
> Sandbox dùng để viết code này không có network nên không `npm install`
> được — mọi con số trong repo (nếu có) đều phải ghi `NOT RUN`/`PENDING` cho
> tới khi bạn tự chạy trên máy có mạng (Rule 51 — no fake benchmark).

## Kiến trúc

```
benchmark/
├── lib/                    # dùng chung
│   ├── types.ts             # ScenarioConfig, Transport
│   ├── apiClient.ts          # gọi REST API thật (không đụng DB trực tiếp)
│   ├── pickPublisher.ts       # chọn user có nhiều follower nhất làm "publisher"
│   ├── payload.ts              # sinh script theo payloadSize (small/medium/large)
│   ├── random.ts                 # PRNG deterministic (mulberry32, seed tái lập được)
│   ├── metrics.ts                  # tính percentile, tổng hợp ScenarioResult
│   └── report.ts                     # ghi raw+processed, in summary
├── generators/               # 1 SimulatedClient/transport (implement chung interface)
│   ├── simulatedClient.ts     # interface
│   ├── shortPollingClient.ts
│   ├── longPollingClient.ts
│   ├── sseClient.ts             # dùng node:http thuần (giống pattern test backend)
│   ├── websocketClient.ts        # dùng thư viện `ws`, gửi ack như frontend thật
│   └── clientFactory.ts
├── runners/
│   ├── run.ts                  # chạy 1 scenario trên 1 transport
│   ├── compareTransports.ts     # chạy CÙNG scenario tuần tự trên cả 4 transport, in bảng so sánh
│   └── webPushDispatch.ts        # benchmark riêng cho Web Push (xem mục riêng bên dưới)
├── scenarios/                 # 10 file config A-J (JSON, khớp ScenarioConfig)
└── results/
    ├── raw/                     # đầy đủ per-client event list — nặng nhưng full
    ├── processed/                 # chỉ số liệu tổng hợp — nhẹ, để so sánh nhanh
    └── reports/                     # (để dành cho báo cáo tổng hợp thủ công sau này)
```

## Cách chạy

```bash
cd benchmark
npm install

# Đảm bảo backend đang chạy và ĐÃ SEED dữ liệu trước:
#   cd ../backend && npm run dev            (terminal khác)
#   cd ../backend && npm run seed -- --users=2000 --avgFollows=50

# Chạy 1 scenario trên 1 transport:
npm run run -- --scenario=A --transport=sse

# Override tham số nhanh không cần sửa JSON:
npm run run -- --scenario=D --transport=websocket --posts-per-second=20 --duration=60000

# So sánh cùng 1 scenario trên cả 4 transport (chạy tuần tự, không song song):
npm run compare -- --scenario=A

# Scenario H (Poor Network) — cần Toxiproxy đang chạy riêng (xem scenarios/H-README.md):
npm run run-network -- --scenario=H --transport=sse
```

Kết quả in ra console + ghi vào `results/raw/` (đầy đủ) và `results/processed/`
(tóm tắt). Mỗi lần chạy là 1 file riêng (timestamp trong tên) — không ghi đè,
để giữ lịch sử nhiều lần chạy (Rule: benchmark repeatability, cần chạy nhiều
lần và so sánh variance trước khi kết luận).

## Cách hoạt động (tóm tắt)

1. Chọn "publisher" = user có nhiều follower nhất (query qua API thật, không
   đụng DB trực tiếp — benchmark hành xử như 1 client thật).
2. Tạo N `SimulatedClient` (N = `subscriberCount`, giới hạn bởi follower thật
   có trong DB) cho follower của publisher, dùng đúng transport được chọn.
3. Kết nối clients (đồng loạt hoặc ramp-up nếu `connectionStorm.enabled`).
4. Publisher tạo post theo `postRate` (đều đặn hoặc burst) qua **REST API
   thật** trong `durationMs`.
5. Nếu `reconnectStorm.enabled`: ngắt + kết nối lại toàn bộ client tại các
   mốc thời gian định sẵn.
6. Sau khi hết `durationMs`, đợi grace period rồi ngắt kết nối, tổng hợp
   metrics (latency percentile, delivery rate, duplicate, error, reconnect).

## Vì sao benchmark gắn với domain thật (post → follow → notification)

Cố tình KHÔNG có 1 "notification generator" tách rời bắn thẳng notification
vào transport — benchmark tạo post thật qua API thật, dựa trên follow graph
thật đã seed. Điều này đảm bảo benchmark đo đúng toàn bộ pipeline thật (fan-out
qua `NotificationService`, không chỉ riêng transport layer), đúng yêu cầu
"phản ánh cách hệ thống production được thiết kế" (Section 9).

## Giới hạn đã biết (ghi rõ, không giấu)

- **Chạy trên 1 máy, `localhost`** — mọi số liệu là local/synthetic benchmark
  theo đúng Assumption A1 đã thống nhất từ đầu Phase 2, KHÔNG phải
  production-scale benchmark (Rule 10).
- **Scenario H (Poor Network) dùng Toxiproxy thật** — xem
  `scenarios/H-README.md` cho cách chạy. Thiết kế ĐỘC LẬP: chỉ
  `runners/runNetworkScenario.ts` cần Toxiproxy đang chạy, 9 scenario còn lại
  (A-G, I, J) và `run.ts`/`compareTransports.ts` hoàn toàn không bị ảnh hưởng
  dù Toxiproxy có cài hay không.
- **Scenario G (Slow Client)** chỉ mô phỏng "xử lý chậm ở tầng ứng dụng"
  (delay trước khi ghi nhận đã xử lý xong), KHÔNG mô phỏng backpressure thật
  ở tầng socket buffer — băng thông loopback quá cao để buffer đầy trong thời
  gian benchmark ngắn.
- **Web Push không chạy qua `run.ts`** — xem mục riêng bên dưới.
- **Reconnect storm với Short Polling** gần như vô nghĩa (short polling
  không có khái niệm "connection" bền — mỗi request đã là 1 lần "kết nối
  mới"), kết quả Scenario F trên Short Polling nên được diễn giải cẩn thận,
  không so sánh trực tiếp 1-1 với SSE/WS/Long Polling.
- Benchmark tự nó tốn CPU/network của MÁY CHẠY BENCHMARK (client giả lập +
  server cùng chạy 1 máy trong setup mặc định) — nếu muốn đo chính xác hơn,
  chạy `benchmark/` trên máy khác với `BENCHMARK_API_BASE_URL` trỏ tới server.

## Web Push — vì sao tách riêng

4 transport kia (Short/Long Polling, SSE, WebSocket) đều có 1 "client
polling/streaming loop" rõ ràng để mô phỏng. Web Push thì KHÔNG — phần nhận
notification thật sự (Push Service đánh thức Service Worker, hiển thị OS
notification) chỉ xảy ra trong trình duyệt thật, không thể mô phỏng bằng
Node.js client. Vì vậy:

- `runners/webPushDispatch.ts` chỉ đo được thời gian server xử lý xong
  request tạo post (KHÔNG phải thời gian `webpush.sendNotification()` hoàn
  tất, vì việc gửi push chạy fire-and-forget — xem comment trong file).
- Muốn xem kết quả gửi Web Push thật (thành công/thất bại theo Push Service),
  cần tự bật Web Push qua UI trên 1 trình duyệt thật trước, rồi query bảng
  `delivery_attempts WHERE transport='web_push'` sau khi chạy script.
- Muốn biết notification có thực sự hiện ra hay không — chỉ quan sát được
  bằng mắt trên trình duyệt thật, không tự động hoá được trong phạm vi
  project này.

## Environment cần ghi lại khi báo cáo kết quả (Section 34 — Version Pinning)

Mỗi lần chạy nên ghi kèm (đã tự động ghi trong `result.environment` của mỗi
file JSON): Node.js version, OS/platform/arch, hostname. **Cần bổ sung thủ
công** khi viết báo cáo cuối: CPU, RAM, có chạy cùng máy với backend hay
không, có ứng dụng nào khác đang chạy cạnh tranh tài nguyên hay không.
