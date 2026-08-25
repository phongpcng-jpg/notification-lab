# Benchmark Framework

> **Trạng thái:** framework benchmark đã implement đầy đủ cho 4 transport: Short Polling, Long Polling, SSE và WebSocket. Web Push có workflow dispatch riêng vì end-to-end browser receipt không thể được đo bằng Node.js simulated client.
>
> Scenario A–J đã được định nghĩa. Common benchmark mặc định chạy A–G, I, J; Scenario H là network scenario chạy riêng với Toxiproxy.
>
> **Lưu ý về kết quả:** benchmark framework có thể chạy local hoặc trên môi trường benchmark được cấu hình, nhưng chỉ kết quả được sinh và lưu trong `results/processed/` mới được dùng làm experimental evidence. Không tự coi các lần chạy thủ công hoặc kết quả console là official benchmark result. Không đưa số liệu giả vào report; khi chưa có processed result phù hợp, report phải để `NOT RUN`/`PENDING`.

## Kiến trúc

```text
benchmark/
├── lib/                    # dùng chung
│   ├── types.ts            # ScenarioConfig, Transport
│   ├── apiClient.ts        # gọi REST API thật (không đụng DB trực tiếp)
│   ├── pickPublisher.ts    # chọn user có nhiều follower nhất làm publisher
│   ├── payload.ts           # sinh payload theo payloadSize
│   ├── random.ts            # PRNG deterministic
│   ├── metrics.ts           # percentile và ScenarioResult
│   └── report.ts            # ghi raw/processed và summary
├── generators/              # simulated clients cho common transports
│   ├── simulatedClient.ts   # interface
│   ├── shortPollingClient.ts
│   ├── longPollingClient.ts
│   ├── sseClient.ts         # node:http
│   ├── websocketClient.ts   # ws, ACK giống frontend protocol
│   └── clientFactory.ts
├── runners/
│   ├── run.ts               # 1 scenario × 1 transport
│   ├── runAll.ts            # chạy hàng loạt
│   ├── runNetworkScenario.ts # Scenario H / Toxiproxy
│   ├── compareTransports.ts # cùng scenario tuần tự trên 4 transport
│   ├── webPushDispatch.ts   # workflow riêng cho Web Push
│   └── generateFinalReport.ts # aggregate processed results
├── scenarios/               # 10 config A–J
└── results/
    ├── raw/                 # per-client event data
    ├── processed/           # aggregate results used by report
    └── reports/             # generated final reports
```

## Cách chạy

### Chuẩn bị

```bash
cd benchmark
npm install
```

Backend phải đang chạy và nên được seed trước khi benchmark:

```bash
cd ../backend
npm run migrate
npm run dev
```

Ở terminal khác:

```bash
cd ../backend
npm run seed -- --users=2000 --avgFollows=50
```

Benchmark gọi REST API thật và chọn publisher dựa trên follower graph thật; nó không truy cập DB trực tiếp.

### Chạy một scenario

```bash
cd benchmark
npm run run -- --scenario=A --transport=sse
```

Override tham số nhanh mà không sửa JSON:

```bash
npm run run -- --scenario=D --transport=websocket --posts-per-second=20 --duration=60000
```

### So sánh một scenario trên 4 transport

```bash
npm run compare -- --scenario=A
```

Các transport của common benchmark là:

```text
short_polling
long_polling
sse
websocket
```

### Scenario H — Poor Network

Scenario H chạy qua Toxiproxy và được tách khỏi common benchmark:

```bash
npm run run-network -- --scenario=H --transport=sse
```

Xem `scenarios/H-README.md` để biết cách chuẩn bị Toxiproxy.

### Chạy toàn bộ common benchmark

```bash
npm run run-all
npm run report
```

Mặc định:

```text
9 scenarios × 4 transports × 3 repeats

Scenarios:
A B C D E F G I J

Transports:
Short Polling / Long Polling / SSE / WebSocket
```

Chạy thêm Scenario H:

```bash
npm run run-all -- --include-h
npm run report
```

Chạy nặng hơn:

```bash
npm run run-all -- --repeats=5 --subscriber-scale=10 --duration-scale=2
npm run report
```

## `runAll.ts` — flags

| Flag | Mặc định | Ý nghĩa |
|---|---|---|
| `--scenarios=A,B,C` | `A-G,I,J` | Chọn tập scenario con |
| `--transports=sse,websocket` | cả 4 common transport | Chọn tập transport con |
| `--repeats=N` | `3` | Số lần lặp mỗi scenario × transport |
| `--subscriber-scale=X` | `1` | Nhân `subscriberCount` của mọi scenario lên X |
| `--duration-scale=X` | `1` | Nhân `durationMs` của mọi scenario lên X |
| `--include-h` | tắt | Chạy thêm Scenario H qua Toxiproxy |

