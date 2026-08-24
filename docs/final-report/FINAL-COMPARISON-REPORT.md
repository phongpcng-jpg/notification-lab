# Notification Technology — Final Comparison Report (Template)

> **Đây là TEMPLATE, không phải benchmark result.** File này chứa phần lý thuyết, implementation facts, methodology và decision matrix. Số liệu thực nghiệm được sinh riêng bởi `npm run report`.

## 0. Trạng thái và nguyên tắc báo cáo

Template này được giữ tách biệt với kết quả benchmark để tránh trộn **FACT / THEORY** với **EXPERIMENTAL RESULT**.

- Không được điền số latency/throughput giả định vào template.
- Khi chưa có kết quả chạy thật, experimental values phải ghi `NOT RUN` / `PENDING`.
- `npm run report` **không ghi đè file template này**. Generator tạo các file mới tại:
  - `benchmark/results/reports/final-report.json`
  - `benchmark/results/reports/final-report.md`
- `generateFinalReport.ts` chỉ tổng hợp các file trong `benchmark/results/processed/`.
- Common benchmark hiện đo **4 transport**: Short Polling, Long Polling, SSE và WebSocket. **Web Push không nằm trong common runner** và có workflow riêng. fileciteturn165file0L2-L2

Theo benchmark README hiện tại, framework vẫn được xem là **chưa có benchmark run chính thức trong repo** cho tới khi người dùng thực sự chạy nó; không được suy ra kết quả từ code hoặc từ một lần chạy thủ công không được lưu vào results. fileciteturn179file0L2-L2

---

## 1. Executive Summary

Project triển khai 5 kỹ thuật notification trên cùng domain post/follow/notification:

1. Short Polling
2. Long Polling
3. Server-Sent Events (SSE)
4. WebSocket
5. Web Push

Bốn transport đầu tiên có cùng benchmark client interface và được `run.ts` / `compareTransports.ts` hỗ trợ. Web Push được đánh giá riêng vì việc nhận push thực tế phụ thuộc browser Service Worker và Push Service, không thể được đo end-to-end bằng Node client thông thường. fileciteturn179file0L2-L2

Mục tiêu của report cuối là giữ ba lớp kết luận riêng biệt:

- **Implementation facts:** hành vi thực tế của code/test trong repository.
- **Theoretical comparison:** đặc tính giao thức và trade-off kiến trúc.
- **Experimental comparison:** số liệu sinh từ benchmark thật.

Không dùng experimental result để khẳng định một transport "nhanh nhất" nếu chưa có dữ liệu đủ repeatability.

---

## 2. Problem & Requirements

Hệ thống mô phỏng web application trong đó user tạo post và notification được tạo cho follower. Không có authentication thực; `userId` được truyền qua API/transport để phục vụ lab.

Các transport dùng cùng notification persistence và cursor-based recovery để có thể so sánh delivery behavior trên cùng domain.

Chi tiết architecture và flow hiện tại: `docs/architecture.md`.

---

## 3. Current Architecture

```text
React SPA
   │
   ├── Short Polling
   ├── Long Polling
   ├── SSE
   ├── WebSocket
   └── Web Push
   │
   ▼
Fastify API
   │
   ├── NotificationService
   ├── PushHub                 → SSE / WebSocket
   ├── NotificationWaiters     → Long Polling
   └── SQLite / better-sqlite3
```

`NotificationService` là transport-agnostic source of notification creation. SSE/WebSocket dùng in-process `PushHub`; Long Polling dùng in-process `NotificationWaiters`. Vì vậy SSE/WebSocket/Long Polling hiện có giới hạn multi-instance nếu chưa bổ sung shared signaling/pub-sub. Short Polling không có connection state ở server nên ít phụ thuộc connection affinity hơn. Chi tiết xem các transport reports và `docs/architecture.md`.

Web Push khác mô hình trên: backend gửi tới browser Push Service thông qua Web Push/VAPID; Service Worker chịu trách nhiệm nhận push và hiển thị notification.

---

## 4. Implementation Comparison

| Transport | Model | Cursor / recovery | Server state | Reconnect | Bidirectional |
|---|---|---|---|---|---|
| Short Polling | HTTP request/response định kỳ | `after` = notification ID | Stateless per request | Client polling loop | No |
| Long Polling | HTTP request giữ mở tới data/timeout | `after` = notification ID | `NotificationWaiters` in-process | Client retry | No |
| SSE | Long-lived HTTP stream | `Last-Event-ID` / event ID | `PushHub` in-process | Browser `EventSource` reconnect + cursor recovery | No |
| WebSocket | Persistent WebSocket | `after` catch-up + live stream | `PushHub` in-process | Client reconnect/backoff | **Yes**, có ACK |
| Web Push | Browser Push Service | Notification persistence / delivery attempts | Push subscription persistence | Push Service / browser managed | No |

