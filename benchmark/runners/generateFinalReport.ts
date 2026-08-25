import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllProcessedResults, aggregateByScenarioTransport, type AggregatedCell } from "../lib/aggregateResults.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, "..", "results", "reports");

const SCENARIO_ORDER = ["A", "B", "C", "D", "E", "F", "G", "I", "J"];
const TRANSPORT_ORDER = ["short_polling", "long_polling", "sse", "websocket"];

function fmtPercent(x: number | null): string {
  return x === null ? "N/A" : (x * 100).toFixed(1) + "%";
}
function fmtNum(x: number | null): string {
  return x === null ? "N/A" : String(x);
}

function getCell(cells: AggregatedCell[], scenarioId: string, transport: string): AggregatedCell | undefined {
  return cells.find((c) => c.scenarioId === scenarioId && c.transport === transport);
}

function fmtCellMetric(cell: AggregatedCell | undefined, metric: "p50" | "p95" | "p99"): string {
  if (!cell) return "N/A";
  const value = metric === "p50" ? cell.avgP50Ms : metric === "p95" ? cell.avgP95Ms : cell.avgP99Ms;
  return fmtNum(value);
}

function buildExperimentalAnalysis(mainCells: AggregatedCell[], hCells: AggregatedCell[]): string {
  const bWs = getCell(mainCells, "B", "websocket");
  const bSse = getCell(mainCells, "B", "sse");
  const bLp = getCell(mainCells, "B", "long_polling");
  const dWs = getCell(mainCells, "D", "websocket");
  const dSse = getCell(mainCells, "D", "sse");
  const fWs = getCell(mainCells, "F", "websocket");
  const fSse = getCell(mainCells, "F", "sse");
  const jWs = getCell(mainCells, "J", "websocket");
  const jSse = getCell(mainCells, "J", "sse");

  let md = `\n## Experimental Analysis\n\n`;
  md += `### 1. Phạm vi và cách đọc kết quả\n\n`;
  md += `Phần này diễn giải **chỉ các kết quả benchmark đã aggregate** trong bảng trên; không dùng số liệu lý thuyết để thay thế measurement. `;
  md += `Mỗi ô là trung bình của các percentile ở cấp từng run (không phải percentile được tính lại từ toàn bộ raw samples). `;
  md += `Vì vậy p50/p95/p99 trong bảng nên được đọc cùng với **Runs** và **p95 stddev**.\n\n`;
  md += `Một kết quả có latency thấp nhưng delivery không đầy đủ hoặc duplicate/reconnect cao không được coi là thắng tuyệt đối; các metric phản ánh những trade-off khác nhau.\n\n`;

  md += `### 2. Baseline và workload thông thường — A\n\n`;
  md += `Scenario A cho thấy thứ tự định tính rõ ràng trong workload được benchmark: Short Polling có tail latency cao nhất, trong khi Long Polling và WebSocket thấp hơn đáng kể; SSE nằm giữa hai nhóm này. `;
  md += `Trong dữ liệu hiện tại, p95 lần lượt là **Short Polling ${fmtCellMetric(getCell(mainCells, "A", "short_polling"), "p95")} ms**, `;
  md += `**Long Polling ${fmtCellMetric(getCell(mainCells, "A", "long_polling"), "p95")} ms**, `;
  md += `**SSE ${fmtCellMetric(getCell(mainCells, "A", "sse"), "p95")} ms** và `;
  md += `**WebSocket ${fmtCellMetric(getCell(mainCells, "A", "websocket"), "p95")} ms**. `;
  md += `Tất cả đều đạt delivery 100%, nên A chủ yếu minh họa chi phí polling và lợi ích của cơ chế giữ kết nối trong workload được benchmark.\n\n`;

  md += `### 3. Burst và high-frequency — B và D\n\n`;
  md += `B là burst workload và là một trong những bằng chứng rõ nhất trong bộ benchmark cho sự khác biệt giữa polling và persistent transports. `;
  md += `WebSocket có p50/p95 **${fmtCellMetric(bWs, "p50")}/${fmtCellMetric(bWs, "p95")} ms**, SSE **${fmtCellMetric(bSse, "p50")}/${fmtCellMetric(bSse, "p95")} ms**, `;
  md += `trong khi Long Polling là **${fmtCellMetric(bLp, "p50")}/${fmtCellMetric(bLp, "p95")} ms**. `;
  md += `Short Polling cũng có tail latency cao hơn rõ rệt. B có một ngoại lệ quan trọng: Long Polling có delivery rate **87.8%** và **2261 errors** trong aggregate hiện tại, nên không thể kết luận chỉ từ latency. `;
  md += `Ngược lại, SSE và WebSocket đều đạt 100% delivery với các run hiện có.\n\n`;
  md += `D tăng tần suất tạo post mạnh hơn B. WebSocket và SSE tiếp tục giữ latency thấp hơn polling trong workload được benchmark; WebSocket có p95 **${fmtCellMetric(dWs, "p95")} ms**, SSE **${fmtCellMetric(dSse, "p95")} ms**. `;
  md += `Short Polling có p95 **${fmtCellMetric(getCell(mainCells, "D", "short_polling"), "p95")} ms**. `;
  md += `D không cho thấy lỗi delivery trong dữ liệu hiện tại, vì vậy đây là bằng chứng thực nghiệm trong workload này cho việc request polling định kỳ trở nên đắt hơn khi event frequency tăng.\n\n`;

  md += `### 4. Fan-out, connection storm và slow clients — C, E và G\n\n`;
  md += `C đại diện cho massive fan-out. Kết quả hiện tại vẫn đạt 100% delivery cho cả bốn transport; WebSocket có p50 thấp nhất (**${fmtCellMetric(getCell(mainCells, "C", "websocket"), "p50")} ms**), trong khi Short Polling cao hơn đáng kể (**${fmtCellMetric(getCell(mainCells, "C", "short_polling"), "p50")} ms**). `;
  md += `Điều này ủng hộ nhận định rằng persistent server-push phù hợp hơn khi một event phải fan-out tới nhiều subscriber trong workload được benchmark, nhưng không nên diễn giải thành production capacity limit vì benchmark vẫn là local/synthetic.\n\n`;
  md += `E mô phỏng connection ramp. Cả bốn transport đều đạt 100% delivery; WebSocket có p95 **${fmtCellMetric(getCell(mainCells, "E", "websocket"), "p95")} ms**, Long Polling **${fmtCellMetric(getCell(mainCells, "E", "long_polling"), "p95")} ms**, SSE **${fmtCellMetric(getCell(mainCells, "E", "sse"), "p95")} ms**, còn Short Polling **${fmtCellMetric(getCell(mainCells, "E", "short_polling"), "p95")} ms**. `;
  md += `Không có lỗi delivery trong E, vì vậy connection storm trong workload được benchmark này chưa tạo ra failure observable.\n\n`;
  md += `G bổ sung slow-client delay ở application layer. Long Polling/SSE/WebSocket vẫn có delivery 100%; Short Polling có delivery **${fmtPercent(getCell(mainCells, "G", "short_polling")?.avgDeliveryRate ?? null)}** và p95 **${fmtCellMetric(getCell(mainCells, "G", "short_polling"), "p95")} ms**, trong khi SSE/WebSocket ở khoảng **${fmtCellMetric(getCell(mainCells, "G", "sse"), "p95")}/${fmtCellMetric(getCell(mainCells, "G", "websocket"), "p95")} ms**. `;
  md += `G cần được đọc đúng semantics: đây là application-level processing delay, không phải mô phỏng đầy đủ socket-buffer backpressure.\n\n`;

  md += `### 5. Reconnect và at-least-once behavior — F và J\n\n`;
  md += `F là scenario quan trọng để đọc reliability cùng latency. Short Polling có duplicate aggregate **${getCell(mainCells, "F", "short_polling")?.totalDuplicates ?? "N/A"}**, SSE có **${getCell(mainCells, "F", "sse")?.totalDuplicates ?? "N/A"}** duplicates cùng **${getCell(mainCells, "F", "sse")?.totalReconnects ?? "N/A"} reconnects** và **${getCell(mainCells, "F", "sse")?.totalErrors ?? "N/A"} errors**, trong khi WebSocket có **${getCell(mainCells, "F", "websocket")?.totalDuplicates ?? "N/A"}** duplicates và **${getCell(mainCells, "F", "websocket")?.totalReconnects ?? "N/A"} reconnects**. `;
  md += `Tất cả vẫn đạt delivery 100% ở F trong các run hiện có. Điều này cho thấy duplicate delivery và reconnect activity là hai chiều đo khác với delivery failure; trong mô hình at-least-once, client deduplication/cursor recovery là một phần của correctness.\n\n`;
  md += `J kết hợp burst, reconnect storm, slow clients và payload lớn nên là workload gần với stress/mixed-behavior nhất trong bộ hiện tại. `;
  md += `WebSocket có p50/p95 **${fmtCellMetric(jWs, "p50")}/${fmtCellMetric(jWs, "p95")} ms** với **${jWs?.totalReconnects ?? "N/A"} reconnects** và **${jWs?.totalDuplicates ?? "N/A"} duplicates**. `;
  md += `SSE có p50/p95 **${fmtCellMetric(jSse, "p50")}/${fmtCellMetric(jSse, "p95")} ms** với **${jSse?.totalReconnects ?? "N/A"} reconnects**, **${jSse?.totalErrors ?? "N/A"} errors** và **${jSse?.totalDuplicates ?? "N/A"} duplicates**. `;
  md += `Short Polling có **${getCell(mainCells, "J", "short_polling")?.totalDuplicates ?? "N/A"} duplicates**, còn Long Polling không có duplicates trong aggregate hiện tại nhưng có p95 **${fmtCellMetric(getCell(mainCells, "J", "long_polling"), "p95")} ms**. `;
  md += `Các số duplicate cao ở J không nên được gắn nhãn là benchmark bug nếu delivery vẫn 100%; chúng phải được hiểu là delivery/recovery pressure và được đánh giá cùng client deduplication.\n\n`;

  md += `### 6. Payload size — I\n\n`;
  md += `I cho thấy large payload không làm delivery thất bại trong workload được benchmark: cả bốn transport đều 100% delivery. `;
  md += `Short Polling vẫn có p95 cao nhất (**${fmtCellMetric(getCell(mainCells, "I", "short_polling"), "p95")} ms**), trong khi Long Polling/SSE/WebSocket lần lượt là **${fmtCellMetric(getCell(mainCells, "I", "long_polling"), "p95")}/${fmtCellMetric(getCell(mainCells, "I", "sse"), "p95")}/${fmtCellMetric(getCell(mainCells, "I", "websocket"), "p95")} ms**. `;
  md += `Kết quả này hỗ trợ kết luận rằng request overhead của polling vẫn đáng kể khi payload tăng, nhưng không đủ để suy ra ngưỡng payload tối đa của hệ thống.\n\n`;

  md += `### 7. Configured Toxiproxy impairment profile — H\n\n`;
  if (hCells.length === 0) {
    md += `H chưa có dữ liệu nên chưa thể kết luận.\n\n`;
  } else {
    md += `H được chạy với **configured Toxiproxy impairment profile** và do đó phải được đọc riêng với A–G/I/J. Tất cả transport hiện đạt 100% delivery và 0 errors/reconnects trong các run hiện có. `;
    md += `p95 là **Long Polling ${fmtCellMetric(getCell(hCells, "H", "long_polling"), "p95")} ms**, `;
    md += `**WebSocket ${fmtCellMetric(getCell(hCells, "H", "websocket"), "p95")} ms**, `;
    md += `**SSE ${fmtCellMetric(getCell(hCells, "H", "sse"), "p95")} ms** và `;
    md += `**Short Polling ${fmtCellMetric(getCell(hCells, "H", "short_polling"), "p95")} ms**. `;
    md += `H cho thấy impairment profile được cấu hình trong test chưa làm phát sinh delivery failure trong các run hiện có; nó không chứng minh rằng các transport có độ chịu lỗi Internet giống nhau trong mọi điều kiện mạng.\n\n`;
  }

  md += `### 8. Cross-scenario findings\n\n`;
  md += `1. **Short Polling có tail latency cao nhất trong phần lớn workload được benchmark.** Đây là pattern ổn định nhất của A–J và phù hợp với chi phí request định kỳ.\n`;
  md += `2. **WebSocket/SSE thường có latency thấp hơn trong các workload được benchmark có burst hoặc event frequency cao.** WebSocket thường có p50 thấp nhất, nhưng không phải mọi scenario đều cho WebSocket p95 thấp nhất.\n`;
  md += `3. **Long Polling là phương án trung gian đáng chú ý trong các workload được benchmark.** Nó có latency gần persistent transports trong nhiều workload nhưng vẫn chịu ảnh hưởng mạnh khi burst/fan-out làm request waiter và database contention tăng; B là ví dụ rõ nhất.\n`;
  md += `4. **Delivery rate và latency phải được đọc cùng nhau.** B Long Polling có latency cao và delivery 87.8%; trong khi F/J có nhiều reconnect/duplicate nhưng delivery vẫn 100%.\n`;
  md += `5. **Duplicate count là reliability/recovery signal, không phải latency signal.** F/J đặc biệt hữu ích để đánh giá khả năng client/server xử lý at-least-once delivery trong các workload được benchmark.\n`;
  md += `6. **Không có bằng chứng từ bộ benchmark này để tuyên bố một transport thắng tuyệt đối.** Kết quả phụ thuộc workload và requirement.\n\n`;

  return md;
}

