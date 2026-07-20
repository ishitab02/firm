#!/usr/bin/env node
/**
 * "State of the Agent Economy" — an aggregate report over the real marketplace
 * scan. This is the Firm's vendor intelligence, published: the marketplace has
 * workers and no employer, and nobody else is measuring the labour pool.
 *
 * Integrity: this file only aggregates what is already in the scan. It invents
 * no agents, ratings, or sales. Every number is a count or a mean over recorded
 * fields, and fields that are absent are reported as "not disclosed", never as
 * zero.
 *
 * Usage:
 *   node tools/vendor-report/generate.js
 *   MARKETPLACE_SCAN_JSON=data/marketplace-scan.json \
 *     VENDOR_INDEX_JSON=data/vendor-index.json \
 *     node tools/vendor-report/generate.js
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const scanPath = process.env.MARKETPLACE_SCAN_JSON ?? "data/marketplace-scan.json";
const indexPath = process.env.VENDOR_INDEX_JSON ?? "data/vendor-index.json";
const outMd = process.env.VENDOR_REPORT_MD ?? "data/vendor-report.md";
const outJson = process.env.VENDOR_REPORT_JSON ?? "data/vendor-report.json";

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Aggregate the scan into a structured report. Pure; exported for tests. */
export function buildReport(scan, index) {
  const agents = scan.agents ?? [];
  const online = agents.filter((agent) => agent.onlineStatus === 1);

  const categories = {};
  for (const agent of agents) {
    for (const category of agent.categoryName ?? []) {
      categories[category] = (categories[category] ?? 0) + 1;
    }
  }

  const rated = agents.filter((agent) => typeof agent.feedbackRate === "number" && !Number.isNaN(agent.feedbackRate));
  const withSales = agents.filter((agent) => typeof agent.soldCount === "number" && agent.soldCount > 0);
  const totalSales = withSales.reduce((sum, agent) => sum + agent.soldCount, 0);
  const secured = agents.filter((agent) => typeof agent.securityRate === "number");

  const topBySales = [...withSales]
    .sort((a, b) => b.soldCount - a.soldCount)
    .slice(0, 10)
    .map((agent) => ({ agent_id: String(agent.agentId), name: agent.name, sold_count: agent.soldCount }));

  const indexVendors = index?.vendors ?? (Array.isArray(index) ? index : []);

  return {
    generated_at: new Date().toISOString(),
    source: {
      scan_file: scanPath,
      scanned_at: scan.scanned_at ?? null,
      scan_source: scan.source ?? "unknown"
    },
    marketplace: {
      agents_scanned: agents.length,
      // Counts, not judgments.
      agents_online: online.length,
      agents_offline: agents.length - online.length,
      agents_with_a_rating: rated.length,
      agents_without_a_rating: agents.length - rated.length,
      mean_feedback_rate_among_rated: mean(rated.map((agent) => agent.feedbackRate)),
      agents_with_completed_sales: withSales.length,
      total_completed_sales_across_marketplace: totalSales,
      agents_reporting_a_security_rate: secured.length,
      category_breakdown: categories
    },
    firm_usable: {
      count: indexVendors.length,
      note:
        "Vendors the Firm can currently source: callable endpoint, a priced service in a known capability, " +
        "and a substitutable trust score. See data/vendor-index.json for provenance of each."
    },
    top_vendors_by_completed_sales: topBySales,
    disclosures: [
      "Every figure is aggregated directly from the marketplace scan; no agent, rating, or sale is invented.",
      "Ratings and sales counts are self-reported by the marketplace; absent values are counted as 'not disclosed', not zero.",
      "The Firm's usable subset is small because most scanned agents lack a callable endpoint, a priced service, or any review history."
    ]
  };
}

function renderMarkdown(report) {
  const m = report.marketplace;
  const lines = [];
  lines.push("# The State of the Agent Economy");
  lines.push("");
  lines.push(`_Generated ${report.generated_at} from a scan of ${m.agents_scanned} marketplace agents._`);
  lines.push("");
  lines.push("## The labour pool");
  lines.push("");
  lines.push(`- **${m.agents_scanned}** agents scanned; **${m.agents_online}** online, **${m.agents_offline}** offline.`);
  lines.push(`- **${m.agents_with_a_rating}** carry a rating; **${m.agents_without_a_rating}** have none.`);
  if (m.mean_feedback_rate_among_rated !== null) {
    lines.push(`- Mean feedback rate among rated agents: **${m.mean_feedback_rate_among_rated.toFixed(1)}%**.`);
  }
  lines.push(
    `- **${m.agents_with_completed_sales}** have any completed sales, totalling **${m.total_completed_sales_across_marketplace}** across the whole marketplace.`
  );
  lines.push("");
  lines.push("## What the Firm can actually hire");
  lines.push("");
  lines.push(
    `Of ${m.agents_scanned} scanned, the Firm can source **${report.firm_usable.count}**. ${report.firm_usable.note}`
  );
  lines.push("");
  lines.push("## Categories");
  lines.push("");
  for (const [category, count] of Object.entries(m.category_breakdown).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${category}: ${count}`);
  }
  lines.push("");
  lines.push("## Top vendors by completed sales");
  lines.push("");
  for (const vendor of report.top_vendors_by_completed_sales) {
    lines.push(`- ${vendor.name} (#${vendor.agent_id}): ${vendor.sold_count}`);
  }
  lines.push("");
  lines.push("## Disclosures");
  lines.push("");
  for (const disclosure of report.disclosures) lines.push(`- ${disclosure}`);
  lines.push("");
  return lines.join("\n");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main() {
  const scan = readJson(scanPath);
  let index = null;
  try {
    index = readJson(indexPath);
  } catch {
    // The index is optional; the marketplace section stands on its own.
  }

  const report = buildReport(scan, index);

  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(outMd, renderMarkdown(report));

  console.error(`wrote ${outJson} and ${outMd}`);
  console.error(`  ${report.marketplace.agents_scanned} agents scanned; ${report.firm_usable.count} usable by the Firm`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
