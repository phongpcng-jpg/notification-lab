# Notification Realtime Lab

Hệ thống thực nghiệm so sánh 5 kỹ thuật notification web trên cùng một domain: đăng bài + follow.

- Short Polling
- Long Polling
- Server-Sent Events (SSE)
- WebSocket
- Web Push

> **Trạng thái hiện tại:** 5/5 transport đã được implement; benchmark framework đã hoàn thiện cho 4 transport (Short Polling, Long Polling, SSE, WebSocket), còn Web Push có workflow riêng. Scenario A–J đã được định nghĩa; Scenario H là network scenario chạy riêng với Toxiproxy.
>
> **Lưu ý về benchmark:** framework và methodology đã có, nhưng chỉ các kết quả được sinh từ benchmark và lưu trong `benchmark/results/processed/` mới được dùng làm experimental evidence. Các lần chạy thủ công/local không tự động trở thành official benchmark result.

## 1. Requirements

- Node.js ≥ 20
- npm ≥ 10
- Không cần cài database server riêng: backend dùng SQLite (`better-sqlite3`).

## 2. Installation

Cài dependency cho từng phần:

```bash
cd backend
npm install

cd ../frontend
npm install

cd ../benchmark
npm install
```

## 3. Environment variables

### Backend

```bash
cd backend
cp .env.example .env
npm run generate-vapid-keys
```

`generate-vapid-keys` in ra `VAPID_PUBLIC_KEY` và `VAPID_PRIVATE_KEY`; không commit key thật vào Git.

Các biến chính trong `backend/.env` gồm:

- `PORT` — port Fastify.
- `DB_PATH` — đường dẫn SQLite database.
- `LONG_POLL_TIMEOUT_MS` — timeout tối đa của Long Polling.
- `SHORT_POLL_INTERVAL_MS` — interval được server gợi ý cho Short Polling client.
- `SSE_HEARTBEAT_MS` — heartbeat SSE.
- `WS_HEARTBEAT_MS` — WebSocket heartbeat.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — Web Push.
- `CORS_ORIGIN` — origin frontend được phép gọi backend.
- `BENCHMARK_API_KEY` — secret cho benchmark internal API, nếu sử dụng.
- `LOG_LEVEL` — log level.

Xem `backend/.env.example` để biết giá trị mặc định và chú thích đầy đủ.

### Frontend

```bash
cd frontend
cp .env.example .env
```

`VITE_API_BASE_URL` là **public origin của backend**, không thêm `/api`.

- Local development: có thể để trống để dùng Vite proxy `/api`.
- Production/Render: đặt thành URL public của backend, ví dụ `https://<backend>.onrender.com`.

Frontend tự suy ra WebSocket URL từ backend origin và kết nối tới `/ws`.

## 4. Local development

### Chạy backend

```bash
cd backend
npm run migrate
npm run dev
```

Fastify chạy mặc định tại `http://localhost:3000`.

> `server.ts` cũng gọi migration idempotent khi process khởi động. Chạy `npm run migrate` riêng ở local vẫn hữu ích để chuẩn bị/kiểm tra database trước khi phát triển hoặc test.

### Chạy frontend

```bash
cd frontend
npm run dev
```

Vite chạy mặc định tại `http://localhost:5173`. Khi `VITE_API_BASE_URL` để trống, Vite proxy các request `/api` tới backend local. Khi biến này được cấu hình, frontend gọi backend trực tiếp.

Mở `http://localhost:5173`, chọn/tạo user, follow người khác, đăng bài và chọn transport trong panel **Notification (realtime)**. Có thể mở hai tab/trình duyệt với hai user khác nhau để quan sát notification.

### Web Push local

Bấm **Bật thông báo đẩy** để tạo subscription; browser yêu cầu user gesture nên việc này không tự động. `localhost` là secure context được browser hỗ trợ cho local Web Push testing, không cần HTTPS thật.

## 5. Sinh dữ liệu lớn

```bash
cd backend
npm run seed -- --users=10000 --avgFollows=50 --seed=12345
```

Seed deterministic: cùng tham số sẽ tạo cùng dữ liệu nền. Seed tạo users/follows/posts phục vụ feed và follower graph; nó không tự tạo notification/event cho benchmark notification. Muốn tạo notification thật, dùng `POST /posts` qua UI/API hoặc benchmark generator.

