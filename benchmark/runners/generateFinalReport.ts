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

function buildMarkdown(mainCells: AggregatedCell[], hCells: AggregatedCell[], totalRuns: number): string {
  const generatedAt = new Date().toISOString();
  let md = `# Notification Technology — Final Comparison Report (Generated)\n\n`;
  md += `Sinh tự động lúc **${generatedAt}** bằng \`benchmark/runners/generateFinalReport.ts\`, `;
  md += `tổng hợp từ **${totalRuns}** file kết quả trong \`results/processed/\`.\n\n`;
  md += `> Đây là bản bổ sung số liệu THẬT cho phần "Experimental Comparison Matrix" (mục 9) `;
  md += `trong \`docs/final-report/FINAL-COMPARISON-REPORT.md\`. Đọc cả 2 file để có bức tranh đầy đủ `;
  md += `(lý thuyết + thực nghiệm tách biệt rõ, không trộn — theo Rule Section 31).\n\n`;

  md += `## Experimental Comparison Matrix (9 scenario A-J trừ H)\n\n`;
  md += `| Scenario | Transport | Runs | p50 (ms) | p95 (ms) | p99 (ms) | p95 stddev | Delivery rate | Errors | Reconnects | Duplicates |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const scenarioId of SCENARIO_ORDER) {
    for (const transport of TRANSPORT_ORDER) {
      const cell = mainCells.find((c) => c.scenarioId === scenarioId && c.transport === transport);
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

  md += `\n## Scenario H (Poor Network qua Toxiproxy) — tách riêng khỏi bảng trên\n\n`;
  if (hCells.length === 0) {
    md += "Chưa có dữ liệu. Chạy `npm run run-network -- --scenario=H` hoặc ";
    md += "`npm run run-all -- --include-h` (cần Toxiproxy đang chạy).\n";
  } else {
    md += `| Transport | Runs | p50 (ms) | p95 (ms) | p99 (ms) | Delivery rate | Errors | Reconnects |\n`;
    md += `|---|---|---|---|---|---|---|---|\n`;
    for (const cell of hCells) {
      md +=
        `| ${cell.transport} | ${cell.runCount} | ${fmtNum(cell.avgP50Ms)} | ${fmtNum(cell.avgP95Ms)} | ` +
        `${fmtNum(cell.avgP99Ms)} | ${fmtPercent(cell.avgDeliveryRate)} | ${cell.totalErrors} | ${cell.totalReconnects} |\n`;
    }
  }

  md += `\n## Cách đọc bảng\n\n`;
  md += `- **Runs** = số lần chạy được tổng hợp cho ô này. \`Runs=1\` nghĩa là CHƯA đủ để đánh giá `;
  md += `độ ổn định (Rule 29 — benchmark repeatability) — nên chạy lại (\`--repeats=\`) trước khi kết luận.\n`;
  md += `- **p95 stddev** = độ lệch chuẩn của p95 GIỮA CÁC LẦN CHẠY (không phải variance trong 1 lần `;
  md += `chạy) — số càng nhỏ so với giá trị p95 nghĩa là kết quả càng ổn định/đáng tin cậy.\n`;
  md += `- Bảng này KHÔNG tự gán nhãn "tốt/xấu" — đối chiếu số liệu với Decision Matrix lý thuyết ở `;
  md += `mục 7 của \`docs/final-report/FINAL-COMPARISON-REPORT.md\` để tự đánh giá theo yêu cầu cụ thể của bạn.\n`;
  md += `- Môi trường chạy (Node version, OS, hostname) được ghi trong từng file `;
  md += `\`results/processed/*.json\` (field \`environment\`) — kiểm tra nếu so sánh kết quả giữa nhiều máy khác nhau.\n`;

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
