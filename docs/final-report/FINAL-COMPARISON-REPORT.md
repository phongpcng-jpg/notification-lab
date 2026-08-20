# Notification Technology — Final Comparison Report (Template)

**Trạng thái tài liệu này:** TEMPLATE — phần lý thuyết/kiến trúc đã điền đầy
đủ dựa trên implementation thật. **Phần thực nghiệm (mục 8-9) toàn bộ là
`PENDING — not measured`**, vì môi trường viết báo cáo này không có network
để `npm install`, nên không chạy được backend thật, do đó không có 1 con số
benchmark thật nào được tạo ra ở đây (xem mục 0). Đây KHÔNG phải sơ suất —
là quyết định có chủ đích để không vi phạm nguyên tắc "không bịa benchmark".

File JSON/Markdown có số liệu thật sẽ được `benchmark/runners/generateFinalReport.ts`
(Phần 2 — xem sau) tự sinh ra khi bạn chạy trên máy có network, ghi đè đúng
các bảng còn `PENDING` trong tài liệu này (hoặc tạo file mới cạnh nó).

---

## 0. Vì sao báo cáo này không có số liệu thực nghiệm

| Yêu cầu | Trạng thái trong sandbox viết report này |
|---|---|
| `npm install` (fastify, better-sqlite3, ws, web-push...) | ❌ Không có network access (`registry.npmjs.org` trả HTTP 403 `host_not_allowed`) |
| Chạy backend thật | ❌ Phụ thuộc bước trên |
| Chạy benchmark thật (dù 1 request) | ❌ Phụ thuộc backend thật |

Theo Rule 51 (No Fake Benchmark) đã thống nhất từ đầu: nếu chưa chạy, phải
ghi `NOT RUN`/`PENDING`, không được điền số liệu "có vẻ hợp lý". Báo cáo này
tuân thủ nghiêm ngặt điều đó.

---

## 1. Executive Summary

Project đã implement đầy đủ 5 kỹ thuật notification (Short Polling, Long
Polling, SSE, WebSocket, Web Push) trên cùng 1 domain (đăng bài/theo dõi),
cùng 1 benchmark framework có khả năng đo thực nghiệm cả 5 kỹ thuật (Web
Push có giới hạn riêng — xem mục 10). Báo cáo này tổng hợp:

- So sánh **lý thuyết** (dựa trên spec, tài liệu chính thức, và chính kinh
  nghiệm implement/test trong project) — **đã hoàn thành, đáng tin cậy**.
- Khung so sánh **thực nghiệm** (tham số benchmark khuyến nghị, cấu trúc bảng
  kết quả) — **đã thiết kế xong, chưa có số liệu thật**.
- Decision matrix — **dựa trên lý thuyết**, sẽ được củng cố/điều chỉnh bằng
  số liệu thật khi bạn chạy Phần 2.

## 2. Problem & Requirements (tóm tắt)

Hệ thống đăng bài + theo dõi tối giản: 1 user đăng 1 bài (script + thời
gian, không title), hệ thống thông báo cho follower. Follow không giới hạn,
không tự follow bản thân. Không cần login thật. Yêu cầu implement + đo thực
nghiệm cả 5 kỹ thuật notification trên cùng hệ thống này. Chi tiết đầy đủ:
xem lịch sử conversation / `docs/architecture.md`.

## 3. Architecture (tóm tắt)

```
React SPA ── chọn transport ──▶ Fastify API Server ──▶ NotificationService
                                       │                  (transport-agnostic)
                                       ▼
                                 SQLite (better-sqlite3)
```
Single-instance, in-process pub/sub cho SSE/WebSocket (`PushHub`) và Long
Polling (`NotificationWaiters`) — giới hạn multi-instance đã ghi rõ trong
`docs/architecture.md` và từng ADR liên quan. Chi tiết đầy đủ: `docs/architecture.md`,
`docs/adr/`.

