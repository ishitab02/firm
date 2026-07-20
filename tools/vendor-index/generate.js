#!/usr/bin/env node
/**
 * Turn a real marketplace scan into data/vendor-index.json.
 *
 * Integrity rules this file obeys:
 *   - Nothing is invented. Every field is either copied from the scan or
 *     derived by a rule stated here and stamped with its source.
 *   - Token decimals are LOOKED UP on chain, never assumed. A price whose
 *     decimals cannot be resolved is emitted as null with a reason, not as a
 *     guessed number.
 *   - kya_base_score is NOT populated from a different metric behind the
 *     reader's back. apps/kya is absent from this repo, so the score is null
 *     unless a human explicitly opts into the substitution.
 *
 * Usage:
 *   node tools/vendor-index/scan.js                       # produce the scan
 *   MARKETPLACE_SCAN_JSON=data/marketplace-scan.json \
 *     node tools/vendor-index/generate.js
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

const BIN = process.env.OKX_CLI_BIN ?? "onchainos";
const inputPath = process.env.MARKETPLACE_SCAN_JSON;
const outputPath = process.env.VENDOR_INDEX_OUT ?? "data/vendor-index.json";

/**
 * Capability inference. INTERFACES v1 locks exactly these capabilities; a
 * service that matches neither is recorded as null rather than forced into one.
 * Every entry carries capability_source so a reader can tell an inference from
 * a curated fact.
 */
const CAPABILITY_RULES = [
  {
    capability: "market_snapshot",
    keywords: [
      "market",
      "snapshot",
      "price",
      "ohlc",
      "chart",
      "trading",
      "liquidity",
      "sentiment",
      "news",
      "research",
      "report",
      "analysis",
      "data"
    ]
  },
  {
    capability: "token_launch",
    keywords: ["launch", "token creation", "deploy", "tokenomics", "presale", "mint", "issuance"]
  }
];

function inferCapability(service) {
  const text = `${service.serviceName ?? ""} ${service.serviceDescription ?? ""}`.toLowerCase();
  // token_launch is checked first: its keywords are far more specific, so a
  // launch service that also mentions "market" should not be filed as research.
  for (const rule of [...CAPABILITY_RULES].reverse()) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) return rule.capability;
  }
  return null;
}

const decimalsCache = new Map();

/** Resolve an ERC-20's decimals on chain. Returns null rather than guessing. */
async function tokenDecimals(contract, chainIndex) {
  const key = `${chainIndex}:${contract}`.toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);

  let decimals = null;
  try {
    const { stdout } = await execFileAsync(
      BIN,
      ["token", "info", "--address", contract, "--chain", String(chainIndex)],
      { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }
    );
    const parsed = JSON.parse(stdout);
    const entry = (parsed.data ?? []).find((row) => String(row.chainIndex) === String(chainIndex)) ?? parsed.data?.[0];
    const raw = entry?.decimal ?? entry?.decimals;
    if (raw !== undefined && /^\d+$/.test(String(raw))) {
      decimals = { decimals: Number(raw), symbol: entry.tokenSymbol ?? null, name: entry.tokenName ?? null };
    }
  } catch (error) {
    console.error(`  ! decimals lookup failed for ${contract} on ${chainIndex}: ${String(error).split("\n")[0]}`);
  }

  decimalsCache.set(key, decimals);
  return decimals;
}

/**
 * Convert a decimal fee (the marketplace reports 0.01, not base units) into a
 * base-unit integer string, exactly, without floating point.
 */
export function toBaseUnits(feeAmount, decimals) {
  const text = String(feeAmount);
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    // More precision than the token can represent: refuse rather than round
    // someone's price silently.
    return null;
  }
  const padded = fraction.padEnd(decimals, "0");
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return combined;
}

/** Derived, labelled risk flags. These are ours, not the marketplace's. */
function deriveFlags(agent) {
  const flags = [];
  if (agent.onlineStatus !== 1) flags.push("OFFLINE");
  if (typeof agent.securityRate === "number" && agent.securityRate < 4) flags.push("LOW_SECURITY_RATE");
  if (!agent.soldCount) flags.push("NO_COMPLETED_SALES");
  if (typeof agent.feedbackRate === "number" && agent.feedbackRate < 60) flags.push("LOW_FEEDBACK_RATE");
  return flags;
}

const allowFeedbackAsScore = process.env.ALLOW_FEEDBACK_RATE_AS_BASE_SCORE === "true";

/**
 * The substituted score, or null when there is nothing to substitute.
 *
 * apps/firm's VendorIndexEntry wants `int` in [0, 100]; the marketplace reports
 * a float (92.86) and reports null for an agent nobody has reviewed. Rounding
 * is fine — it is already a coarse reputation number — but a missing rating is
 * not a zero, and scoring it as one would invent a bad reputation for an agent
 * that simply has no history.
 */
function substitutedScore(agent) {
  if (typeof agent.feedbackRate !== "number" || Number.isNaN(agent.feedbackRate)) return null;
  return Math.max(0, Math.min(100, Math.round(agent.feedbackRate)));
}

