import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROCESSED_DIR = join(__dirname, "..", "results", "processed");

/** Shape khớp với `processed` object mà `lib/report.ts` ghi ra (ScenarioResult trừ perClient). */
export interface ProcessedResult {
  scenarioId: string;
  scenarioName: string;
  transport: string;
  startedAt: string;
  finishedAt: string;
  environment: { node: string; platform: string; arch: string; hostname: string };
  publisherId: number;
  requestedSubscriberCount: number;
  actualSubscriberCount: number;
  postsCreated: number;
  totalNotificationsExpected: number;
  totalEventsReceivedRaw: number;
  totalEventsReceivedUnique: number;
  totalDuplicates: number;
  deliveryRate: number | null;
  totalConnectionErrors: number;
  totalReconnects: number;
  latency: {
    count: number;
    minMs: number;
    p50Ms: number;
    p90Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    meanMs: number;
  } | null;
  perClientCount: number;
  slowClientCount: number;
  config: unknown;
}

/** Đọc TOÀN BỘ file trong results/processed/ — không quan tâm tên file, chỉ đọc nội dung. */
export function loadAllProcessedResults(): ProcessedResult[] {
  let files: string[] = [];
  try {
    files = readdirSync(PROCESSED_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // thư mục chưa tồn tại — chưa chạy benchmark lần nào
  }
  const results: ProcessedResult[] = [];
  for (const f of files) {
    try {
      results.push(JSON.parse(readFileSync(join(PROCESSED_DIR, f), "utf-8")));
    } catch (err) {
      console.warn(`[aggregateResults] Bỏ qua file lỗi ${f}:`, err);
    }
  }
  return results;
}

export interface AggregatedCell {
  scenarioId: string;
  scenarioName: string;
  transport: string;
  /** Số lần chạy được tổng hợp — càng nhiều càng đáng tin (Rule 29). */
  runCount: number;
  avgP50Ms: number | null;
  avgP95Ms: number | null;
  avgP99Ms: number | null;
  /** Độ lệch chuẩn của p95 GIỮA CÁC LẦN CHẠY — đo độ ổn định, không phải variance trong 1 lần chạy. */
  stddevP95Ms: number | null;
  avgDeliveryRate: number | null;
  totalErrors: number;
  totalReconnects: number;
  totalDuplicates: number;
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function stddev(nums: number[]): number | null {
  if (nums.length < 2) return null; // cần tối thiểu 2 điểm mới có ý nghĩa
  const m = mean(nums)!;
  const variance = nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(variance);
}

function roundOrNull(x: number | null, decimals = 0): number | null {
  if (x === null) return null;
  const factor = 10 ** decimals;
  return Math.round(x * factor) / factor;
}

/**
 * Gộp nhiều lần chạy CÙNG (scenarioId, transport) thành 1 cell tổng hợp.
 * Không tự phán "tốt/xấu" — chỉ trình bày số liệu đo được, để người đọc tự
 * đối chiếu với Decision Matrix lý thuyết (tránh vi phạm Rule 6 — không kết
 * luận tuyệt đối từ 1 phép đo).
 */
export function aggregateByScenarioTransport(results: ProcessedResult[]): AggregatedCell[] {
  const groups = new Map<string, ProcessedResult[]>();
  for (const r of results) {
    const key = `${r.scenarioId}::${r.transport}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const cells: AggregatedCell[] = [];
  for (const [key, group] of groups) {
    const [scenarioId, transport] = key.split("::");
    const p50s = group.map((g) => g.latency?.p50Ms).filter((x): x is number => x != null);
    const p95s = group.map((g) => g.latency?.p95Ms).filter((x): x is number => x != null);
    const p99s = group.map((g) => g.latency?.p99Ms).filter((x): x is number => x != null);
    const rates = group.map((g) => g.deliveryRate).filter((x): x is number => x != null);

    cells.push({
      scenarioId,
      scenarioName: group[0].scenarioName,
      transport,
      runCount: group.length,
      avgP50Ms: roundOrNull(mean(p50s)),
      avgP95Ms: roundOrNull(mean(p95s)),
      avgP99Ms: roundOrNull(mean(p99s)),
      stddevP95Ms: roundOrNull(stddev(p95s), 1),
      avgDeliveryRate: mean(rates),
      totalErrors: group.reduce((a, g) => a + g.totalConnectionErrors, 0),
      totalReconnects: group.reduce((a, g) => a + g.totalReconnects, 0),
      totalDuplicates: group.reduce((a, g) => a + g.totalDuplicates, 0),
    });
  }
  return cells;
}
