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
