import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScenarioResult } from "./metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_ROOT = join(__dirname, "..", "results");

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Ghi CẢ 2 bản: raw (đầy đủ per-client event list — nặng nhưng đầy đủ để
 * điều tra lại sau) và processed (chỉ số liệu tổng hợp — nhẹ, dùng để so
 * sánh nhanh giữa các lần chạy). Rule 50 — raw data must be preserved.
 */
export function writeScenarioResult(result: ScenarioResult): {
  rawPath: string;
  processedPath: string;
} {
  const slug = `${result.scenarioId}-${result.transport}-${timestampSlug()}`;

  const rawDir = join(RESULTS_ROOT, "raw");
  const processedDir = join(RESULTS_ROOT, "processed");
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(processedDir, { recursive: true });

  const rawPath = join(rawDir, `${slug}.json`);
  writeFileSync(rawPath, JSON.stringify(result, null, 2), "utf-8");

  // processed = raw nhưng bỏ perClient chi tiết (giữ lại số lượng client,
  // không giữ từng event) — vẫn đủ để dựng bảng so sánh, nhẹ hơn nhiều.
  const { perClient, ...summary } = result;
  const processed = {
    ...summary,
    perClientCount: perClient.length,
    slowClientCount: perClient.filter((c) => c.isSlowClient).length,
  };
  const processedPath = join(processedDir, `${slug}.json`);
  writeFileSync(processedPath, JSON.stringify(processed, null, 2), "utf-8");

  return { rawPath, processedPath };
}

export function printSummary(result: ScenarioResult): void {
  const lat = result.latency;
  console.log("\n" + "=".repeat(60));
  console.log(`Scenario: ${result.scenarioId} — ${result.scenarioName}`);
  console.log(`Transport: ${result.transport}`);
  console.log(`Publisher: user#${result.publisherId}`);
  console.log(
    `Subscribers: ${result.actualSubscriberCount} thực tế / ${result.requestedSubscriberCount} yêu cầu`
  );
  console.log(`Posts created: ${result.postsCreated}`);
  console.log(`Notifications expected: ${result.totalNotificationsExpected}`);
  console.log(
    `Events received: ${result.totalEventsReceivedUnique} unique ` +
      `(+${result.totalDuplicates} duplicate) / raw=${result.totalEventsReceivedRaw}`
  );
  console.log(
    `Delivery rate: ${
      result.deliveryRate !== null ? (result.deliveryRate * 100).toFixed(1) + "%" : "N/A"
    }`
  );
  console.log(`Connection errors: ${result.totalConnectionErrors}`);
  console.log(`Reconnects: ${result.totalReconnects}`);
  if (lat) {
    console.log(
      `Latency (ms): min=${lat.minMs} p50=${lat.p50Ms} p90=${lat.p90Ms} ` +
        `p95=${lat.p95Ms} p99=${lat.p99Ms} max=${lat.maxMs} mean=${lat.meanMs}`
    );
  } else {
    console.log("Latency (ms): N/A — not measured (không có event nào nhận được)");
  }
  console.log("=".repeat(60) + "\n");
}