## 6. Chạy test

```bash
cd backend
npm test

cd ../frontend
npm test
```

Backend tests dùng SQLite in-memory trong test setup; frontend tests kiểm tra các transport utilities/backoff hiện có.

## 7. Running benchmarks

```bash
cd benchmark
npm install
npm run run-all
npm run report
```

`run-all` mặc định chạy **9 scenario × 4 transport × 3 repeats** cho common benchmark matrix:

```text
A B C D E F G I J
×
Short Polling / Long Polling / SSE / WebSocket
```

Scenario H là network scenario riêng, dùng Toxiproxy:

```bash
npm run run-all -- --include-h
```

Có thể tăng repeats/subscriber/duration khi cần:

```bash
npm run run-all -- --repeats=5 --subscriber-scale=10 --duration-scale=2
npm run report
```

`npm run report` tạo:

```text
benchmark/results/reports/final-report.md
benchmark/results/reports/final-report.json
```

Template/reference cho report cuối nằm ở `docs/final-report/FINAL-COMPARISON-REPORT.md`; template không bị `npm run report` ghi đè.

Xem `benchmark/README.md` để biết đầy đủ flags, metrics và methodology.

## 8. Web Push benchmark / dispatch

Web Push không nằm trong common 4-transport benchmark matrix vì end-to-end browser receipt phụ thuộc Service Worker và Push Service. Project có workflow dispatch riêng:

```bash
cd benchmark
npm run webpush-dispatch
```

Không dùng thời gian server dispatch như bằng chứng rằng OS/browser notification đã hiển thị cho user.

## 9. Running stress tests

Stress scenarios dùng chung benchmark framework:

- **C** — Massive Fan-out
- **E** — Connection Storm
- **F** — Reconnection behavior
- **G** — Slow clients / application-level delay
- **J** — Mixed workload

Tăng `--subscribers`, `--subscriber-scale` hoặc `--duration-scale` khi cần. Scenario F không có cùng ý nghĩa reconnect lifecycle đối với Short Polling vì Short Polling không duy trì persistent connection.

## 10. Deployment

Branch `feature/render-deployment` hỗ trợ tách frontend và backend khi deploy. Hiện branch này đang được cấu hình với **hai Render services** dùng cùng repository:

| Service | Root directory | URL | Auto deploy |
|---|---|---|---|
| Backend `notification-lab` | `backend` | `https://notification-lab.onrender.com` | **Tắt** — deploy thủ công |
| Frontend `notification-lab-1` | `frontend` | `https://notification-lab-1.onrender.com` | **Bật** — theo commit |

Các thông tin trên phản ánh cấu hình Render hiện tại; nếu service được tạo lại hoặc đổi tên/URL thì cần cập nhật phần này.

### Backend trên Render

Service backend hiện dùng:

- Root directory: `backend/`
- Runtime: Node
- Plan: Free
- Health check: `/health`
- Số instance: `1`
- Region: Oregon
- Start command:

```bash
npm start
```

Build command hiện được cấu hình trên Render là:

```bash
npm install && npm run seed -- --users=2000 --avgFollows=200 --seed=12345 && npm run build
```

> Build hiện tại có bước `seed` để chuẩn bị dataset cho môi trường Render. Đây là cấu hình deployment hiện tại, **không phải yêu cầu của production build** và không thay thế bước seed tùy chỉnh khi benchmark/local.

Render cung cấp `PORT`; backend bind vào `0.0.0.0` và port được environment cung cấp. Thiết lập `CORS_ORIGIN` thành **public URL của frontend**:

```text
CORS_ORIGIN=https://notification-lab-1.onrender.com
```

Thiết lập các secret/config cần thiết trong Render Environment Variables, đặc biệt VAPID keys nếu dùng Web Push và `BENCHMARK_API_KEY` nếu benchmark gọi internal delivery-attempts endpoint.

Vì **auto deploy backend đang tắt**, sau khi push commit mới lên `feature/render-deployment` cần trigger deploy backend thủ công trên Render trước khi test backend production. Frontend hiện auto deploy theo commit.

