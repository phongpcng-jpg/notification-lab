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
  seed: number;
  durationMs: number;
  subscriberCount: number;
  postRate: {
    mode: "fixed" | "burst";
    postsPerSecond?: number;
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
  /** Monotonic benchmark clock when the transport payload is received/processed. */
  receivedAtMonoMs: number;
  /** Server-provided notification creation time. */
  serverCreatedAtMs: number;
  /** Server timestamp immediately before the transport write/response is sent. */
  serverSentAtMs: number;
}

export interface NetworkToxicSchedule {
  name: string;
  type: string;
  stream?: "upstream" | "downstream";
  toxicity?: number;
  attributes: Record<string, number>;
  enabledAtMs?: number;
  disabledAtMs?: number;
}

export interface NetworkScenarioConfig extends ScenarioConfig {
  network: {
    proxyName: string;
    listen: string;
    upstream: string;
    toxics: NetworkToxicSchedule[];
  };
}
