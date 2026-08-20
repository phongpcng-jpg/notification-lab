import { apiBaseUrl } from "../lib/apiClient.js";
import type { ReceivedEvent } from "../lib/types.js";
import type { SimulatedClient, SimulatedClientOptions } from "./simulatedClient.js";

interface LongPollResponse {
  notifications: Array<{ id: number; created_at: number }>;
  nextAfter: number;
  timedOut: boolean;
}

export class LongPollingClient implements SimulatedClient {
  readonly clientIndex: number;
  readonly userId: number;
  readonly isSlowClient: boolean;
  readonly events: ReceivedEvent[] = [];
  errorCount = 0;
  reconnectCount = 0; // long polling luôn "mở lại request" — không tính là reconnect thật

  private after = 0;
  private stopped = true;
  private abortController: AbortController | null = null;
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
    this.abortController?.abort();
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const res = await fetch(
        `${apiBaseUrl()}/notifications/long-poll?userId=${this.userId}&after=${this.after}`,
        { signal: controller.signal }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as LongPollResponse;

      if (this.extraDelayMs > 0 && body.notifications.length > 0) {
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

      if (!this.stopped) void this.loop();
    } catch (err) {
      if (controller.signal.aborted) return; // do disconnect() chủ động — không tính lỗi
      this.errorCount++;
      if (!this.stopped) {
        setTimeout(() => void this.loop(), 1000);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
