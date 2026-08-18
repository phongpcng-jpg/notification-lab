# Benchmark Framework — chưa implement (Phase 9-11)

Thư mục này sẽ chứa:

```
benchmark/
├── scenarios/     # config JSON cho từng scenario A-J (users, rate, payload, duration, seed)
├── generators/     # Node.js script mô phỏng client (HTTP/WS/SSE) theo Assumption A2
├── runners/         # script chạy 1 scenario, ghi kết quả vào results/raw
└── results/
    ├── raw/         # dữ liệu thô từng lần chạy (KHÔNG commit số liệu giả — Rule 51)
    ├── processed/   # dữ liệu đã tổng hợp (p50/p95/p99, mean, stddev)
    └── reports/     # báo cáo so sánh cuối cùng
```

**Trạng thái hiện tại: PENDING — chưa có scenario nào được chạy.**
Không có số liệu benchmark nào trong repo này là thật cho tới khi chạy
`benchmark/runners/*` thực tế trên máy bạn. Mọi bảng performance trong
`docs/` sẽ ghi `N/A — not measured` cho tới lúc đó.

Sẽ được implement ở Phase 9 (sau khi cả 5 transport hoàn thành ở Phase 3-7).
