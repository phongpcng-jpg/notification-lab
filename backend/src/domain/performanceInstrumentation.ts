import { eventLoopUtilization, monitorEventLoopDelay, performance } from "node:perf_hooks";

export interface HotPathSpan {
  name: string;
  durationMs: number;
  startedAtMonoMs: number;
  finishedAtMonoMs: number;
  metadata?: Record<string, number | string | boolean>;
}

export interface HotPathTrace {
  traceId: string;
  createdAtMs: number;
  notificationIds: number[];
  eventLoop: {
    utilization: number;
    activeMs: number;
    idleMs: number;
    processDelayP99Ms: number | null;
  };
  spans: HotPathSpan[];
}

const enabled = process.env.BENCHMARK_INSTRUMENTATION !== "false";
const traces = new Map<string, HotPathTrace>();
const MAX_TRACES = 5_000;
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
if (enabled) eventLoopDelay.enable();

function p99DelayMs(): number | null {
  if (!enabled || eventLoopDelay.count === 0) return null;
  return Number(eventLoopDelay.percentile(99)) / 1_000_000;
}

function prune(): void {
  while (traces.size > MAX_TRACES) {
    const oldest = traces.keys().next().value;
    if (!oldest) break;
    traces.delete(oldest);
  }
}

export function startHotPathTrace(metadata: {
  notificationIds?: number[];
} = {}): HotPathTrace {
  const traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const trace: HotPathTrace = {
    traceId,
    createdAtMs: Date.now(),
    notificationIds: metadata.notificationIds ?? [],
    eventLoop: { utilization: 0, activeMs: 0, idleMs: 0, processDelayP99Ms: null },
    spans: [],
  };
  traces.set(traceId, trace);
  prune();
  return trace;
}

export function setTraceNotificationIds(trace: HotPathTrace, ids: number[]): void {
  trace.notificationIds = [...ids];
}

export function addHotPathSpan(
  trace: HotPathTrace | undefined,
  name: string,
  startedAtMonoMs: number,
  finishedAtMonoMs: number,
  metadata?: Record<string, number | string | boolean>
): void {
  if (!enabled || !trace) return;
  trace.spans.push({
    name,
    durationMs: Math.max(0, finishedAtMonoMs - startedAtMonoMs),
    startedAtMonoMs,
    finishedAtMonoMs,
    metadata,
  });
}

export function measureHotPath<T>(
  trace: HotPathTrace | undefined,
  name: string,
  fn: () => T,
  metadata?: Record<string, number | string | boolean>
): T {
  if (!enabled || !trace) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    addHotPathSpan(trace, name, start, performance.now(), metadata);
  }
}

export function finishHotPathTrace(trace: HotPathTrace, beforeElu: ReturnType<typeof eventLoopUtilization>): void {
  if (!enabled) return;
  const delta = eventLoopUtilization(beforeElu);
  trace.eventLoop = {
    utilization: delta.utilization,
    activeMs: delta.active,
    idleMs: delta.idle,
    processDelayP99Ms: p99DelayMs(),
  };
}

export function beginEventLoopMeasurement(): ReturnType<typeof eventLoopUtilization> {
  return eventLoopUtilization();
}

export function findHotPathTracesByNotificationIds(ids: number[]): HotPathTrace[] {
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  return [...traces.values()].filter((trace) => trace.notificationIds.some((id) => wanted.has(id)));
}

export function recordAckDbSpan(traceIds: string[], durationMs: number, batchSize: number): void {
  if (!enabled) return;
  for (const traceId of traceIds) {
    const trace = traces.get(traceId);
    if (!trace) continue;
    const end = performance.now();
    trace.spans.push({
      name: "ack.db_write",
      durationMs,
      startedAtMonoMs: end - durationMs,
      finishedAtMonoMs: end,
      metadata: { batchSize },
    });
  }
}

export function recordAckReceived(traceId: string | undefined, queueWaitMs: number): void {
  if (!enabled || !traceId) return;
  const trace = traces.get(traceId);
  if (!trace) return;
  const now = performance.now();
  trace.spans.push({
    name: "ack.received_to_flush",
    durationMs: Math.max(0, queueWaitMs),
    startedAtMonoMs: now - queueWaitMs,
    finishedAtMonoMs: now,
  });
}
