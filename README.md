# Notification Realtime Lab

Hệ thống thực nghiệm so sánh 5 kỹ thuật notification web (Short Polling,
Long Polling, SSE, WebSocket, Web Push) trên cùng một domain: đăng bài +
follow.

> **Trạng thái hiện tại: Phase 2 (4/5 transport) — Short Polling + Long
> Polling + SSE + WebSocket hoàn thành.**
> Đã có: domain model, migration, CRUD (users/follows/posts), fan-out
> notification, seed script quy mô lớn, frontend cơ bản, **4 transport đầy
> đủ** (route, React hook, UI transport selector, tests). WebSocket là
> transport 2 chiều duy nhất — có cơ chế ack thật.
> **Chưa có:** Web Push (transport cuối, khác bản chất — hoạt động cả khi
> tab đóng). Xem `docs/transport-reports/` cho chi tiết từng transport.

## 1. Requirements
- Node.js ≥ 20 (đã test với v22)
- npm ≥ 10
- Không cần cài database server riêng (SQLite là file-based)

## 2. Installation
```bash
cd backend && npm install
cd ../frontend && npm install
```

## 3. Environment variables
```bash
cd backend
cp .env.example .env
# Sửa .env nếu cần (port, VAPID key khi tới Phase Web Push, v.v.)
```

## 4. Local development

### Chạy backend
```bash
cd backend
npm run migrate   # tạo schema (idempotent, chạy lại vẫn an toàn)
npm run dev       # Fastify dev server tại http://localhost:3000
```

### Chạy frontend
```bash
cd frontend
npm run dev        # Vite dev server tại http://localhost:5173 (proxy /api -> :3000)
```

Mở `http://localhost:5173`, chọn/tạo user, follow người khác, đăng bài, xem feed.

## 5. Sinh dữ liệu lớn (users + follow graph)
```bash
cd backend
npm run seed -- --users=10000 --avgFollows=50 --seed=12345
```
Deterministic: cùng tham số → cùng dữ liệu (phục vụ benchmark tái lập được).
Xem chi tiết options trong `backend/scripts/seed.ts`.

**Lưu ý:** seed chỉ tạo user/follow/post nền cho việc đọc (feed, follower
list). Nó KHÔNG tạo notification/event — muốn test luồng notification thật,
dùng `POST /posts` (qua UI hoặc benchmark generator ở Phase 2+) trên dữ liệu
đã seed.

## 5b. Chạy test
```bash
cd backend && npm test    # vitest, dùng SQLite in-memory, không đụng data/ thật
cd frontend && npm test   # vitest, unit test cho backoff util
```

## 6. Running benchmarks
Chưa implement — xem `benchmark/README.md`.

## 7. Running stress tests
Chưa implement — sẽ dùng chung benchmark runner ở trên với scenario nặng
(Connection Storm, Fan-out lớn...).

## 8. Deployment
Chưa làm ở phase này (theo xác nhận: local trước, nghiên cứu free hosting sau).

## 9. Troubleshooting
- **`SQLITE_CANTOPEN`**: kiểm tra `DB_PATH` trong `.env`, thư mục `data/` sẽ
  tự được tạo khi chạy `npm run migrate`/`npm run dev`, nhưng nếu chạy từ
  thư mục khác `backend/` thì path tương đối sẽ sai.
- **CORS lỗi khi gọi API trực tiếp (không qua Vite proxy)**: kiểm tra
  `CORS_ORIGIN` trong `.env` khớp với origin frontend đang chạy.
- **`npm install` lỗi vì không có mạng**: project này được viết trong sandbox
  không có network access nên **chưa được `npm install`/chạy thử thật** —
  bạn cần chạy `npm install` trên máy có internet trước khi `npm run dev`.
  Nếu gặp lỗi version conflict, báo lại để điều chỉnh `package.json`.

## 10. Project structure
```
notification-lab/
├── backend/        # Fastify + TypeScript + better-sqlite3
│   ├── src/
│   │   ├── db/          # schema.sql, connection
│   │   ├── domain/      # types, NotificationService (transport-agnostic)
│   │   ├── routes/      # users, follows, posts, notifications (REST)
│   │   └── server.ts
│   └── scripts/         # migrate.ts, seed.ts
├── frontend/        # React + Vite
├── benchmark/        # scaffold, chưa implement (Phase 9+)
├── research/          # báo cáo nghiên cứu lý thuyết (Track A)
├── docs/
│   ├── architecture.md
│   └── adr/            # Architectural Decision Records
└── README.md
```

## Nguồn gốc thiết kế
Xem `docs/adr/ADR-001-tech-stack.md` cho lý do chọn Fastify/`ws`/SQLite,
và `docs/architecture.md` cho luồng dữ liệu 1 post → N notification cùng
các giới hạn (single-instance, in-process pub/sub) được ghi rõ là simplified
so với production.
