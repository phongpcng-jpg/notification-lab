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

const __dirname = dirname(fileURLToPath(import.meta.url));

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
      `File config ${scenarioPath} không có field "network" — đây không phải ` +
        "1 NetworkScenarioConfig hợp lệ cho runNetworkScenario.ts. Dùng runners/run.ts " +
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

  // ── Kiểm tra Toxiproxy — CHỈ scenario này cần, không ảnh hưởng scenario khác ──
  const reachable = await isToxiproxyReachable();
  if (!reachable) {
    console.error(
      "\nKhông kết nối được Toxiproxy Admin API.\n" +
        `Đã thử: ${process.env.TOXIPROXY_API_URL ?? "http://localhost:8474"}\n\n` +
        "Scenario H (Poor Network) cần Toxiproxy đang chạy — các scenario khác (A-G, I, J) " +
        "KHÔNG cần và không bị ảnh hưởng bởi việc này.\n\n" +
        "Khởi động Toxiproxy trước:\n" +
        "  toxiproxy-server\n" +
        "(hoặc chỉnh TOXIPROXY_API_URL nếu bạn chạy ở port khác port mặc định 8474)\n"
    );
    process.exit(1);
  }

  // Kiểm tra backend thật (đi thẳng, KHÔNG qua proxy) trước khi setup toxic.
  const upstreamHealthUrl = `http://${config.network.upstream}/health`;
  try {
    const res = await fetch(upstreamHealthUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(
      `Backend không phản hồi tại ${upstreamHealthUrl}. Chạy \`cd backend && npm run dev\` trước.\n` +
        `Lỗi: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
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

  // Bật ngay các toxic không có enabledAtMs; lên lịch cho các toxic có mốc thời gian riêng.
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
    await runScenario(config, transport);
  } finally {
    // Dọn dẹp LUÔN CHẠY dù runScenario lỗi giữa chừng — không để proxy/toxic
    // sót lại ảnh hưởng tới lần chạy benchmark tiếp theo (kể cả scenario khác).
    for (const t of pendingTimers) clearTimeout(t);
    resetApiBaseUrl();
    await deleteProxyIfExists(config.network.proxyName);
    console.log(`\n>>> Đã dọn dẹp proxy "${config.network.proxyName}" — các scenario khác không bị ảnh hưởng.`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Scenario H thất bại:", err);
  process.exit(1);
});
