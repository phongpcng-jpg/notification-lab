import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./run.js";
import { ALL_AUTOMATABLE_TRANSPORTS, type ScenarioConfig } from "../lib/types.js";
import type { ScenarioResult } from "../lib/metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(): Record<string, string> {
  return Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...rest] = a.replace(/^--/, "").split("=");
      return [k, rest.join("=")];
    })
  );
}

/**
 * Chạy CÙNG 1 scenario config (cùng users, cùng payload, cùng duration —
 * Rule 28 benchmark fairness) tuần tự trên cả 4 transport tự động hoá được,
 * rồi in 1 bảng so sánh. KHÔNG chạy song song — chạy đồng thời sẽ khiến các
 * transport cạnh tranh CPU/băng thông lẫn nhau trên cùng máy, làm sai lệch
 * kết quả so sánh.
 */
async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.scenario && !args.config) {
    console.error("Thiếu --scenario=<id> hoặc --config=<path>");
    process.exit(1);
  }

  const scenarioPath = args.config
    ? args.config
    : join(__dirname, "..", "scenarios", `${args.scenario}.json`);
  const baseConfig = JSON.parse(readFileSync(scenarioPath, "utf-8")) as ScenarioConfig;
  if (args.subscribers) baseConfig.subscriberCount = Number(args.subscribers);
  if (args.duration) baseConfig.durationMs = Number(args.duration);

  const results: ScenarioResult[] = [];
  for (const transport of ALL_AUTOMATABLE_TRANSPORTS) {
    // Clone config mỗi lần chạy — tránh 1 transport vô tình mutate config dùng chung.
    const config: ScenarioConfig = JSON.parse(JSON.stringify(baseConfig));
    const result = await runScenario(config, transport);
    results.push(result);
    // Nghỉ giữa các lần chạy để hệ thống "nguội" hoàn toàn (đóng hết connection,
    // giải phóng file descriptor) trước khi đo transport tiếp theo.
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log("\n\n================ SO SÁNH TRANSPORT (cùng workload) ================\n");
  console.log(
    "Transport".padEnd(15) +
      "p50(ms)".padEnd(10) +
      "p95(ms)".padEnd(10) +
      "p99(ms)".padEnd(10) +
      "Delivery%".padEnd(12) +
      "Errors".padEnd(9) +
      "Reconnects"
  );
  for (const r of results) {
    const lat = r.latency;
    console.log(
      r.transport.padEnd(15) +
        String(lat?.p50Ms ?? "N/A").padEnd(10) +
        String(lat?.p95Ms ?? "N/A").padEnd(10) +
        String(lat?.p99Ms ?? "N/A").padEnd(10) +
        (r.deliveryRate !== null ? (r.deliveryRate * 100).toFixed(1) + "%" : "N/A").padEnd(12) +
        String(r.totalConnectionErrors).padEnd(9) +
        String(r.totalReconnects)
    );
  }
  console.log(
    "\nLưu ý: đây là kết quả từ 1 lần chạy duy nhất/transport. Theo Rule " +
      "'Benchmark Repeatability', không nên coi 1 lần chạy là kết luận cuối " +
      "cùng nếu workload có biến động — chạy lại nhiều lần (--scenario cùng " +
      "tham số) và so sánh variance trước khi kết luận transport nào tốt hơn."
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("So sánh transport thất bại:", err);
  process.exit(1);
});
