import type { WebSocket } from "ws";
import { PushHub, type PushSubscriptionBase } from "./pushHub.js";

export interface WsSubscription extends PushSubscriptionBase {
  socket: WebSocket;
  connectionId: number;
}

export const wsHub = new PushHub<WsSubscription>();