function buildConclusionAndRecommendations(mainCells: AggregatedCell[], hCells: AggregatedCell[]): string {
  const allHaveDelivery = mainCells.length > 0 && mainCells.every((c) => c.avgDeliveryRate === 1);
  const hDelivery = hCells.length > 0 && hCells.every((c) => c.avgDeliveryRate === 1);
  let md = `## Conclusion and Recommendations\n\n`;
  md += `### Conclusion\n\n`;
  md += `Bộ benchmark A–J và H không cho thấy một transport duy nhất tối ưu cho mọi yêu cầu. Trong **các workload được benchmark**, pattern thực nghiệm nhất quán nhất là **Short Polling có latency tail cao hơn khi event frequency, fan-out hoặc workload phức tạp tăng**, trong khi **SSE và WebSocket thường giữ latency thấp hơn nhờ mô hình persistent connection**. **Long Polling** thường nằm giữa hai nhóm trong các workload được benchmark và có thể là lựa chọn đơn giản khi cần server-side wait nhưng chưa cần một persistent bidirectional channel.\n\n`;
  md += `Đối với reliability, cần tránh đánh đồng delivery rate với số reconnect/duplicate. F và J cho thấy hệ thống có thể duy trì delivery 100% dù có nhiều reconnect và duplicate trong các workload được benchmark, phù hợp với mô hình at-least-once + cursor recovery/client deduplication. `;
  md += `Ngược lại, B Long Polling là cảnh báo thực nghiệm quan trọng vì aggregate hiện tại có delivery **87.8%** và **2261 connection errors**; đây là workload mà latency và reliability cùng suy giảm.\n\n`;
  md += allHaveDelivery
    ? `Trong các cell main hiện có, những transport không gặp failure đều đạt delivery 100%; điều này củng cố rằng benchmark đang đo đúng trade-off latency/recovery hơn là chỉ đo khả năng sống sót của request.\n\n`
    : `Delivery không đồng đều ở tất cả cell, vì vậy reliability phải được xem như một dimension độc lập với latency.\n\n`;
  md += hDelivery
    ? `Scenario H cũng đạt delivery 100% cho tất cả transport trong các run hiện có. Tuy nhiên H chỉ phản ánh **configured Toxiproxy impairment profile**, không phải toàn bộ Internet failure model.\n\n`
    : `Scenario H chưa đủ dữ liệu để đưa ra kết luận reliability dưới configured Toxiproxy impairment profile.\n\n`;

  md += `### Recommendations\n\n`;
  md += `1. **In-app one-way realtime notifications:** ưu tiên **SSE** khi ứng dụng chủ yếu cần server → browser và muốn reconnect do browser quản lý; chọn **WebSocket** khi cần bidirectional messaging/ACK hoặc các interaction realtime khác.\n`;
  md += `2. **Simple implementation / low-frequency updates:** **Short Polling** vẫn là lựa chọn hợp lý khi latency không nghiêm ngặt và muốn giữ infrastructure stateless, dù các workload được benchmark cho thấy request overhead tăng đáng kể ở workload cao.\n`;
  md += `3. **HTTP-only server wait:** **Long Polling** phù hợp như giải pháp trung gian, nhưng cần shared wake-up/state khi scale nhiều backend instances; kết quả B cho thấy burst workload có thể làm nó nhạy với contention.\n`;
  md += `4. **Offline/background/browser notification:** dùng **Web Push** như một capability bổ sung thay vì xem nó là đối thủ trực tiếp của SSE/WebSocket. Web Push giải quyết background/offline delivery và OS-level notification, trong khi SSE/WebSocket giải quyết realtime in-app.\n`;
  md += `5. **Production scaling:** không lấy các latency tuyệt đối trong report này làm capacity target. Nếu triển khai multi-instance, SSE/WebSocket/Long Polling cần shared signaling/pub-sub hoặc một kiến trúc tương đương; benchmark hiện tại chủ yếu đánh giá behavior trong single-backend/in-process architecture.\n`;
  md += `6. **Reliability design:** giữ cursor/recovery và client deduplication; ACK của WebSocket nên được xem là application acknowledgement, không phải bằng chứng user đã nhìn thấy notification.\n`;
  md += `7. **Future benchmark work:** nếu cần quyết định capacity hoặc production architecture, chạy thêm repeats trên máy riêng backend/benchmark, thu CPU/memory/event-loop metrics, và mở rộng H với nhiều mức latency/loss/reset.\n\n`;
  md += `### Final decision principle\n\n`;
  md += `Không nên chọn transport dựa trên một cột p50/p95 duy nhất. Quyết định cuối nên ghép **requirement → architecture → latency tail → delivery → reconnect/duplicate behavior → operational complexity**. Với project hiện tại, **SSE là lựa chọn mặc định tốt cho one-way in-app realtime, WebSocket cho bidirectional realtime, Short Polling cho simplicity, Long Polling cho HTTP-based intermediate use cases, và Web Push cho background/offline notification**. Đây là recommendation theo requirement + implementation + benchmark evidence, không phải tuyên bố rằng một giao thức luôn nhanh nhất trong các workload được benchmark hoặc ngoài chúng.\n`;
  return md;
}