### Frontend trên Render

Service frontend hiện là Render Static Site:

- Root directory: `frontend/`
- Build command:

```bash
npm install && npm run build
```

- Publish directory:

```text
dist
```

- Auto deploy: bật theo commit trên `feature/render-deployment`.
- Set `VITE_API_BASE_URL` thành:

```text
https://notification-lab.onrender.com
```

Không thêm `/api`.

Frontend production sẽ gọi trực tiếp backend HTTP và WebSocket (`/ws`); Vite `/api` proxy chỉ dành cho local development.

### SQLite trên Render

`DB_PATH` mặc định là `./data/notification-lab.db`. SQLite là local file storage của backend và không phải managed database. Nếu deployment cần dữ liệu tồn tại qua service restart/redeploy, phải cấu hình persistent disk/storage phù hợp với hosting; nếu không, không nên coi SQLite trên ephemeral filesystem là durable production storage.

## 11. Troubleshooting

- **`SQLITE_CANTOPEN`**: kiểm tra `DB_PATH` và bảo đảm thư mục chứa database tồn tại/có quyền ghi. Chạy `npm run migrate` trước lần chạy local đầu tiên.
- **CORS lỗi**: kiểm tra `CORS_ORIGIN` khớp chính xác với frontend origin. Khi frontend chạy trên Render, không dùng `http://localhost:5173`.
- **Frontend production gọi sai API**: kiểm tra `VITE_API_BASE_URL`; giá trị này là backend public origin và **không** có `/api` ở cuối.
- **WebSocket không kết nối production**: kiểm tra backend public URL, `/ws` endpoint và proxy/hosting có hỗ trợ WebSocket.
- **Web Push không hoạt động**: kiểm tra `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, browser permission và subscription.
- **Benchmark không có kết quả**: kiểm tra backend đang chạy, `BENCHMARK_API_KEY` nếu benchmark endpoint yêu cầu, và xem `benchmark/results/processed/` trước khi chạy `npm run report`.
- **Scenario H thất bại**: kiểm tra Toxiproxy đang chạy và chỉ chạy H khi network fault injection đã được cấu hình.

## 12. Project structure

```text
notification-lab/
├── backend/                 # Fastify + TypeScript + better-sqlite3
│   ├── src/
│   │   ├── db/              # schema.sql, connection
│   │   ├── domain/          # NotificationService, transport hubs/senders, types
│   │   ├── routes/          # users, follows, posts, notifications + transport routes
│   │   ├── test/             # shared test helpers
│   │   └── server.ts / app.ts
│   └── scripts/             # migrate, seed, VAPID keys, schema copy
├── frontend/                # React + Vite
│   ├── public/sw.js          # Service Worker cho Web Push
│   └── src/transports/       # transport modules + shared backoff
├── benchmark/               # benchmark framework
│   ├── lib/                 # API client, metrics, helpers
│   ├── generators/          # simulated clients for common transports
│   ├── runners/             # run, run-all, network, compare, report, Web Push
│   ├── scenarios/           # A-J scenario configurations
│   └── results/              # processed inputs and generated reports
├── research/                # research material
├── docs/
│   ├── architecture.md
│   ├── adr/                 # Architectural Decision Records
│   ├── transport-reports/   # one report per transport
│   └── final-report/        # final comparison report template
└── README.md
```

## 13. Documentation

- `docs/architecture.md` — kiến trúc và data flow hiện tại.
- `docs/transport-reports/` — phân tích riêng cho Short Polling, Long Polling, SSE, WebSocket và Web Push.
- `docs/final-report/FINAL-COMPARISON-REPORT.md` — template/reference cho final comparison report.
- `docs/adr/ADR-001-tech-stack.md` — rationale cho Fastify, `ws`, SQLite và React/Vite.
- `benchmark/README.md` — benchmark commands, scenarios, metrics và methodology.

## Nguồn gốc thiết kế

Xem `docs/adr/ADR-001-tech-stack.md` cho lý do chọn Fastify/`ws`/SQLite, và `docs/architecture.md` cho luồng dữ liệu 1 post → N notification cùng các giới hạn như single-instance/in-process signaling được ghi rõ là simplified so với production.