## 4. Technologies — tóm tắt 1 dòng/kỹ thuật

| Kỹ thuật | Bản chất | Độ phức tạp implement (đã đo thật qua code) |
|---|---|---|
| Short Polling | Client hỏi định kỳ, server trả ngay | Thấp (~70 dòng route) |
| Long Polling | Server giữ request tới khi có data/timeout | Trung bình (~140 dòng, cần waiter registry) |
| SSE | Server stream 1 chiều qua `EventSource` | Thấp–Trung bình (~120 dòng, cần `reply.hijack()`) |
| WebSocket | 2 chiều thật qua `ws`, có ack | Cao (~180 dòng, heartbeat + backpressure + reconnect tự viết) |
| Web Push | Qua Push Service bên thứ 3, hoạt động khi tab đóng | Cao (nhiều thành phần: SW, VAPID, subscription lifecycle) |

Nguồn: đếm dòng code thật trong `backend/src/routes/*.ts` — đây là **FACT**
đo được trực tiếp từ project, không phải ước lượng.

## 5. Research Findings — nguồn & độ tin cậy

| Loại thông tin | Nguồn | Độ tin cậy |
|---|---|---|
| Hành vi giao thức (SSE reconnect, WS ping/pong, HTTP semantics) | MDN, RFC 6455, WHATWG spec | High (Tier 1) |
| Kiến trúc production thật (Slack WebSocket, GitHub/Gitea SSE) | Slack Engineering blog, GitHub issue tracker | High — Tier 1 (đến từ chính đội ngũ kỹ thuật/mã nguồn) |
| Xu hướng ngành (SSE khuyến nghị mặc định cho 1 chiều) | WebSocket.org (Ably), TechPlained, APIScout, CodeScoop | Medium — nhiều nguồn độc lập đồng thuận, nhưng vẫn là nhận định ngành, không phải khảo sát chính thức |
| Số liệu Web Push opt-in rate | Sleeknote, Gravitec, PushPushGo | Low-Medium — các nguồn marketing chênh lệch đáng kể, đã ghi khoảng giá trị thay vì 1 số duy nhất |
| Hành vi implementation của CHÍNH project này (độ phức tạp, delivery semantics, giới hạn in-process) | Code + test thật trong repo | **High — đây là FACT trực tiếp, không phải trích dẫn** |

Chi tiết đầy đủ + bảng nguồn từng claim: xem `research/notification-tech-research-report.md`
(Track A) và `docs/transport-reports/*.md` (per-technique, có source table riêng).

## 6. Theoretical Comparison Matrix (FACT + INDUSTRY EXPERIENCE — không phải EXPERIMENTAL)

> Đây là bảng loại **A. Theoretical Comparison** (Section 31) — hợp lệ để
> điền ngay vì dựa trên spec + implementation thật, KHÔNG cần chờ benchmark.

| Tiêu chí | Short Polling | Long Polling | SSE | WebSocket | Web Push |
|---|---|---|---|---|---|
| Direction | Pull | Pull (giữ mở) | Server→Client | Bidirectional (có ack thật) | Server→Client qua Push Service |
| Delivery semantics (đã implement) | At-least-once (cursor-based) | At-least-once (cursor-based) | At-least-once (Last-Event-ID) | At-least-once + ack (`acknowledged` status) | Best-effort, không đảm bảo |
| Reconnect | Tự viết (client) | Tự viết (client) | Built-in (`EventSource`) | Tự viết (client, browser không built-in) | Không áp dụng |
| Connection lifecycle server-side | Không có (stateless/request) | `NotificationWaiters` (resolve 1 lần) | `PushHub` (sống suốt kết nối) | `PushHub` + heartbeat ping/pong | Không có (không giữ kết nối) |
| Offline/background support | Không | Không | Không | Không | **Có (duy nhất)** |
| Multi-instance readiness | Sẵn sàng (stateless) | Cần Redis (chưa làm) | Cần Redis (chưa làm) | Cần Redis (chưa làm) | Sẵn sàng (không giữ state kết nối) |
| Implementation complexity (đo thật) | Thấp | Trung bình | Thấp–Trung bình | Cao | Cao |
| Test coverage (đo thật) | 5 integration test | 5 integration test | 5 integration test (dùng `app.listen()` thật, không `inject()`) | 7 integration test (dùng lib `ws` thật) | 9 integration test (mock `web-push`) |

