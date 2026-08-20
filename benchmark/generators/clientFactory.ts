import type { Transport } from "../lib/types.js";
import type { SimulatedClient, SimulatedClientOptions } from "./simulatedClient.js";
import { ShortPollingClient } from "./shortPollingClient.js";
import { LongPollingClient } from "./longPollingClient.js";
import { SseClient } from "./sseClient.js";
import { WebSocketClient } from "./websocketClient.js";

export function createSimulatedClient(
  transport: Transport,
  opts: SimulatedClientOptions
): SimulatedClient {
  switch (transport) {
    case "short_polling":
      return new ShortPollingClient(opts);
    case "long_polling":
      return new LongPollingClient(opts);
    case "sse":
      return new SseClient(opts);
    case "websocket":
      return new WebSocketClient(opts);
    default: {
      const exhaustive: never = transport;
      throw new Error(`Transport không hỗ trợ trong benchmark: ${exhaustive}`);
    }
  }
}
