import WebSocket from "ws";
import { wsBaseUrl } from "../lib/apiClient.js";
import type { ReceivedEvent } from "../lib/types.js";
import type { SimulatedClient, SimulatedClientOptions } from "./simulatedClient.js";

interface WsNotificationPayload {
  id: number;
  createdAt: number;
}

export class WebSocketClient implements SimulatedClient {
  readonly clientIndex: number;
  readonly userId: number;
  readonly isSlowClient: boolean;
  readonly events: ReceivedEvent[] = [];
  errorCount = 0;
  reconnectCount = 0;

  private after = 0;
  private stopped = true;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly extraDelayMs: number;

  constructor(opts: SimulatedClientOptions) {
    this.clientIndex = opts.clientIndex;
    this.userId = opts.userId;
    this.isSlowClient = opts.isSlowClient;
    this.extraDelayMs = opts.isSlowClient ? opts.slowClientExtraDelayMs : 0;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.open(false);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  private open(isReconnect: boolean): void {
    if (this.stopped) return;
    if (isReconnect) this.reconnectCount++;

    const socket = new WebSocket(`${wsBaseUrl()}/ws?userId=${this.userId}&after=${this.after}`);
    this.socket = socket;

    socket.on("message", (raw) => {
      void this.handleMessage(raw as Buffer, socket);
    });
    socket.on("close", () => this.handleDisconnect());
    socket.on("error", () => {
      this.errorCount++;
    });
  }

  private async handleMessage(raw: Buffer, socket: WebSocket): Promise<void> {
    let msg: { type?: string; data?: WsNotificationPayload };
    try {
      msg = JSON.parse(raw.toString("utf-8"));
    } catch {
      this.errorCount++;
      return;
    }
    if (msg.type !== "notification" || !msg.data) return;

    if (this.extraDelayMs > 0) await sleep(this.extraDelayMs);

    const now = Date.now();
    this.events.push({
      notificationId: msg.data.id,
      postedAtMs: msg.data.createdAt * 1000,
      receivedAtMs: now,
    });
    this.after = Math.max(this.after, msg.data.id);

    // Gửi ack giống frontend thật — để đo đúng chi phí round-trip 2 chiều
    // của WebSocket khi benchmark, không chỉ đo 1 chiều server->client.
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: "ack", notificationId: msg.data.id }));
    }
  }

  private handleDisconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => this.open(true), 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