### Delivery semantics

Project hiện hướng tới **at-least-once-oriented delivery**, không exactly-once user-visible delivery.

- Short/Long Polling: cursor `id > after` + client deduplication.
- SSE: event IDs/cursor recovery + reconnect.
- WebSocket: catch-up cursor + live delivery; ACK cập nhật acknowledgement state nhưng không chứng minh user đã nhìn thấy notification.
- Web Push: delivery phụ thuộc Push Service/browser; không coi việc server gửi request thành bằng chứng user đã thấy notification.

---

## 5. Research / Evidence Classification

| Claim type | Evidence |
|---|---|
| Protocol semantics | RFC / WHATWG / MDN / official specifications |
| Industry architecture examples | Official engineering documentation / source repositories |
| Current project's behavior | Repository code + integration/unit tests |
| Performance | **Only benchmark results stored in `benchmark/results/processed/`** |

`docs/transport-reports/*.md` là nguồn chi tiết cho từng transport. Không dùng các giá trị lý thuyết như kết quả benchmark.

---

## 6. Theoretical Comparison Matrix

| Tiêu chí | Short Polling | Long Polling | SSE | WebSocket | Web Push |
|---|---|---|---|---|---|
| Direction | Pull | Pull, request giữ mở | Server → Client | Bidirectional | Server → Client qua Push Service |
| Low-latency fit | Phụ thuộc polling interval | Tốt khi request đang chờ | Tốt cho server push 1 chiều | Tốt cho realtime hai chiều | Không kiểm soát được end-to-end latency |
| Connection state | Không | In-process waiter | In-process stream | In-process socket | Không giữ app socket tới browser |
| Browser reconnect | Client loop | Client retry | `EventSource` built-in | Client tự implement | Browser/Push Service managed |
| Offline/background | Không | Không | Không | Không | **Có** |
| Bidirectional | Không | Không | Không | **Có** | Không |
| Multi-instance work required | Thấp ở transport layer | Shared wake-up cần thiết | Shared pub/sub cần thiết | Shared pub/sub + WS-aware deployment considerations | Subscription/delivery qua external Push Service |
| Infrastructure complexity | Thấp | Trung bình | Thấp–Trung bình | Cao hơn | Cao hơn do VAPID/SW/Push Service |

Các đánh giá trên là **theoretical/implementation comparison**, không phải ranking dựa trên benchmark.

---

## 7. Decision Matrix

| Requirement | Short Polling | Long Polling | SSE | WebSocket | Web Push |
|---|---|---|---|---|---|
| Simple in-app notification | Strong fit | Strong fit | Strong fit | Possible | Possible |
| Low latency | Weak–Possible tùy interval | Strong fit | Strong fit | Strong fit | Not deterministic |
| Server → client one-way | Strong fit | Strong fit | Strong fit | Possible, nhưng dư tính năng | Strong fit |
| Bidirectional interaction | Not applicable | Not applicable | Not applicable | **Strong fit** | Not applicable |
| Offline/background | Not applicable | Not applicable | Not applicable | Not applicable | **Strong fit** |
| Stateless HTTP infrastructure | **Strong fit** | Possible | Possible | Weak fit | Possible |
| High-frequency updates | Weak–Possible, request overhead tăng | Possible | Strong candidate | Strong candidate | Poor fit for continuous in-app stream |
| Browser-managed reconnect | Not needed | No | **Yes (`EventSource`)** | No | Managed by platform |
| OS-level browser notification | No | No | No | No | **Yes** |

Các nhãn `Strong fit` / `Possible` là decision guidance dựa trên requirement + architecture, **không phải kết quả benchmark**.

---

## 8. Experimental Methodology

### 8.1 Common benchmark scope

`benchmark/runners/generateFinalReport.ts` hiện aggregate theo:

```text
Scenario × Transport
```

với transport order:

```text
short_polling
long_polling
sse
websocket
```

và scenario order:

```text
A, B, C, D, E, F, G, I, J
```

Scenario H được xử lý riêng. Generator không tự tạo Web Push row trong common matrix. fileciteturn165file0L2-L2

### 8.2 Current scenario definitions

