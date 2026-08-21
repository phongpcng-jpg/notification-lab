import http from "node:http";
import https from "node:https";
import type { ClientRequest } from "node:http";
import { apiBaseUrl } from "../lib/apiClient.js";
import type { ReceivedEvent } from "../lib/types.js";
import type { SimulatedClient, SimulatedClientOptions } from "./simulatedClient.js";

interface SsePayload {
  id: number;
  createdAt: number;
}

export class SseClient implements SimulatedClient {
  readonly clientIndex: number;
  readonly userId: number;
  readonly isSlowClient: boolean;
  readonly events: ReceivedEvent[] = [];
  errorCount = 0;
  reconnectCount = 0;

  private lastEventId = 0;
  private stopped = true;
  private req: ClientRequest | null = null;
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
    this.req?.destroy();
    this.req = null;
  }

  private open(isReconnect: boolean): void {
    if (this.stopped) return;
    if (isReconnect) this.reconnectCount++;

    const base = new URL(apiBaseUrl());
    const path = `/notifications/stream?userId=${this.userId}${
      this.lastEventId ? `&lastEventId=${this.lastEventId}` : ""
    }`;

    const requestOptions = {
      hostname: base.hostname,
      port: base.port || undefined,
      path,
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    };

    const request = base.protocol === "https:" ? https.request : http.request;
    const req = request(requestOptions, (res) => {
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.startsWith(":")) continue; // heartbeat/connected comment
          this.handleFrame(frame);
        }
      });
      res.on("error", () => this.handleDisconnect());
      res.on("end", () => this.handleDisconnect());
    });
    req.on("error", () => this.handleDisconnect());
    req.end();
    this.req = req;
  }

  private async handleFrame(frame: string): Promise<void> {
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) return;
    try {
      const payload = JSON.parse(dataLine.slice("data: ".length)) as SsePayload;
      if (this.extraDelayMs > 0) await sleep(this.extraDelayMs);
      const now = Date.now();
      this.events.push({
        notificationId: payload.id,
        postedAtMs: payload.createdAt * 1000,
        receivedAtMs: now,
      });
      this.lastEventId = Math.max(this.lastEventId, payload.id);
    } catch {
      this.errorCount++;
    }
  }

  private handleDisconnect(): void {
    if (this.stopped) return;
    this.errorCount++;
    this.reconnectTimer = setTimeout(() => this.open(true), 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
