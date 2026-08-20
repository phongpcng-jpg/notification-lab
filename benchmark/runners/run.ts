import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHealth, createPost } from "../lib/apiClient.js";
import { pickPublisher } from "../lib/pickPublisher.js";
import { generateScript } from "../lib/payload.js";
import { mulberry32 } from "../lib/random.js";
import { buildScenarioResult } from "../lib/metrics.js";
import { writeScenarioResult, printSummary } from "../lib/report.js";
import { createSimulatedClient } from "../generators/clientFactory.js";
import { ALL_AUTOMATABLE_TRANSPORTS, type ScenarioConfig, type Transport } from "../lib/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(): Record<string, string> {
  return Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...rest] = a.replace(/^--/, "").split("=");
      return [k, rest.join("=")];
    })
  );
}

function loadScenarioConfig(args: Record<string, string>): ScenarioConfig {
  const scenarioPath = args.config
    ? args.config
    : join(__dirname, "..", "scenarios", `${args.scenario}.json`);
  const raw = readFileSync(scenarioPath, "utf-8");
  const config = JSON.parse(raw) as ScenarioConfig;

  // Overrides từ CLI — cho phép điều chỉnh nhanh mà không sửa file JSON,
  // ví dụ tăng Scenario C lên đúng quy mô 100k mà không tạo 1 file config riêng.
  if (args.subscribers) config.subscriberCount = Number(args.subscribers);
  if (args.duration) config.durationMs = Number(args.duration);
  if (args["posts-per-second"]) {
    config.postRate.mode = "fixed";
    config.postRate.postsPerSecond = Number(args["posts-per-second"]);
  }
  if (args["burst-size"]) {
    config.postRate.mode = "burst";
    config.postRate.burstSize = Number(args["burst-size"]);
  }
  return config;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runScenario(
  config: ScenarioConfig,
  transport: Transport
): Promise<import("../lib/metrics.js").ScenarioResult> {
  console.log(`\n>>> Chạy scenario ${config.id} (${config.name}) trên transport=${transport}`);

  const healthy = await checkHealth();
  if (!healthy) {
    throw new Error(
      "Backend không phản hồi tại /health. Chạy `cd backend && npm run dev` trước khi benchmark."
    );
  }

  const { publisherId, followerIds } = await pickPublisher(config.subscriberCount);
  const subscriberIds = followerIds.slice(0, config.subscriberCount);
  console.log(
    `Publisher: user#${publisherId} — dùng ${subscriberIds.length}/${config.subscriberCount} follower làm subscriber`
  );

  const rng = mulberry32(config.seed);
  const slowRatio = config.slowClients?.ratio ?? 0;
  const slowExtraDelayMs = config.slowClients?.extraDelayMs ?? 0;

  const clients = subscriberIds.map((userId, i) => {
    const isSlow = config.slowClients ? rng() < slowRatio : false;
    return createSimulatedClient(transport, {
      clientIndex: i,
      userId,
      isSlowClient: isSlow,
      slowClientExtraDelayMs: slowExtraDelayMs,
    });
  });

  const startedAt = new Date();

  // ── Kết nối clients: connection storm (ramp-up) hoặc mở đồng loạt ──
  if (config.connectionStorm?.enabled) {
    const rampUpMs = config.connectionStorm.rampUpMs;
    const delayPerClient = clients.length > 0 ? rampUpMs / clients.length : 0;
    console.log(
      `Connection storm: mở ${clients.length} kết nối trong ${rampUpMs}ms (~${delayPerClient.toFixed(1)}ms/client)`
    );
    for (const c of clients) {
      void c.connect();
      if (delayPerClient > 0) await sleep(delayPerClient);
    }
  } else {
    await Promise.all(clients.map((c) => c.connect()));
  }

  // Grace period để catch-up (nếu có) hoàn tất trước khi bắt đầu đo.
  await sleep(500);

  // ── Reconnect storm: lên lịch disconnect+reconnect đồng loạt tại các mốc thời gian ──
  const reconnectTimers: ReturnType<typeof setTimeout>[] = [];
  if (config.reconnectStorm?.enabled) {
    for (const atMs of config.reconnectStorm.atMs) {
      const timer = setTimeout(async () => {
        console.log(`Reconnect storm tại t=${atMs}ms: ngắt + kết nối lại ${clients.length} client`);
        await Promise.all(clients.map((c) => c.disconnect()));
        await Promise.all(clients.map((c) => c.connect()));
      }, atMs);
      reconnectTimers.push(timer);
    }
  }

  // ── Post generator ──
  let postsCreated = 0;
  const postGenStop = { stopped: false };

  async function runFixedRate(): Promise<void> {
    const rate = config.postRate.postsPerSecond ?? 1;
    const intervalMs = 1000 / rate;
    while (!postGenStop.stopped) {
      await createPost(publisherId, generateScript(config.payloadSize));
      postsCreated++;
      await sleep(intervalMs);
    }
  }

  async function runBurstRate(): Promise<void> {
    const burstSize = config.postRate.burstSize ?? 10;
    const intervalMs = config.postRate.burstIntervalMs ?? 10_000;
    while (!postGenStop.stopped) {
      const burstPromises: Promise<unknown>[] = [];
      for (let i = 0; i < burstSize && !postGenStop.stopped; i++) {
        burstPromises.push(createPost(publisherId, generateScript(config.payloadSize)));
        postsCreated++;
      }
      await Promise.all(burstPromises);
      await sleep(intervalMs);
    }
  }

  const postGenPromise =
    config.postRate.mode === "burst" ? runBurstRate() : runFixedRate();

  await sleep(config.durationMs);
  postGenStop.stopped = true;
  await postGenPromise.catch((err) => {
    console.error("[postGenerator] lỗi:", err);
  });

  for (const t of reconnectTimers) clearTimeout(t);

  // Grace period cho message cuối cùng kịp tới trước khi đóng kết nối.
  await sleep(2000);

  await Promise.all(clients.map((c) => c.disconnect()));
  const finishedAt = new Date();

  const result = buildScenarioResult({
    scenarioId: config.id,
    scenarioName: config.name,
    transport,
    startedAt,
    finishedAt,
    config,
    publisherId,
    requestedSubscriberCount: config.subscriberCount,
    postsCreated,
    perClient: clients.map((c) => ({
      clientIndex: c.clientIndex,
      userId: c.userId,
      isSlowClient: c.isSlowClient,
      events: c.events,
      errorCount: c.errorCount,
      reconnectCount: c.reconnectCount,
    })),
  });

  printSummary(result);
  const paths = writeScenarioResult(result);
  console.log(`Raw:       ${paths.rawPath}`);
  console.log(`Processed: ${paths.processedPath}`);
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.scenario && !args.config) {
    console.error(
      "Thiếu --scenario=<id> (ví dụ --scenario=A) hoặc --config=<path>.\n" +
        `Transport hợp lệ (--transport=): ${ALL_AUTOMATABLE_TRANSPORTS.join(", ")}`
    );
    process.exit(1);
  }
  const transport = (args.transport ?? "sse") as Transport;
  if (!ALL_AUTOMATABLE_TRANSPORTS.includes(transport)) {
    console.error(
      `Transport không hợp lệ: ${transport}. Hợp lệ: ${ALL_AUTOMATABLE_TRANSPORTS.join(", ")}\n` +
        "(Web Push không chạy qua runner này — xem benchmark/README.md)"
    );
    process.exit(1);
  }

  const config = loadScenarioConfig(args);
  await runScenario(config, transport);
  process.exit(0);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error("Benchmark thất bại:", err);
    process.exit(1);
  });
}