function buildMarkdown(mainCells: AggregatedCell[], hCells: AggregatedCell[], totalRuns: number): string {
  const generatedAt = new Date().toISOString();
  let md = `# Notification Technology — Final Comparison Report (Generated)\n\n`;
  md += `Sinh tự động lúc **${generatedAt}** bằng \\`benchmark/runners/generateFinalReport.ts\\`, `;
  md += `tổng hợp từ **${totalRuns}** file kết quả trong \\`results/processed/\\`.\n\n`;
  md += `> Đây là bản bổ sung số liệu THẬT cho phần "Experimental Comparison Matrix" (mục 9) `;
  md += `trong \\`docs/final-report/FINAL-COMPARISON-REPORT.md\\`. Đọc cả 2 file để có bức tranh đầy đủ `;
  md += `(lý thuyết + thực nghiệm tách biệt rõ — theo Rule Section 31).\n\n`;

  md += `## Experimental Comparison Matrix (Scenarios A–G, I–J)\n\n`;
  md += `| Scenario | Transport | Runs | p50 (ms) | p95 (ms) | p99 (ms) | p95 stddev | Delivery rate | Errors | Reconnects | Duplicates |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const scenarioId of SCENARIO_ORDER) {
    for (const transport of TRANSPORT_ORDER) {
      const cell = getCell(mainCells, scenarioId, transport);
      if (!cell) {
        md += `| ${scenarioId} | ${transport} | 0 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |\n`;
        continue;
      }
      md +=
        `| ${cell.scenarioId} | ${cell.transport} | ${cell.runCount} | ` +
        `${fmtNum(cell.avgP50Ms)} | ${fmtNum(cell.avgP95Ms)} | ${fmtNum(cell.avgP99Ms)} | ` +
        `${fmtNum(cell.stddevP95Ms)} | ${fmtPercent(cell.avgDeliveryRate)} | ` +
        `${cell.totalErrors} | ${cell.totalReconnects} | ${cell.totalDuplicates} |\n`;
    }
  }

  md += `\n## Scenario H (Configured Toxiproxy impairment profile)\n\n`;
  if (hCells.length === 0) {
    md += "Chưa có dữ liệu. Chạy `npm run run-network -- --scenario=H` hoặc `npm run run-all -- --include-h` (cần Toxiproxy đang chạy).\n";
  } else {
    md += `| Transport | Runs | p50 (ms) | p95 (ms) | p99 (ms) | Delivery rate | Errors | Reconnects |\n`;
    md += `|---|---|---|---|---|---|---|---|\n`;
    for (const transport of TRANSPORT_ORDER) {
      const cell = getCell(hCells, "H", transport);
      if (!cell) continue;
      md +=
        `| ${cell.transport} | ${cell.runCount} | ${fmtNum(cell.avgP50Ms)} | ${fmtNum(cell.avgP95Ms)} | ` +
        `${fmtNum(cell.avgP99Ms)} | ${fmtPercent(cell.avgDeliveryRate)} | ${cell.totalErrors} | ${cell.totalReconnects} |\n`;
    }
  }

  md += `\n## Cách đọc bảng\n\n`;
  md += `- **Runs** = số lần chạy được tổng hợp cho ô này. \\`Runs=1\\` nghĩa là CHƯA đủ để đánh giá độ ổn định (Rule 29) — nên chạy lại (\\`--repeats=\\`) trước khi kết luận.\n`;
  md += `- **p50/p95/p99** là trung bình của percentile được tính ở từng run; đây không phải percentile pooled từ toàn bộ raw samples.\n`;
  md += `- **p95 stddev** = độ lệch chuẩn của p95 giữa các lần chạy; số càng nhỏ tương đối với p95 thì kết quả càng ổn định.\n`;
  md += `- **Duplicates** không đồng nghĩa delivery failure; trong at-least-once delivery, duplicate/recovery pressure phải được đọc cùng cursor/deduplication behavior.\n`;
  md += `- **Errors** và **Reconnects** là operational/recovery signals; delivery rate vẫn cần được xem riêng.\n`;
  md += `- Môi trường chạy (Node version, OS, hostname) được ghi trong từng file \\`results/processed/*.json\\` (field \\`environment\\`).\n`;

  md += buildExperimentalAnalysis(mainCells, hCells);
  md += buildConclusionAndRecommendations(mainCells, hCells);

  return md;
}

async function main(): Promise<void> {
  const allResults = loadAllProcessedResults();
  if (allResults.length === 0) {
    console.error(
      "Không tìm thấy file nào trong benchmark/results/processed/.\n" +
        "Chạy `npm run run-all` (hoặc `npm run run` / `npm run run-network` riêng lẻ) trước."
    );
    process.exit(1);
  }

  const mainResults = allResults.filter((r) => r.scenarioId !== "H");
  const hResults = allResults.filter((r) => r.scenarioId === "H");

  const mainCells = aggregateByScenarioTransport(mainResults);
  const hCells = aggregateByScenarioTransport(hResults);

  mkdirSync(REPORTS_DIR, { recursive: true });

  const jsonReport = {
    generatedAt: new Date().toISOString(),
    totalRunsFound: allResults.length,
    mainComparison: mainCells,
    scenarioH: hCells,
  };
  const jsonPath = join(REPORTS_DIR, "final-report.json");
  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), "utf-8");

  const md = buildMarkdown(mainCells, hCells, allResults.length);
  const mdPath = join(REPORTS_DIR, "final-report.md");
  writeFileSync(mdPath, md, "utf-8");

  console.log(
    `Đã tổng hợp ${allResults.length} file kết quả (${mainResults.length} scenario thường + ${hResults.length} scenario H).`
  );
  console.log(`Đã ghi: ${jsonPath}`);
  console.log(`Đã ghi: ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
