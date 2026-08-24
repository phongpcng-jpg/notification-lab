# ADR-001: Tech Stack Selection

**Status:** Accepted (2026-08-18)

## Context
Cần chọn stack JS/TS để implement 5 kỹ thuật notification (Short Polling,
Long Polling, SSE, WebSocket, Web Push) và benchmark chúng công bằng với nhau,
trong môi trường dev local, DB SQLite theo yêu cầu ban đầu.

## Options considered

### Backend framework
- **Express** — phổ biến nhất, nhưng overhead per-request cao hơn khi cần đo
  latency chính xác ở benchmark.
- **Fastify** — nhanh hơn Express theo tài liệu chính thức của Fastify
  (fastify.dev), có schema validation built-in, có `@fastify/websocket` chính thức.
- **Raw `http`/`node:http2`** — kiểm soát tối đa nhưng tốn công viết lại
  routing/middleware, không cần thiết ở giai đoạn này.

**Decision: Fastify.** Lý do: cân bằng giữa hiệu năng (quan trọng vì đây là
benchmark project) và tốc độ phát triển; có support SSE/WS native tốt.

### WebSocket library
- **Socket.IO** — API cao cấp, tiện, nhưng có fallback/protocol overhead
  (namespace, ack, packet encoding) làm nhiễu benchmark WebSocket "thuần".
- **`ws`** — thư viện thấp cấp, implement đúng RFC 6455, không thêm abstraction.

**Decision: `ws`.** Vì mục tiêu là đo đúng hành vi WebSocket chuẩn, không phải
đo hiệu năng của Socket.IO. Trade-off: phải tự viết reconnect/rooms/broadcast
logic (chấp nhận được, đây đúng là nội dung cần nghiên cứu theo yêu cầu).

### Database
- **SQLite (better-sqlite3)** — theo yêu cầu ban đầu của user, sync API giúp
  code đơn giản hơn (không cần async/await lồng nhau cho mọi query), phù hợp
  chạy trong môi trường Claude Code / máy cá nhân không cần setup DB server
  riêng. Giới hạn: single-writer, không phù hợp multi-instance thật (ghi rõ ở
  ADR-003 khi bàn tới horizontal scaling).

### Frontend
- **React + Vite** — theo lựa chọn của user.

## Consequences
- Vì single Fastify instance + SQLite, benchmark multi-instance/broadcast qua
  Redis Pub/Sub (theo yêu cầu gốc cho WebSocket khi scale) là **out of scope**
  ở phase hiện tại, trừ khi có yêu cầu thêm.
- `ws` yêu cầu tự viết heartbeat, reconnect, broadcast và ACK handling. Các
  trách nhiệm này **đã được implement trong WebSocket transport hiện tại**;
  chúng không còn là công việc Phase 2 chưa thực hiện.

## Evidence
- Fastify vs Express benchmark: xem fastify.dev/docs/latest/Guides/Benchmarking
  (Tier 1, official docs) — sẽ trích dẫn cụ thể trong `research/` khi viết
  research report cho từng transport, không lấy con số cụ thể ở đây vì
  benchmark của project tại thời điểm ADR được chấp nhận chưa có kết quả
  benchmark chính thức được ghi nhận.
- Benchmark framework hiện tại hỗ trợ việc chạy và aggregate kết quả cho
  Short Polling, Long Polling, SSE và WebSocket; Web Push có workflow riêng
  và không nằm trong common benchmark matrix.
- ADR này không ghi lại các con số performance cụ thể; các numerical benchmark
  results phải lấy từ output được sinh bởi benchmark report generator.
