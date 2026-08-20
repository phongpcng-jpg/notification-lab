# Notification Realtime Lab

Hệ thống thực nghiệm so sánh 5 kỹ thuật notification web (Short Polling,
Long Polling, SSE, WebSocket, Web Push) trên cùng một domain: đăng bài +
follow.

> **Trạng thái hiện tại: Phase 2 (5/5 transport) + Benchmark Framework (Phase
> 9-11) HOÀN THÀNH.**
> Đã có: domain model, migration, CRUD, fan-out notification, seed script,
> frontend đầy đủ 5 transport, và **benchmark framework hoàn chỉnh**: 4/5
> transport tự động hoá được (Web Push benchmark riêng, giới hạn ghi rõ),
> 10/10 scenario A-J implement được (Scenario H dùng Toxiproxy, thiết kế độc
> lập — chỉ H mới cần Toxiproxy đang chạy, 9 scenario còn lại không bị ảnh
> hưởng), thu thập metrics (latency percentile, delivery rate, duplicate,
> error, reconnect), so sánh cross-transport tự động.
> **CHƯA CÓ LẦN CHẠY THẬT NÀO** — sandbox viết code này không có network để
> `npm install`. Mọi số liệu benchmark là `PENDING` cho tới khi bạn tự chạy.
> **Chưa làm:** deploy free hosting (để sau theo xác nhận), báo cáo so sánh
> cuối cùng (cần số liệu thật trước).

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
npm run generate-vapid-keys   # in ra VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY, dán vào .env
```
Web Push sẽ tự bị bỏ qua (không lỗi) nếu bạn chưa chạy bước sinh VAPID key —
4 transport còn lại hoạt động bình thường không cần bước này.

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

Mở `http://localhost:5173`, chọn/tạo user, follow người khác, đăng bài, xem
feed. Chọn transport ở panel "Notification (realtime)" — mở 2 trình duyệt/2
tab với 2 user khác nhau (1 người follow người kia) để thấy notification
thật khi đăng bài.

**Web Push cần lưu ý:** bấm nút "Bật thông báo đẩy" (không tự động — trình
duyệt yêu cầu user gesture), rồi có thể đóng tab để test — notification vẫn
hiện ra qua OS. Chạy trên `localhost` không cần HTTPS thật (ngoại lệ của
trình duyệt).

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
```bash
cd benchmark
npm install
npm run run-all              # 9 scenario × 4 transport × 3 lần lặp (mặc định)
npm run report                # tổng hợp -> results/reports/final-report.{json,md}
```
Chạy nặng hơn / gồm cả Scenario H (cần Toxiproxy):
```bash
npm run run-all -- --repeats=5 --subscriber-scale=10 --duration-scale=2 --include-h
npm run report
```
Xem `benchmark/README.md` cho đầy đủ flag, và `docs/final-report/FINAL-COMPARISON-REPORT.md`
cho báo cáo template (lý thuyết đầy đủ, thực nghiệm chờ số liệu thật từ `npm run report`).

## 7. Running stress tests
Dùng chung framework ở mục 6 — các scenario C (Massive Fan-out), E
(Connection Storm), F (Reconnection Storm) chính là stress test. Tăng
`--subscribers=` để đẩy tải lên cao hơn mức mặc định trong config.

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
│   │   ├── domain/      # NotificationService, 5 transport hub/sender, types
│   │   ├── routes/      # users, follows, posts, notifications + 5 transport routes
│   │   ├── test/         # helpers.ts dùng chung cho mọi test file
│   │   └── server.ts / app.ts
│   └── scripts/         # migrate.ts, seed.ts, generateVapidKeys.ts
├── frontend/        # React + Vite
│   ├── public/sw.js      # Service Worker cho Web Push
│   └── src/transports/   # 1 hook/module riêng cho mỗi transport + backoff dùng chung
├── benchmark/        # framework benchmark hoàn chỉnh — CHƯA CÓ LẦN CHẠY THẬT
│   ├── lib/             # apiClient, pickPublisher, metrics, report (dùng chung)
│   ├── generators/       # 1 SimulatedClient/transport (4/5, Web Push riêng)
│   ├── runners/            # run.ts, runAll.ts, runNetworkScenario.ts, compareTransports.ts,
│   │                          webPushDispatch.ts, generateFinalReport.ts
│   └── scenarios/            # 10/10 scenario config (A-J), H dùng Toxiproxy
├── research/          # báo cáo nghiên cứu lý thuyết (Track A)
├── docs/
│   ├── architecture.md
│   ├── adr/                 # Architectural Decision Records
│   ├── transport-reports/    # báo cáo riêng cho từng transport (5 file)
│   └── final-report/           # báo cáo so sánh cuối cùng (template + số liệu thật khi có)
└── README.md
```

## Nguồn gốc thiết kế
Xem `docs/adr/ADR-001-tech-stack.md` cho lý do chọn Fastify/`ws`/SQLite,
và `docs/architecture.md` cho luồng dữ liệu 1 post → N notification cùng
các giới hạn (single-instance, in-process pub/sub) được ghi rõ là simplified
so với production.