## 7. Decision Matrix (dựa trên lý thuyết + implementation — SẼ cập nhật bằng số liệu thật)

Theo đúng format yêu cầu — không dùng BEST/WORST/FASTEST:

| Requirement | Short Polling | Long Polling | SSE | WebSocket | Web Push |
|---|---|---|---|---|---|
| Simple notification | Strong fit | Possible | Strong fit | Possible (over-engineered nếu chỉ cần 1 chiều) | Possible |
| Low latency | Weak fit (= polling interval) | Possible | Strong fit (lý thuyết — PENDING đo) | Strong fit (lý thuyết — PENDING đo) | Not applicable (best-effort, không kiểm soát) |
| Server → client 1 chiều | Strong fit | Strong fit | Strong fit | Possible (dư thừa tính năng) | Strong fit |
| Bidirectional | Not applicable | Not applicable | Not applicable | **Strong fit (duy nhất, có ack thật)** | Not applicable |
| Offline/background | Not applicable | Not applicable | Not applicable | Not applicable | **Strong fit (duy nhất)** |
| Large connection count | Strong fit (stateless) | Requires additional infrastructure (non-blocking I/O, đã có sẵn nhờ Fastify) | Requires additional infrastructure (Redis nếu multi-instance) | Requires additional infrastructure (Redis + WS-aware LB nếu multi-instance) | Strong fit (không giữ kết nối) |
| Simple infrastructure | Strong fit | Possible | Possible | Weak fit (heartbeat, reconnect, backpressure tự viết) | Weak fit (VAPID, Push Service bên thứ 3) |
| Browser notification (OS-level) | Not applicable | Not applicable | Not applicable | Not applicable | **Strong fit (duy nhất)** |
| High-frequency events | Weak fit (overhead request rỗng) | Possible | Possible (PENDING đo throughput thật) | Possible (PENDING đo throughput thật) | Weak fit (không phù hợp update liên tục) |
| Reconnection (built-in browser) | Not applicable (stateless) | Requires additional infrastructure (tự viết) | Strong fit (built-in `EventSource`) | Requires additional infrastructure (tự viết) | Not applicable |

**Lưu ý quan trọng:** các ô "Strong fit (lý thuyết)" ở dòng Low latency/High-frequency
**CHƯA được xác nhận bằng số liệu đo thật** — đây là điểm quan trọng nhất cần
Phần 2 (chạy thật) bổ sung, vì đây chính là những tiêu chí mà lý thuyết và
thực tế production dễ lệch nhau nhất (workload, network, hardware cụ thể).

## 8. Experimental Methodology (đã thiết kế, khuyến nghị tham số)

### 8.1 Nguyên tắc chọn tham số benchmark

Mục tiêu: **đủ nhỏ để 1 lần chạy hoàn tất trong vài chục giây tới vài phút**
(khả thi chạy lặp lại nhiều lần để kiểm tra repeatability — Rule Section 29),
**đủ lớn để percentile (p95/p99) có ý nghĩa thống kê** — kinh nghiệm chung:
cần tối thiểu ~30-50 sample để p95 không dao động quá mạnh giữa các lần
chạy, và tối thiểu ~100 sample để p99 tạm ổn định.

Với `subscriberCount` subscriber và mỗi subscriber nhận N notification
(N = số post publisher tạo), tổng sample latency = `subscriberCount × N`.
Ví dụ Scenario A: 20 subscriber × ~4 post (trong 2 phút, tốc độ 1 post/60s)
= 80 sample — đủ cho p95, hơi mỏng cho p99 (chấp nhận được cho baseline).

