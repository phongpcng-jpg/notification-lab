import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./run.js";
import { ALL_AUTOMATABLE_TRANSPORTS, type ScenarioConfig, type NetworkScenarioConfig, type Transport } from "../lib/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 9 scenario mặc định — KHÔNG gồm H (theo đúng thiết kế: H là flag riêng, không
// nằm trong lần chạy đầy đủ mặc định).
const DEFAULT_SCENARIOS = ["A", "B", "C", "D", "E", "F", "G", "I", "J"];

function parseArgs(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of process.argv.slice(2)) {
    const stripped = a.replace(/^--/, "");
    const eq = stripped.indexOf("=");
    if (eq === -1) {
      out[stripped] = true; // cờ dạng --include-h (không có "=value")
    } else {
      out[stripped.slice(0, eq)] = stripped.slice(eq + 1);
    }
  }
  return out;
}

function loadScenarioConfig(id: string): ScenarioConfig {
  const p = join(__dirname, "..", "scenarios", `${id}.json`);
  return JSON.parse(readFileSync(p, "utf-8"));
}

/**
 * Scale tham số để chạy "nặng" hơn trên máy mạnh, KHÔNG cần sửa tay 9 file
 * JSON. Nhân đều subscriberCount/durationMs theo hệ số — giữ nguyên TỈ LỆ
 * tương đối giữa các scenario (Scenario D vẫn nặng hơn Scenario A theo đúng
 * tỉ lệ thiết kế gốc), chỉ đổi độ lớn tuyệt đối.
 */
function applyScale(
  config: ScenarioConfig,
  subscriberScale: number,
  durationScale: number
): ScenarioConfig {
  const cloned: ScenarioConfig = JSON.parse(JSON.stringify(config));
  cloned.subscriberCount = Math.max(1, Math.round(cloned.subscriberCount * subscriberScale));
  cloned.durationMs = Math.max(1000, Math.round(cloned.durationMs * durationScale));
  return cloned;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const args = parseArgs();

  const scenarios = typeof args.scenarios === "string" ? args.scenarios.split(",") : DEFAULT_SCENARIOS;
  const transports = (
    typeof args.transports === "string" ? args.transports.split(",") : ALL_AUTOMATABLE_TRANSPORTS
  ) as Transport[];
  const repeats = Number(args.repeats ?? 3);
  const subscriberScale = Number(args["subscriber-scale"] ?? 1);
  const durationScale = Number(args["duration-scale"] ?? 1);
  const includeH = args["include-h"] === true || args["include-h"] === "true";

  for (const t of transports) {
    if (!ALL_AUTOMATABLE_TRANSPORTS.includes(t)) {
      console.error(`Transport không hợp lệ: ${t}. Hợp lệ: ${ALL_AUTOMATABLE_TRANSPORTS.join(", ")}`);
      process.exit(1);
    }
  }

  const totalRuns = scenarios.length * transports.length * repeats;
  console.log(
    `\n=== runAll ===\n` +
      `Scenarios: ${scenarios.join(", ")}\n` +
      `Transports: ${transports.join(", ")}\n` +
      `Repeats: ${repeats}\n` +
      `Scale: subscriber x${subscriberScale}, duration x${durationScale}\n` +
      `Include Scenario H (Toxiproxy): ${includeH ? "CÓ" : "KHÔNG"}\n` +
      `Tổng số lần chạy (chưa tính H): ${totalRuns}\n`
  );

  let runIndex = 0;
  const failures: string[] = [];

  for (const scenarioId of scenarios) {
    const baseConfig = loadScenarioConfig(scenarioId);
    for (const transport of transports) {
      for (let rep = 1; rep <= repeats; rep++) {
        runIndex++;
        console.log(
          `\n[${runIndex}/${totalRuns}] Scenario ${scenarioId} — ${transport} — lần ${rep}/${repeats}`
        );
        const config = applyScale(baseConfig, subscriberScale, durationScale);
        try {
          await runScenario(config, transport);
        } catch (err) {
          const msg = `Scenario ${scenarioId}/${transport}/run${rep}: ${err instanceof Error ? err.message : String(err)}`;
          console.error(`  LỖI: ${msg}`);
          failures.push(msg);
        }
        // Nghỉ giữa các lần chạy để hệ thống "nguội" (đóng hết connection cũ)
        // trước khi bắt đầu lần tiếp theo — tránh nhiễu chéo giữa các lần đo.
        await sleep(2000);
      }
    }
  }

  if (includeH) {
    console.log("\n=== Scenario H (--include-h) ===");
    // Import động — CHỈ tải module Toxiproxy khi thực sự cần, giữ đúng thiết
    // kế "các scenario khác không phụ thuộc Toxiproxy dù có --include-h hay không".
    const { runScenarioH } = await import("./runNetworkScenario.js");
    const { isToxiproxyReachable } = await import("../lib/toxiproxyClient.js");

    const reachable = await isToxiproxyReachable();
    if (!reachable) {
      const msg =
        "--include-h được set nhưng Toxiproxy không phản hồi — BỎ QUA Scenario H, " +
        "không dừng toàn bộ các scenario khác đã chạy xong ở trên.";
      console.warn(`  ${msg}`);
      failures.push(msg);
    } else {
      const hConfig = loadScenarioConfig("H") as NetworkScenarioConfig;
      for (const transport of transports) {
        for (let rep = 1; rep <= repeats; rep++) {
          runIndex++;
          console.log(`\n[H] ${transport} — lần ${rep}/${repeats}`);
          const config = applyScale(hConfig, subscriberScale, durationScale) as NetworkScenarioConfig;
          config.network = hConfig.network; // applyScale không đụng field "network", nhưng gán lại cho chắc
          try {
            await runScenarioH(config, transport);
          } catch (err) {
            const msg = `Scenario H/${transport}/run${rep}: ${err instanceof Error ? err.message : String(err)}`;
            console.error(`  LỖI: ${msg}`);
            failures.push(msg);
          }
          await sleep(2000);
        }
      }
    }
  }

  console.log(`\n=== Hoàn tất runAll: ${runIndex} lần chạy, ${failures.length} lỗi ===`);
  if (failures.length > 0) {
    console.log("Chi tiết lỗi:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(
    "\nChạy `npm run report` để tổng hợp kết quả trong results/processed/ thành báo cáo cuối cùng."
  );

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("runAll thất bại:", err);
  process.exit(1);
});
