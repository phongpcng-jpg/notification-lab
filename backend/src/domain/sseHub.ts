import { PushHub, type PushSubscriptionBase } from "./pushHub.js";

/** SSE dùng thẳng PushHub — không cần dữ liệu riêng ngoài onNotification/forceClose. */
export type SseSubscription = PushSubscriptionBase;

export const sseHub = new PushHub<SseSubscription>();