### 8.2 Bảng tham số khuyến nghị cho từng scenario (đã có sẵn trong `benchmark/scenarios/*.json`)

| Scenario | subscriberCount | durationMs | postRate | payload | Lý do chọn mức này |
|---|---|---|---|---|---|
| A — Normal | 20 | 120,000 (2 phút) | 1 post/60s | small | Baseline, đủ nhỏ chạy nhanh, ~80 sample latency |
| B — Burst | 20 | 70,000 | burst 100/60s | small | 1 burst → 20×100=2000 sample trong 1 đợt, đủ lớn để thấy queue behavior |
| C — Fan-out | 1000 (mặc định) | 30,000 | 1 post/10s | small | Giới hạn máy dev; tăng lên 100k qua `--subscribers=` nếu máy đủ mạnh (xem `C.json` note) |
| D — High-frequency | 50 | 30,000 | 10 post/s | small | 300 post × 50 = 15,000 sample — đủ lớn cho p99 ổn định, vẫn chạy xong trong 30s |
| E — Connection Storm | 300 | 30,000 | 0.2 post/s | small | 300 connection mở trong 2s — đủ để thấy handshake overhead, không quá tải máy dev |
| F — Reconnect Storm | 100 | 30,000 | 0.5 post/s | small | Reconnect tại t=15s, 100 client đủ để thấy hiệu ứng đồng loạt |
| G — Slow Client | 50 | 30,000 | 1 post/s | small | 30% client chậm 3s — đủ để tách biệt rõ 2 nhóm trong kết quả |
| I — Large Payload | 20 | 30,000 | 0.5 post/s | large (~3000 ký tự) | So sánh trực tiếp với A/D cùng subscriberCount, chỉ đổi payload |
| J — Mixed | 100 | 45,000 | burst 20/15s | medium | Kết hợp nhiều yếu tố, thời gian đủ dài để 2-3 chu kỳ burst + 1 reconnect storm xảy ra |

**Tổng thời gian chạy đủ 9 scenario × 4 transport (không tính H) ≈ 9 × 4 ×
(duration trung bình ~40s + overhead kết nối/dọn dẹp ~5s) ≈ 27 phút** — khả
thi chạy trong 1 lần ngồi, có thể lặp lại 3 lần (Rule repeatability) trong
~1.5 giờ.

### 8.3 Scenario bị loại khỏi so sánh chính (theo yêu cầu)

- **Scenario H (Poor Network)**: cần Toxiproxy chạy riêng, không nằm trong
  `npm run compare`. Chạy độc lập qua `npm run run-network`, kết quả tách
  riêng — xem `benchmark/scenarios/H-README.md`. Lý do loại: không phải mọi
  người chạy benchmark đều có Toxiproxy cài sẵn, và nó có failure mode riêng
  (`reset_peer`) không so sánh 1-1 công bằng với 9 scenario kia.
- **Web Push**: không có "client polling loop" để đo end-to-end tự động
  (cần browser thật) — loại khỏi decision matrix thực nghiệm, chỉ có
  `webpush-dispatch` đo phần server-side riêng. Xem `benchmark/README.md`
  mục "Web Push — vì sao tách riêng".

## 9. Experimental Comparison Matrix (Template — PENDING)

> Đây là bảng loại **B. Experimental Comparison** — KHÔNG được trộn với
> mục 6 (Rule Section 31). Mọi ô dưới đây là **N/A — not measured** cho tới
> khi Phần 2 chạy xong và ghi đè.

