import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./run.js";
import { setApiBaseUrl, resetApiBaseUrl } from "../lib/apiClient.js";
import {
  isToxiproxyReachable,
  createProxy,
  deleteProxyIfExists,
  addToxic,
  removeToxic,
} from "../lib/toxiproxyClient.js";
import type { NetworkScenarioConfig, Transport } from "../lib/types.js";
import { ALL_AUTOMATABLE_TRANSPORTS } from "../lib/types.js";
import type { ScenarioResult } from "../lib/metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Logic lõi của Scenario H — tách thành hàm export được để `runAll.ts` có
 * thể gọi khi có flag `--include-h`, mà KHÔNG cần tự viết lại orchestration.
 * Đây là hàm DUY NHẤT trong toàn bộ benchmark/ đụng tới Toxiproxy — file nào
 * không gọi hàm này thì hoàn toàn không cần Toxiproxy đang chạy.
 */
export async function runScenarioH(
  config: NetworkScenarioConfig,
  transport: Transport
): Promise<ScenarioResult> {
  const reachable = await isToxiproxyReachable();
  if (!reachable) {
    throw new Error(
      "Không kết nối được Toxiproxy Admin API " +
        `(${process.env.TOXIPROXY_API_URL ?? "http://localhost:8474"}). ` +
        "Chạy `toxiproxy-server` trước khi gọi runScenarioH()."
    );
  }

  const upstreamHealthUrl = `http://${config.network.upstream}/health`;
  const healthRes = await fetch(upstreamHealthUrl).catch(() => null);
  if (!healthRes || !healthRes.ok) {
    throw new Error(`Backend không phản hồi tại ${upstreamHealthUrl}.`);
  }

  console.log(
    `\n>>> Scenario H qua Toxiproxy: proxy "${config.network.proxyName}" ` +
      `${config.network.listen} -> ${config.network.upstream}`
  );

  await createProxy({
    name: config.network.proxyName,
    listen: config.network.listen,
    upstream: config.network.upstream,
  });

  const pendingTimers: ReturnType<typeof setTimeout>[] = [];

  for (const toxic of config.network.toxics) {
    if (toxic.enabledAtMs === undefined) {
      await addToxic(config.network.proxyName, toxic);
      console.log(`  toxic "${toxic.name}" (${toxic.type}) bật ngay từ đầu`);
    } else {
      const t = setTimeout(async () => {
        await addToxic(config.network.proxyName, toxic);
        console.log(`  toxic "${toxic.name}" (${toxic.type}) bật tại t=${toxic.enabledAtMs}ms`);
      }, toxic.enabledAtMs);
      pendingTimers.push(t);
    }
    if (toxic.disabledAtMs !== undefined) {
      const t = setTimeout(async () => {
        await removeToxic(config.network.proxyName, toxic.name);
        console.log(`  toxic "${toxic.name}" tắt tại t=${toxic.disabledAtMs}ms`);
      }, toxic.disabledAtMs);
      pendingTimers.push(t);
    }
  }

  setApiBaseUrl(`http://${config.network.listen}`);

  try {
    return await runScenario(config, transport);
  } finally {
    for (const t of pendingTimers) clearTimeout(t);
    resetApiBaseUrl();
    await deleteProxyIfExists(config.network.proxyName);
    console.log(`\n>>> Đã dọn dẹp proxy "${config.network.proxyName}".`);
  }
}

// ─────────────────────────── CLI wrapper mỏng ───────────────────────────

function parseArgs(): Record<string, string> {
  return Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...rest] = a.replace(/^--/, "").split("=");
      return [k, rest.join("=")];
    })
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  const scenarioPath = args.config
    ? args.config
    : join(__dirname, "..", "scenarios", `${args.scenario ?? "H"}.json`);
  const config = JSON.parse(readFileSync(scenarioPath, "utf-8")) as NetworkScenarioConfig;

  if (!config.network) {
    console.error(
      `File config ${scenarioPath} không có field "network" — dùng runners/run.ts ` +
        "cho các scenario thường (A-G, I, J)."
    );
    process.exit(1);
  }
  if (args.subscribers) config.subscriberCount = Number(args.subscribers);
  if (args.duration) config.durationMs = Number(args.duration);

  const transport = (args.transport ?? "sse") as Transport;
  if (!ALL_AUTOMATABLE_TRANSPORTS.includes(transport)) {
    console.error(`Transport không hợp lệ: ${transport}. Hợp lệ: ${ALL_AUTOMATABLE_TRANSPORTS.join(", ")}`);
    process.exit(1);
  }

  try {
    await runScenarioH(config, transport);
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// Chỉ chạy main() khi file này được gọi trực tiếp (tsx runners/runNetworkScenario.ts),
// KHÔNG chạy khi được import bởi runAll.ts — tránh side-effect ngoài ý muốn.
if (process.argv[1] && process.argv[1].endsWith("runNetworkScenario.ts")) {
  main().catch((err) => {
    console.error("Scenario H thất bại:", err);
    process.exit(1);
  });
}
