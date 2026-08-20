import os from "node:os";

export interface PercentileStats {
  count: number;
  minMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

/** Trả về null nếu không có sample nào — KHÔNG bịa số liệu (Rule 51). */
export function computePercentiles(samplesMs: number[]): PercentileStats | null {
  if (samplesMs.length === 0) return null;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const pick = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: pick(0.5),
    p90Ms: pick(0.9),
    p95Ms: pick(0.95),
    p99Ms: pick(0.99),
    maxMs: sorted[sorted.length - 1],
    meanMs: Math.round((sum / sorted.length) * 100) / 100,
  };
}

export interface PerClientSummary {
  clientIndex: number;
  userId: number;
  isSlowClient: boolean;
  receivedCount: number;
  duplicateCount: number;
  errorCount: number;
  reconnectCount: number;
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  transport: string;
  startedAt: string;
  finishedAt: string;
  environment: {
    node: string;
    platform: string;
    arch: string;
    hostname: string;
  };
  config: unknown;
  publisherId: number;
  requestedSubscriberCount: number;
  actualSubscriberCount: number;
  postsCreated: number;
  /** = postsCreated * actualSubscriberCount (fan-out lý thuyết, KHÔNG tính duplicate) */
  totalNotificationsExpected: number;
  /** Tổng event nhận được, tính cả duplicate */
  totalEventsReceivedRaw: number;
  /** Đã loại duplicate theo (clientIndex, notificationId) */
  totalEventsReceivedUnique: number;
  totalDuplicates: number;
  /** unique / expected — 1.0 nghĩa là mọi client nhận đủ đúng 1 lần mọi notification kỳ vọng */
  deliveryRate: number | null;
  totalConnectionErrors: number;
  totalReconnects: number;
  latency: PercentileStats | null;
  perClient: PerClientSummary[];
}

export function buildScenarioResult(params: {
  scenarioId: string;
  scenarioName: string;
  transport: string;
  startedAt: Date;
  finishedAt: Date;
  config: unknown;
  publisherId: number;
  requestedSubscriberCount: number;
  postsCreated: number;
  perClient: Array<{
    clientIndex: number;
    userId: number;
    isSlowClient: boolean;
    events: Array<{ notificationId: number; postedAtMs: number; receivedAtMs: number }>;
    errorCount: number;
    reconnectCount: number;
  }>;
}): ScenarioResult {
  const actualSubscriberCount = params.perClient.length;
  const totalNotificationsExpected = params.postsCreated * actualSubscriberCount;

  const allLatencies: number[] = [];
  let totalRaw = 0;
  let totalUnique = 0;
  let totalDuplicates = 0;
  let totalErrors = 0;
  let totalReconnects = 0;

  const perClientSummary: PerClientSummary[] = params.perClient.map((c) => {
    totalRaw += c.events.length;
    const seen = new Set<number>();
    let dup = 0;
    for (const e of c.events) {
      if (seen.has(e.notificationId)) {
        dup++;
      } else {
        seen.add(e.notificationId);
        allLatencies.push(e.receivedAtMs - e.postedAtMs);
      }
    }
    totalUnique += seen.size;
    totalDuplicates += dup;
    totalErrors += c.errorCount;
    totalReconnects += c.reconnectCount;
    return {
      clientIndex: c.clientIndex,
      userId: c.userId,
      isSlowClient: c.isSlowClient,
      receivedCount: c.events.length,
      duplicateCount: dup,
      errorCount: c.errorCount,
      reconnectCount: c.reconnectCount,
    };
  });

  return {
    scenarioId: params.scenarioId,
    scenarioName: params.scenarioName,
    transport: params.transport,
    startedAt: params.startedAt.toISOString(),
    finishedAt: params.finishedAt.toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
    },
    config: params.config,
    publisherId: params.publisherId,
    requestedSubscriberCount: params.requestedSubscriberCount,
    actualSubscriberCount,
    postsCreated: params.postsCreated,
    totalNotificationsExpected,
    totalEventsReceivedRaw: totalRaw,
    totalEventsReceivedUnique: totalUnique,
    totalDuplicates,
    deliveryRate:
      totalNotificationsExpected > 0 ? totalUnique / totalNotificationsExpected : null,
    totalConnectionErrors: totalErrors,
    totalReconnects,
    latency: computePercentiles(allLatencies),
    perClient: perClientSummary,
  };
}