async function main() {
  if (!inputPath) {
    console.error(
      "set MARKETPLACE_SCAN_JSON to a marketplace scan file.\n" +
        "Produce one with: node tools/vendor-index/scan.js"
    );
    process.exit(2);
  }

  const scan = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const agents = Array.isArray(scan) ? scan : (scan.agents ?? scan.vendors);
  if (!Array.isArray(agents)) {
    throw new Error("marketplace scan must be an array, { agents: [...] } or { vendors: [...] }");
  }

  const vendors = [];
  let skippedNoEndpoint = 0;
  let pricesUnresolved = 0;
  let droppedUncategorised = 0;
  let droppedUnpriced = 0;
  let skippedNoUsableService = 0;
  let skippedNoScore = 0;

  for (const agent of agents) {
    const callable = (agent.services ?? []).filter(
      (service) => typeof service.endpoint === "string" && service.endpoint.length > 0
    );
    if (callable.length === 0) {
      skippedNoEndpoint += 1;
      continue;
    }

    const services = [];
    for (const service of callable) {
      const contract = service.feeToken ?? service.contractAddress;
      const resolved = contract ? await tokenDecimals(contract, agent.chainIndex) : null;
      let price = null;
      let priceUnresolvedReason = null;

      if (service.feeAmount === null || service.feeAmount === undefined) {
        priceUnresolvedReason = "marketplace reported no feeAmount for this service";
      } else if (!resolved) {
        priceUnresolvedReason = `could not resolve decimals for fee token ${contract} on chain ${agent.chainIndex}`;
      } else {
        const amount = toBaseUnits(service.feeAmount, resolved.decimals);
        if (amount === null) {
          priceUnresolvedReason = `feeAmount ${service.feeAmount} is not representable in ${resolved.decimals} decimals`;
        } else {
          price = { amount, decimals: resolved.decimals, token: resolved.symbol ?? contract };
        }
      }
      if (!price) pricesUnresolved += 1;

      services.push({
        tool: service.serviceName ?? `service_${service.serviceId}`,
        service_id: service.serviceId ?? null,
        service_type: service.serviceType ?? null,
        endpoint: service.endpoint,
        price,
        price_unresolved_reason: priceUnresolvedReason,
        fee_amount_declared: service.feeAmount ?? null,
        fee_token: contract ?? null,
        capability: inferCapability(service),
        capability_source: "inferred_from_service_name_and_description",
        description: service.serviceDescription ?? null
      });
    }

    // apps/firm's VendorIndexEntry requires every service to carry a string
    // capability and a price. A service missing either cannot be sourced or
    // paid for, so it is dropped here rather than shipped as a row the worker
    // will reject — which would take the whole index down with it. The full
    // record survives in the raw scan.
    const usable = services.filter((service) => service.capability !== null && service.price !== null);
    droppedUncategorised += services.filter((service) => service.capability === null).length;
    droppedUnpriced += services.filter((service) => service.capability !== null && service.price === null).length;
    if (usable.length === 0) {
      skippedNoUsableService += 1;
      continue;
    }

    const score = substitutedScore(agent);
    if (allowFeedbackAsScore && score === null) {
      // Opting into the substitution means asking for a worker-loadable index.
      // An entry with no score would fail VendorIndexEntry and take the whole
      // file down with it, so it is skipped and counted.
      skippedNoScore += 1;
      continue;
    }

    vendors.push({
      agent_id: String(agent.agentId),
      name: agent.name,
      // When a service declares its own endpoint, that one is authoritative.
      // This top-level field exists because INTERFACES §4 asks for it.
      endpoint: usable[0].endpoint,
      chain_index: agent.chainIndex ?? null,
      communication_address: agent.communicationAddress ?? null,
      services: usable,
      services_dropped: services.length - usable.length,
      kya_base_score: allowFeedbackAsScore ? score : null,
      score_source: allowFeedbackAsScore
        ? "marketplace_feedback_rate_SUBSTITUTED_for_kya_base_score"
        : "KYA_ENGINE_ABSENT_score_not_populated",
      marketplace_feedback_rate: agent.feedbackRate ?? null,
      marketplace_security_rate: agent.securityRate ?? null,
      sold_count: agent.soldCount ?? null,
      categories: agent.categoryName ?? [],
      flags: deriveFlags(agent),
      flags_source: "derived_by_tools/vendor-index/generate.js",
      last_verified_at: scan.scanned_at ?? new Date().toISOString()
    });
  }

  const output = {
    generated_at: new Date().toISOString(),
    provenance: {
      scan_file: inputPath,
      scanned_at: scan.scanned_at ?? null,
      scan_source: scan.source ?? "unknown",
      agents_in_scan: agents.length,
      agents_without_callable_endpoint_skipped: skippedNoEndpoint,
      agents_without_a_usable_service_skipped: skippedNoUsableService,
      agents_without_a_resolvable_score_skipped: skippedNoScore,
      services_with_unresolved_price: pricesUnresolved,
      services_dropped_uncategorised: droppedUncategorised,
      services_dropped_unpriced: droppedUnpriced,
      dropped_services_note:
        "apps/firm VendorIndexEntry requires a string capability and a price per service; " +
        "services missing either are dropped here so they cannot invalidate the whole index. " +
        "They remain in the raw scan.",
      capability_inference: "keyword rules in tools/vendor-index/generate.js; every service carries capability_source",
      token_decimals: "looked up per fee token via `onchainos token info`; never assumed",
      kya_base_score: allowFeedbackAsScore
        ? "SUBSTITUTED from marketplace feedbackRate because apps/kya is absent from this repo (ALLOW_FEEDBACK_RATE_AS_BASE_SCORE=true)"
        : "NOT POPULATED: apps/kya is absent from this repo and INTERFACES §4 requires the fixture-scoring bug be reconciled first"
    },
    vendors
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");

  console.error(`wrote ${vendors.length} vendors to ${outputPath}`);
  console.error(`  skipped (no callable endpoint): ${skippedNoEndpoint}`);
  console.error(`  services with unresolved price: ${pricesUnresolved}`);
  if (!allowFeedbackAsScore) {
    console.error(
      "  kya_base_score is null for every vendor (apps/kya absent). Sourcing that filters on\n" +
        "  min_vendor_score will reject all of them until a human resolves this."
    );
  }
}

// Importable for tests; only scans when run directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