| Scenario | Transport | p50 (ms) | p95 (ms) | p99 (ms) | Delivery rate | Errors | Reconnects |
|---|---|---|---|---|---|---|---|
| A | short_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| A | long_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| A | sse | N/A | N/A | N/A | N/A | N/A | N/A |
| A | websocket | N/A | N/A | N/A | N/A | N/A | N/A |
| B | short_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| B | long_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| B | sse | N/A | N/A | N/A | N/A | N/A | N/A |
| B | websocket | N/A | N/A | N/A | N/A | N/A | N/A |
| C | short_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| C | long_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| C | sse | N/A | N/A | N/A | N/A | N/A | N/A |
| C | websocket | N/A | N/A | N/A | N/A | N/A | N/A |
| D | short_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| D | long_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| D | sse | N/A | N/A | N/A | N/A | N/A | N/A |
| D | websocket | N/A | N/A | N/A | N/A | N/A | N/A |
| E | short_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| E | long_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| E | sse | N/A | N/A | N/A | N/A | N/A | N/A |
| E | websocket | N/A | N/A | N/A | N/A | N/A | N/A |
| F | short_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| F | long_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| F | sse | N/A | N/A | N/A | N/A | N/A | N/A |
| F | websocket | N/A | N/A | N/A | N/A | N/A | N/A |
| G | short_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| G | long_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| G | sse | N/A | N/A | N/A | N/A | N/A | N/A |
| G | websocket | N/A | N/A | N/A | N/A | N/A | N/A |
| I | short_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| I | long_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| I | sse | N/A | N/A | N/A | N/A | N/A | N/A |
| I | websocket | N/A | N/A | N/A | N/A | N/A | N/A |
| J | short_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| J | long_polling | N/A | N/A | N/A | N/A | N/A | N/A |
| J | sse | N/A | N/A | N/A | N/A | N/A | N/A |
| J | websocket | N/A | N/A | N/A | N/A | N/A | N/A |

*(36 dòng = 9 scenario × 4 transport. Bảng này sẽ được `generateFinalReport.ts`
tự sinh lại với số thật, không cần bạn điền tay.)*

## 10. Loại trừ khỏi báo cáo này (theo yêu cầu)

| Phần bị loại | Lý do | Chạy ở đâu thay thế |
|---|---|---|
| Scenario H (Poor Network) | Cần Toxiproxy chạy riêng, failure mode khác biệt (reset_peer) không so sánh công bằng 1-1 | `npm run run-network -- --scenario=H` — kết quả ghi riêng, không vào bảng mục 9 |
| Web Push end-to-end | Không tự động hoá được (cần browser thật) | `npm run webpush-dispatch` (chỉ đo server-side) + test tay trên browser |
| Mọi số liệu benchmark (toàn bộ mục 9) | Sandbox viết báo cáo này không có network để chạy | Phần 2 — code tự động, chạy trên máy bạn |

## 11. Limitations (áp dụng chung, nhắc lại)

- Mọi benchmark (kể cả khi chạy xong) là **local/synthetic**, 1 máy —
  không phải production-scale (Rule 10).
- `PushHub`/`NotificationWaiters` in-process — kết quả benchmark hiện tại
  KHÔNG phản ánh hành vi multi-instance (chưa implement Redis Pub/Sub).
- 1 lần chạy không đủ kết luận — cần lặp lại (Rule 29), `generateFinalReport.ts`
  (Phần 2) hỗ trợ tổng hợp nhiều lần chạy.

## 12. Sources

Toàn bộ nguồn đã liệt kê chi tiết trong:
- `research/notification-tech-research-report.md` (mục "Nguồn tham khảo chính")
- `docs/transport-reports/*.md` (mỗi file có source table riêng theo từng claim)
- `docs/adr/*.md` (quyết định kỹ thuật + evidence)

---

**Bước tiếp theo:** chạy Phần 2 (`benchmark/runners/generateFinalReport.ts`)
trên máy có network để điền số liệu thật vào mục 9, từ đó tinh chỉnh lại
Decision Matrix ở mục 7 dựa trên bằng chứng thực nghiệm thay vì chỉ lý thuyết.