Scenario H không nằm trong default matrix có chủ đích vì cần network fault injection riêng.

## Report generation

`npm run report` đọc các file trong `results/processed/` và aggregate theo `(scenario, transport)`. Với các lần chạy lặp, generator tính aggregate statistics giữa các runs và ghi:

```text
results/reports/final-report.md
results/reports/final-report.json
```

`final-report.md` là **generated output**, không phải template. Template/reference nằm ở:

```text
docs/final-report/FINAL-COMPARISON-REPORT.md
```

`npm run report` không ghi đè template. Có thể chạy lại report sau khi thêm processed results mà không cần chạy lại toàn bộ benchmark.

Mỗi run ghi raw và processed output riêng, giúp giữ lịch sử runs và phân tích repeatability/variance.

## Cách hoạt động

1. Chọn publisher = user có nhiều follower nhất qua REST API.
2. Tạo `SimulatedClient` cho các follower thực của publisher, giới hạn bởi `subscriberCount`.
3. Kết nối clients; Scenario E có connection storm/ramp-up behavior theo config.
4. Publisher tạo post thật qua REST API theo `postRate` trong `durationMs`.
5. Nếu scenario có reconnect behavior, client được ngắt/kết nối lại theo các mốc được cấu hình.
6. Sau `durationMs`, benchmark chờ grace period, đóng clients và tổng hợp metrics.

Benchmark cố ý tạo **post thật → follow graph thật → notification thật** thay vì bắn notification giả trực tiếp vào transport. Vì vậy kết quả phản ánh cả notification pipeline của application, không chỉ transport layer.

## Metrics

Các kết quả benchmark có thể bao gồm:

- latency percentiles;
- delivery rate;
- duplicate count/rate;
- errors;
- reconnect behavior;
- event counts và các aggregate statistics khác được ghi trong `ScenarioResult`.

Khi phân tích kết quả, phải phân biệt latency được đo ở application/server với browser-visible receipt time. Đặc biệt Web Push không có browser receipt timestamp trong common Node benchmark.

## Giới hạn đã biết

- **Local/synthetic setup:** benchmark mặc định có thể chạy client giả lập và backend trên cùng máy. Đây không phải production-scale benchmark.
- **Single-instance application:** in-process signaling và SQLite phù hợp với lab hiện tại nhưng không đại diện cho horizontal scaling qua nhiều application instances.
- **Scenario H:** chỉ runner network scenario cần Toxiproxy; A–G, I, J không phụ thuộc Toxiproxy.
- **Scenario G:** mô phỏng slow processing ở tầng ứng dụng, không phải socket-buffer backpressure thực tế.
- **Scenario F:** reconnect semantics không tương đương giữa các transport. Short Polling không có persistent connection nên không nên so sánh reconnect event 1:1 với SSE/WebSocket/Long Polling.
- **Benchmark interference:** client giả lập và server chạy cùng máy có thể cạnh tranh CPU/network. Nếu cần tách tải, chạy benchmark ở máy khác và cấu hình API base URL phù hợp.

## Web Push — workflow riêng

Web Push không chạy qua `run.ts` và không nằm trong common 4-transport matrix.

```bash
npm run webpush-dispatch
```

Workflow này không thể biến browser receipt thành một Node.js latency metric đáng tin cậy. Push Service, Service Worker và OS notification đều nằm ngoài simulated-client lifecycle.

Để kiểm tra Web Push thực tế:

1. bật Web Push trong browser thật;
2. tạo subscription;
3. chạy workflow dispatch/post;
4. kiểm tra `delivery_attempts` để biết trạng thái server-side dispatch/delivery attempt;
5. quan sát browser/OS notification nếu cần xác nhận user-visible receipt.

Không dùng thời gian server dispatch như bằng chứng rằng OS/browser notification đã hiển thị.

## Reproducibility và environment

Mỗi result JSON ghi environment information như Node.js version, OS/platform/arch và hostname. Khi viết report cuối nên bổ sung hoặc ghi chú thêm:

- CPU/RAM;
- benchmark chạy cùng hay khác máy với backend;
- các workload khác đang chạy cạnh tranh tài nguyên;
- database state/seed parameters;
- repeats và scenario configuration.

Seed nên được cố định khi cần tái lập dataset:

```bash
cd backend
npm run seed -- --users=2000 --avgFollows=50 --seed=12345
```

## Package scripts

Các command chính được định nghĩa trong `benchmark/package.json`:

```text
npm run run
npm run run-all
npm run run-network
npm run compare
npm run report
npm run webpush-dispatch
npm run lint
```

`npm run lint` chạy TypeScript type-check cho benchmark mà không phát sinh output build.