| Scenario | Current default configuration | Mục tiêu |
|---|---|---|
| A | 20 subscribers, 120s, 0.0167 post/s, small | Baseline normal workload |
| B | 20 subscribers, 70s, burst 100 mỗi 60s, small | Burst / queue / duplicate behavior |
| C | 1000 subscribers, 30s, 0.1 post/s, small | Massive fan-out |
| D | 50 subscribers, 30s, 10 post/s, small | High-frequency workload |
| E | 300 subscribers, 30s, 0.2 post/s, connection ramp 2s | Connection storm |
| F | 100 subscribers, 30s, 0.5 post/s, reconnect tại 15s | Reconnection behavior |
| G | 50 subscribers, 30s, 1 post/s, 30% slow + 3s delay | Application-level slow clients |
| H | 30 subscribers, 45s, 0.5 post/s, Toxiproxy latency/reset | Poor network; chạy riêng |
| I | 20 subscribers, 30s, 0.5 post/s, large payload | Payload-size effect |
| J | 100 subscribers, 45s, burst 20/15s + connection/reconnect storm + 20% slow clients + medium payload | Mixed workload |

Các giá trị trên lấy từ `benchmark/scenarios/*.json`; chúng là **configuration**, không phải performance result. fileciteturn170file0L2-L2 fileciteturn171file0L2-L2 fileciteturn172file0L2-L2 fileciteturn173file0L2-L2 fileciteturn174file0L2-L2 fileciteturn175file0L2-L2 fileciteturn183file0L2-L2 fileciteturn178file0L2-L2 fileciteturn181file0L2-L2 fileciteturn182file0L2-L2

### 8.3 Repeatability

Default `run-all` configuration is designed around repeated runs. The current benchmark README specifies default `--repeats=3`; users can increase repeats and scale subscriber/duration when hardware permits. fileciteturn179file0L2-L2

A single run should not be treated as evidence of stable p95/p99 behavior. Report comparisons should retain the run count and environment information.

### 8.4 Metrics

The generated report currently exposes:

- Runs
- p50 / p95 / p99 latency
- p95 standard deviation across runs
- Delivery rate
- Errors
- Reconnects
- Duplicates

The benchmark also records server/client timestamps needed to distinguish E2E and server/transport timing. See `benchmark/lib/metrics.ts` and generated result files.

### 8.5 Scenario H

H is intentionally excluded from the main A–J-minus-H matrix. It requires Toxiproxy and is generated through the network-specific runner. The generated report puts H in a separate section. fileciteturn165file0L2-L2

### 8.6 Web Push

Web Push is **not part of the common 4-transport comparison matrix**. The project has a separate Web Push dispatch workflow because a Node benchmark client cannot faithfully observe browser Service Worker receipt and OS notification display. fileciteturn179file0L2-L2

---

## 9. Experimental Results — GENERATED, NOT HAND-EDITED

**Status in this template: `NOT RUN` until actual processed benchmark results exist.**

Do **not** paste invented values into this file.

After running benchmark and then:

```bash
cd benchmark
npm run report
```

read:

```text
benchmark/results/reports/final-report.md
benchmark/results/reports/final-report.json
```

The generated Markdown contains the actual aggregated A/B/C/D/E/F/G/I/J × Short/Long/SSE/WebSocket matrix and a separate H section. It reports `N/A` when an expected scenario/transport cell has no processed result. fileciteturn165file0L2-L2

The generated report intentionally does not decide which transport is "best"; it presents measured values and points back to this template's decision matrix for interpretation.

---

## 10. How to Interpret the Final Report

1. **First check Runs.** `Runs=1` is not enough to claim repeatable performance.
2. Compare transports **within the same scenario** before comparing across scenarios.
3. Check p50/p95/p99 together; a low p50 does not imply good tail behavior.
4. Check Delivery rate, Errors and Duplicates alongside latency.
5. Check p95 standard deviation across repeated runs.
6. Check `environment` before comparing results produced on different machines.
7. Treat Scenario F carefully for Short Polling because it has no persistent connection/reconnect lifecycle comparable to SSE/WebSocket/Long Polling.
8. Treat Scenario G as application-level processing delay, **not real socket-buffer backpressure**.
9. Treat H separately because its network conditions are intentionally altered with Toxiproxy.
10. Do not treat Web Push server dispatch timing as browser-visible notification latency.

---

## 11. Known Benchmark Limitations

- Default setup is local/synthetic; it is not a production-scale benchmark.
- Benchmark clients and backend can run on the same machine, so CPU/network contention can affect results.
- Scenario G does not reproduce true socket-buffer backpressure.
- Scenario F is not semantically equivalent across all transports.
- Web Push cannot be measured end-to-end by the common Node client.
- Network conditions outside Scenario H are not representative of arbitrary Internet paths.
- Benchmark results should always retain Node version, OS/platform/arch, hostname and whether benchmark/backend share a machine.

---

## 12. Source of Truth

When this template conflicts with implementation, update the template rather than preserving the old statement.

Priority for current-state facts:

1. `backend/`, `frontend/`, `benchmark/` implementation
2. Integration/unit tests
3. `docs/architecture.md`
4. `docs/transport-reports/*.md`
5. This template

The generated report is the source of truth **only for the numerical benchmark results it contains**; it does not replace the architecture/theory documentation.
