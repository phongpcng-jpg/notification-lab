import { apiBaseUrl } from "../lib/apiClient.js";
import type { ReceivedEvent } from "../lib/types.js";
import type { SimulatedClient, SimulatedClientOptions } from "./simulatedClient.js";

interface PollResponse {
  notifications: Array<{ id: number; created_at: number }>;
  nextAfter: number;
  suggestedIntervalMs: number;
}

export class ShortPollingClient implements SimulatedClient {
  readonly clientIndex: number;
  readonly userId: number;
  readonly isSlowClient: boolean;
  readonly events: ReceivedEvent[] = [];
  errorCount = 0;
  reconnectCount = 0; // short polling không có khái niệm "reconnect" — luôn 0

  private after = 0;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly extraDelayMs: number;

  constructor(opts: SimulatedClientOptions) {
    this.clientIndex = opts.clientIndex;
    this.userId = opts.userId;
    this.isSlowClient = opts.isSlowClient;
    this.extraDelayMs = opts.isSlowClient ? opts.slowClientExtraDelayMs : 0;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    void this.loop();
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try {
      const res = await fetch(
        `${apiBaseUrl()}/notifications/poll?userId=${this.userId}&after=${this.after}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PollResponse;

      if (this.extraDelayMs > 0 && body.notifications.length > 0) {
        // Slow client: mô phỏng xử lý chậm TRƯỚC KHI ghi nhận đã nhận —
        // đẩy lùi receivedAtMs, ảnh hưởng trực tiếp tới latency đo được.
        await sleep(this.extraDelayMs);
      }
      const now = Date.now();
      for (const n of body.notifications) {
        this.events.push({
          notificationId: n.id,
          postedAtMs: n.created_at * 1000,
          receivedAtMs: now,
        });
      }
      this.after = body.nextAfter;

      if (!this.stopped) {
        this.timer = setTimeout(() => void this.loop(), body.suggestedIntervalMs);
      }
    } catch {
      this.errorCount++;
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.loop(), 1000);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
