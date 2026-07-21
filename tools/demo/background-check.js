#!/usr/bin/env node
/**
 * Demo beat: the background check, against live marketplace agents.
 *
 *   node tools/demo/background-check.js
 *
 * Every probe here is an UNPAID request that reads the vendor's 402 and throws
 * it away. Nothing is signed, nothing is spent, and no vendor is charged — so
 * this is safe to run on camera, repeatedly, at zero cost.
 *
 * It exists because the strongest thing we can show is not our own code
 * working. It is a real agent, listed on this marketplace today, whose live 402
 * demands 600x its advertised price — and our caps refusing it before a
 * signature exists. That is the whole product argument in one screen, and it is
 * someone else's data, not ours.
 *
 * The prices printed are read live at run time. If a vendor has since fixed its
 * listing the number will change, and the script says what it actually saw
 * rather than what we hope it sees.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { vetVendors } from "../../packages/procurer/dist/vet.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** What a buyer's per-call cap would be for a market_snapshot subtask. */
const PER_CALL_CEILING = { amount: "50000", decimals: 6, token: "USDT" };

const line = (text = "") => console.log(text);
const usdt = (units) => `${(Number(units) / 1e6).toFixed(6).replace(/0+$/, "0")} USDT`;

function section(title) {
  line("");
  line(title);
  line("-".repeat(title.length));
}

function loadCandidates() {
  const index = JSON.parse(readFileSync(path.join(REPO_ROOT, "data/vendor-index.json"), "utf8"));
  const vendors = index.vendors ?? index;
  return vendors
    .map((vendor) => {
      const service = vendor.services.find((entry) => entry.capability === "market_snapshot");
      if (!service) return null;
      return {
        agentId: vendor.agent_id,
        name: vendor.name,
        vendorEndpoint: vendor.endpoint,
        tool: service.tool,
        args: service.documented_example_args?.args ?? {},
        listedAmount: service.price,
        maxAmount: PER_CALL_CEILING
      };
    })
    .filter(Boolean);
}

const candidates = loadCandidates();
const compactMode = process.argv.includes("--compact");

line("The Firm — vendor background check");
line("==================================");
line("Unpaid 402 probes against live OKX marketplace agents. Nothing is signed.");
line(`Buyer's per-call ceiling for this subtask: ${usdt(PER_CALL_CEILING.amount)}`);

section(`Probing ${candidates.length} candidates`);
const started = Date.now();
// Tuned for a live audience: all candidates in flight at once, and a shorter
// timeout than the CLI default. A dead endpoint costs one 6s wait instead of
// blocking the run. Still two attempts, so a cold-starting vendor is not
// mislabelled dead on camera.
const results = await vetVendors(candidates, {
  timeoutMs: 6_000,
  concurrency: candidates.length,
  attempts: 2
});

const mark = {
  X402_OK: "  OK  ",
  NO_CHARGE: " FREE ",
  PRICE_MISMATCH: " WARN ",
  OVER_BUDGET: " STOP ",
  UNSUPPORTED_CHALLENGE: "  --  ",
  HTTP_ERROR: " DEAD ",
  UNREACHABLE: " DEAD "
};

if (!compactMode) {
  results.forEach((result, index) => {
    const candidate = candidates[index];
    const listed = candidate.listedAmount?.amount ?? "?";
    const live = result.live_amount?.amount ?? "-";
    const ratio = result.price_ratio !== null && result.price_ratio !== 1 ? `  ${result.price_ratio}x` : "";
    line(
      `${mark[result.verdict] ?? "  ?   "} #${String(candidate.agentId).padEnd(5)} ${String(candidate.name)
        .slice(0, 26)
        .padEnd(27)} listed ${String(listed).padStart(8)} -> live ${String(live).padStart(8)}${ratio}`
    );
  });
}

const hireable = results.filter((result) => result.hireable);
const dead = results.filter((result) => result.verdict === "UNREACHABLE" || result.verdict === "HTTP_ERROR");
const overcharging = results
  .filter((result) => result.price_ratio !== null && result.price_ratio > 1)
  .sort((a, b) => b.price_ratio - a.price_ratio);

section("What the check found");
line(`${hireable.length}/${results.length} hireable`);
line(`${dead.length} failed unpaid preflight with unreachable or unusable HTTP responses`);
line(`${overcharging.length} charging more than their listing says`);
line(`${Date.now() - started}ms, 0 paid, 0 signatures produced`);

// The headline. Printed from what we just measured, not from a constant.
const worst = overcharging[0];
if (worst) {
  const index = results.indexOf(worst);
  const candidate = candidates[index];
  section("The one that matters");
  line(`Agent #${candidate.agentId} — ${candidate.name}`);
  line(`  listed on the marketplace at : ${usdt(candidate.listedAmount.amount)}`);
  line(`  its live 402 actually demands: ${usdt(worst.live_amount.amount)}`);
  line(`  that is ${worst.price_ratio}x the advertised price`);
  line("");
  line("  An agent that trusts the listing and pays whatever the challenge asks");
  line(`  would have paid ${worst.price_ratio}x its expected cost on a single call.`);
  line("");
  if (worst.verdict === "OVER_BUDGET") {
    line(`  The Firm compares the challenge against the buyer's ceiling BEFORE signing:`);
    line(`    ${worst.detail}`);
    line("");
    line("  Refused. No signature was produced, so no money could move.");
    line("  The vendor is not penalised for this: it answered correctly and the");
    line("  decision was ours, so it is recorded as a rejection, not a failure.");
  } else {
    line(`  Verdict: ${worst.verdict} — ${worst.detail}`);
  }
}

section("Why this is the product");
line("The case against an orchestrator is that a buyer could call these vendors");
line("directly. Measured, that buyer faces:");
line(`  - ${Math.round((dead.length / results.length) * 100)}% currently failing unpaid preflight`);
// Read from what this run measured. Hardcoding "600x" would keep asserting it
// on camera the day Clawby fixes its listing, which is the exact species of
// stale claim this whole project refuses to make.
if (worst) {
  line(`  - listings that understate the real price by up to ${worst.price_ratio}x`);
}
line("  - no safe basis to pay without probing the live endpoint first");
line("");
line("Someone has to check first, absorb the misses, and carry that risk.");
line("That is the job.");
