export type Transport = "short_polling" | "long_polling" | "sse" | "websocket";

export const ALL_AUTOMATABLE_TRANSPORTS: Transport[] = [
  "short_polling",
  "long_polling",
  "sse",
  "websocket",
];
// Web Push KHÔNG nằm trong danh sách này — nó không có "client polling/streaming
// loop" để mô phỏng giống 4 transport trên (xem benchmark/README.md, mục Web Push).

export interface ScenarioConfig {
  id: string;
  name: string;
  description: string;
  /** Seed cho RNG nội bộ benchmark (chọn client nào là "slow client", v.v.) — tái lập được. */
  seed: number;
  durationMs: number;
  /** Số follower (đã seed sẵn trong DB) sẽ được dùng làm simulated client. */
  subscriberCount: number;
  postRate: {
    mode: "fixed" | "burst";
    /** dùng khi mode='fixed' — publisher tạo post đều đặn theo tốc độ này */
    postsPerSecond?: number;
    /** dùng khi mode='burst' — publisher tạo `burstSize` post gần như đồng thời mỗi `burstIntervalMs` */
    burstSize?: number;
    burstIntervalMs?: number;
  };
  payloadSize: "small" | "medium" | "large";
  connectionStorm?: { enabled: boolean; rampUpMs: number };
  reconnectStorm?: { enabled: boolean; atMs: number[] };
  slowClients?: { ratio: number; extraDelayMs: number };
}

export interface ReceivedEvent {
  notificationId: number;
  /** created_at do server gán (quy đổi ra ms) — dùng để tính latency. */
  postedAtMs: number;
  /** Date.now() phía client (giả lập) tại thời điểm nhận được message. */
  receivedAtMs: number;
}

/**
 * Cấu hình riêng cho Scenario H (Poor Network) — CHỈ được đọc bởi
 * `runners/runNetworkScenario.ts`. Mở rộng ScenarioConfig với thông tin
 * proxy + danh sách toxic cần Toxiproxy áp dụng.
 */
export interface NetworkToxicSchedule {
  name: string;
  type: string;
  stream?: "upstream" | "downstream";
  toxicity?: number;
  attributes: Record<string, number>;
  /** Bật toxic này tại mốc thời gian (ms, tính từ lúc scenario bắt đầu). Bỏ trống = bật ngay từ đầu. */
  enabledAtMs?: number;
  /** Tắt toxic này tại mốc thời gian (ms). Bỏ trống = giữ tới hết scenario. */
  disabledAtMs?: number;
}

export interface NetworkScenarioConfig extends ScenarioConfig {
  network: {
    proxyName: string;
    /** host:port mà benchmark client sẽ kết nối tới (Toxiproxy lắng nghe ở đây) */
    listen: string;
    /** host:port của backend thật — Toxiproxy forward tới đây */
    upstream: string;
    toxics: NetworkToxicSchedule[];
  };
}
