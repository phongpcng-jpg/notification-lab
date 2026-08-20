import type { ReceivedEvent } from "../lib/types.js";

export interface SimulatedClient {
  readonly clientIndex: number;
  readonly userId: number;
  readonly isSlowClient: boolean;
  readonly events: ReceivedEvent[];
  errorCount: number;
  reconnectCount: number;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface SimulatedClientOptions {
  clientIndex: number;
  userId: number;
  isSlowClient: boolean;
  /** Độ trễ nhân tạo (ms) mà "slow client" thêm vào TRƯỚC KHI coi là đã xử lý xong 1 event. */
  slowClientExtraDelayMs: number;
}
