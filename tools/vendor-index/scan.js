#!/usr/bin/env node
/**
 * Real marketplace scanner.
 *
 * Calls `onchainos agent search` across a set of queries, paginates, dedupes by
 * agentId, and writes the raw records to a scan file that
 * tools/vendor-index/generate.js consumes via MARKETPLACE_SCAN_JSON.
 *
 * This file records what the marketplace said and nothing else. It does not
 * score, rank, rename, or infer. Every derived judgment happens in generate.js,
 * where it is labelled.
 *
 * Usage:
 *   node tools/vendor-index/scan.js
 *   MARKETPLACE_SCAN_QUERIES="market data,research" node tools/vendor-index/scan.js
 *   MARKETPLACE_SCAN_OUT=data/marketplace-scan.json node tools/vendor-index/scan.js
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const BIN = process.env.OKX_CLI_BIN ?? "onchainos";
const OUT = process.env.MARKETPLACE_SCAN_OUT ?? "data/marketplace-scan.json";
const PAGE_SIZE = Number(process.env.MARKETPLACE_SCAN_PAGE_SIZE ?? 50);
const MAX_PAGES = Number(process.env.MARKETPLACE_SCAN_MAX_PAGES ?? 10);

/**
 * Default queries span the capabilities INTERFACES names plus the general
 * service vocabulary the marketplace actually uses. Override with
 * MARKETPLACE_SCAN_QUERIES when the Express job type locks.
 */
const DEFAULT_QUERIES = [
  "market data",
  "market snapshot",
  "research",
  "analysis",
  "api",
  "data",
  "token launch",
  "crypto",
  "report",
  "news"
];

function queries() {
  const raw = process.env.MARKETPLACE_SCAN_QUERIES;
  if (!raw) return DEFAULT_QUERIES;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function searchPage(query, page) {
  const { stdout } = await execFileAsync(
    BIN,
    ["agent", "search", "--query", query, "--page", String(page), "--page-size", String(PAGE_SIZE)],
    { maxBuffer: 32 * 1024 * 1024, timeout: Number(process.env.MARKETPLACE_SCAN_TIMEOUT_MS ?? 60_000) }
  );
  const parsed = JSON.parse(stdout);
  if (!parsed.ok) throw new Error(`agent search failed for "${query}": ${stdout.slice(0, 300)}`);
  return parsed.data ?? {};
}

async function main() {
  const byAgentId = new Map();
  const perQuery = [];

  for (const query of queries()) {
    let page = 1;
    let total = null;
    let seen = 0;

    while (page <= MAX_PAGES) {
      let data;
      try {
        data = await searchPage(query, page);
      } catch (error) {
        console.error(`  ! "${query}" page ${page}: ${error.message.split("\n")[0]}`);
        break;
      }

      const list = data.list ?? [];
      total = data.total ?? total;
      seen += list.length;

      for (const agent of list) {
        // Last write wins; records are identical across queries apart from the
        // similarityScore the backend attaches per query, which we do not keep.
        byAgentId.set(String(agent.agentId), agent);
      }

      if (list.length < PAGE_SIZE) break;
      page += 1;
    }

    perQuery.push({ query, total, collected: seen });
    console.error(`  ${query}: ${seen} records (backend total ${total})`);
  }

  const agents = [...byAgentId.values()];
  const withCallableService = agents.filter((agent) =>
    (agent.services ?? []).some((service) => typeof service.endpoint === "string" && service.endpoint.length > 0)
  );

  const scan = {
    scanned_at: new Date().toISOString(),
    source: `${BIN} agent search`,
    queries: perQuery,
    unique_agents: agents.length,
    agents_with_callable_service: withCallableService.length,
    // Everything below is the backend's own response, unmodified.
    agents
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(scan, null, 2) + "\n");
  console.error(
    `\nwrote ${agents.length} unique agents (${withCallableService.length} with a callable endpoint) to ${OUT}`
  );
}

await main();
