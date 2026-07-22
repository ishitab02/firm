/**
 * Fold measured endpoint health into the vendor index's trust score.
 *
 *   node tools/vendor-index/apply-health.js [--dry]
 *
 * Why this exists. The Firm's pitch is that it background-checks vendors before
 * paying. It does — at procurement time, per call. But *sourcing* ranked purely
 * on `kya_base_score`, which is built from marketplace-reported reputation and
 * carries no liveness signal at all. So a vendor with perfect marketplace stats
 * and a dead endpoint outranked a live one.
 *
 * The consequence was not theoretical. The first real customer job hired, in
 * order: Predexon (HTTP_ERROR), Proof of Behavior (UNREACHABLE), Scope
 * (UNREACHABLE), CoinWM (HTTP_ERROR). We had probed all 95 marketplace agents
 * days earlier and then hired the corpses anyway, because nothing connected the
 * scan to the ranking. This connects them.
 *
 * Deliberately a separate step from generate.js rather than folded into it:
 * the scan and the index are produced at different times and cadences, and a
 * regenerated index should visibly lose its health annotation rather than carry
 * a stale one that looks current.
 *
 * What this does NOT do: drop dead vendors from the index. They stay, scored to
 * the floor, because "43% of this marketplace is dead" is a finding worth being
 * able to read off our own data — and because a vendor that recovers should be
 * re-rankable by re-running the scan, not by re-discovering it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INDEX_PATH = process.env.VENDOR_INDEX_PATH ?? resolve(REPO_ROOT, "data/vendor-index.json");
const HEALTH_PATH = process.env.VENDOR_HEALTH_PATH ?? resolve(REPO_ROOT, "data/marketplace-health-2026-07-21.json");

/**
 * Score treatment per verdict.
 *
 * `floor` means the vendor is unhirable as measured — a dead endpoint cannot
 * deliver, and we cannot pay a challenge we do not support. Those go to 0 so any
 * job carrying a `min_vendor_score` above zero excludes them outright, and jobs
 * without one still try every live vendor first.
 *
 * PRICE_MISMATCH is penalised, not floored: the vendor works, it just quotes
 * differently live than it advertises. The per-call vet already refuses to
 * overpay, so this only needs to affect preference.
 *
 * NO_CHARGE is not a fault. Serving free is unusual, not untrustworthy.
 */
const TREATMENT = {
  X402_OK: { kind: "keep", note: "live and correctly challenging for payment" },
  NO_CHARGE: { kind: "keep", note: "live; serves without charging" },
  PRICE_MISMATCH: { kind: "penalty", amount: 40, note: "live price differs from the listed price" },
  UNSUPPORTED_CHALLENGE: { kind: "floor", note: "payment challenge we cannot sign" },
  HTTP_ERROR: { kind: "floor", note: "listed endpoint returns an HTTP error" },
  UNREACHABLE: { kind: "floor", note: "listed endpoint is unreachable" }
};

function loadResults(health) {
  const rows = Array.isArray(health) ? health : health.results;
  if (!Array.isArray(rows)) throw new Error("health file has no results array");
  const byAgent = new Map();
  for (const row of rows) {
    const id = String(row.agent_id ?? row.agentId ?? "");
    if (!id) continue;
    // A vendor can appear once per probed service. Keep the best verdict it
    // achieved: one working endpoint is enough to be worth ranking as live.
    const existing = byAgent.get(id);
    const better = existing && existing.verdict === "X402_OK" ? existing : row;
    byAgent.set(id, better);
  }
  return byAgent;
}

const dry = process.argv.includes("--dry");
const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
const vendors = Array.isArray(index) ? index : index.vendors ?? Object.values(index).find(Array.isArray);
if (!Array.isArray(vendors)) throw new Error("could not find the vendor array in the index");

const health = loadResults(JSON.parse(readFileSync(HEALTH_PATH, "utf8")));
const checkedAt = JSON.parse(readFileSync(HEALTH_PATH, "utf8")).generated_at ?? null;

const summary = { floored: 0, penalised: 0, kept: 0, unscanned: 0 };
const changes = [];

for (const vendor of vendors) {
  const id = String(vendor.agent_id);
  // Idempotent: always recompute from the original score, never from a score
  // this script already adjusted.
  if (vendor.kya_base_score_original === undefined) {
    vendor.kya_base_score_original = vendor.kya_base_score;
  }
  const original = vendor.kya_base_score_original;

  const row = health.get(id);
  if (!row) {
    vendor.measured_health = { verdict: "NOT_SCANNED", hireable: null, checked_at: checkedAt };
    vendor.kya_base_score = original;
    summary.unscanned += 1;
    continue;
  }

  const treatment = TREATMENT[row.verdict] ?? { kind: "keep", note: `unrecognised verdict ${row.verdict}` };
  let score = original;
  if (treatment.kind === "floor") {
    score = 0;
    summary.floored += 1;
  } else if (treatment.kind === "penalty") {
    score = Math.max(0, original - treatment.amount);
    summary.penalised += 1;
  } else {
    summary.kept += 1;
  }

  vendor.measured_health = {
    verdict: row.verdict,
    hireable: row.hireable ?? null,
    checked_at: checkedAt,
    detail: typeof row.detail === "string" ? row.detail.slice(0, 200) : null,
    treatment: treatment.note
  };
  vendor.score_source = `${vendor.score_source ?? "unknown"}; adjusted_by_tools/vendor-index/apply-health.js`;

  if (score !== vendor.kya_base_score) {
    changes.push({ id, name: vendor.name, verdict: row.verdict, from: vendor.kya_base_score, to: score });
  }
  vendor.kya_base_score = score;
}

changes.sort((a, b) => a.to - b.to || a.id.localeCompare(b.id));
for (const c of changes) {
  console.log(`  ${c.id.padStart(5)}  ${String(c.name).slice(0, 26).padEnd(26)} ${c.verdict.padEnd(16)} ${c.from} -> ${c.to}`);
}
console.log(
  `\n${vendors.length} vendors: ${summary.kept} kept, ${summary.penalised} penalised, ` +
    `${summary.floored} floored, ${summary.unscanned} not scanned`
);

if (dry) {
  console.log("\n--dry: nothing written");
} else {
  writeFileSync(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`\nwrote ${INDEX_PATH}`);
}
