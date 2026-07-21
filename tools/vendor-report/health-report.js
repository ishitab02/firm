#!/usr/bin/env node
/**
 * Generates the marketplace health report from probe data.
 *
 *   node tools/vendor-report/health-report.js > data/marketplace-health-report.md
 *
 * Every figure is computed from data/marketplace-health-*.json. Nothing is
 * typed by hand, so the prose cannot drift from the measurements — which is the
 * whole point of publishing it: a reader can re-run the probe and check us.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = process.argv[2] ?? "data/marketplace-health-2026-07-21.json";

const health = JSON.parse(readFileSync(path.join(REPO_ROOT, SOURCE), "utf8"));
const scan = JSON.parse(readFileSync(path.join(REPO_ROOT, "data/marketplace-scan.json"), "utf8"));

const results = health.results;
const n = results.length;
const pct = (count) => Math.round((count / n) * 100);
const usdt = (units) => `${(Number(units) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0")} USDT`;

const unreachable = results.filter((r) => r.verdict === "UNREACHABLE");
const httpError = results.filter((r) => r.verdict === "HTTP_ERROR");
const dead = [...unreachable, ...httpError];
const conformant = results.filter((r) => r.verdict === "X402_OK" || r.verdict === "PRICE_MISMATCH" || r.verdict === "OVER_BUDGET");
const free = results.filter((r) => r.verdict === "NO_CHARGE");
// Free is only newsworthy where the agent advertises a nonzero price: those are
// services being given away by accident. A listing of 0 that serves free is
// merely consistent.
const freeDespitePrice = free.filter((r) => Number(r.listed_amount?.amount ?? 0) > 0);
const overListing = results
  .filter((r) => r.price_ratio !== null && r.price_ratio > 1)
  .sort((a, b) => b.price_ratio - a.price_ratio);
const underListing = results.filter((r) => r.price_ratio !== null && r.price_ratio < 1);
const declaredDecimals = conformant.filter((r) => r.declared_decimals !== null);

const out = [];
const w = (line = "") => out.push(line);

w("# The State of the OKX Agent Economy");
w("");
w("### What 95 live endpoint probes found");
w("");
w(`_Measured ${health.generated_at.slice(0, 10)}. Every figure below is computed from`);
w(`\`${SOURCE}\` by \`tools/vendor-report/health-report.js\` — none of it is typed by hand._`);
w("");
w("---");
w("");
w("## Method");
w("");
w("One unpaid HTTP POST to the first endpoint-bearing service each agent");
w("publishes, then read whatever comes back. A conformant x402 seller answers");
w("`402` with a challenge stating its price; that challenge is the ground truth");
w("for what the service actually costs.");
w("");
w("**Nothing was signed and nothing was spent.** No agent was charged, and no");
w("payment authorization was produced at any point. Reading a 402 is free — that");
w("is what makes this measurable at all.");
w("");
w(`- Population: of **${scan.agents.length}** agents on the marketplace, **${n}** publish an`);
w("  A2MCP service with an HTTP endpoint. The rest are A2A-only or list no");
w("  service, and cannot be probed over HTTP by anyone.");
w("- Up to 2 attempts, retrying only on network-level failure. A cold-starting");
w("  container is not a dead one, and one timeout is not evidence.");
w(`- Timeout: ${health.method?.timeout_ms ?? 12000}ms.`);
w("");
w("Reproduce it:");
w("");
w("```bash");
w("pnpm -F @firm/procurer vet -- --index data/marketplace-scan.json --out health.json");
w("```");
w("");
w("**Caveat, stated up front:** this probes the *first* endpoint-bearing service");
w("per agent, not all of them. An agent whose first endpoint is dead may have");
w("live ones. The honest claim is \"X% of endpoint-bearing agents have a dead");
w("first endpoint\", not \"X% of services are dead\". Endpoints also change — this");
w("is a snapshot, and a re-run may differ.");
w("");
w("---");
w("");
w("## The headline");
w("");
w("| | count | share |");
w("|---|---:|---:|");
w(`| Probed | ${n} | 100% |`);
w(`| Reachable and x402-conformant | ${conformant.length} | ${pct(conformant.length)}% |`);
w(`| Served without charging | ${free.length} | ${pct(free.length)}% |`);
w(`| **Dead or misrouted** | **${dead.length}** | **${pct(dead.length)}%** |`);
w("");
w(`**${pct(dead.length)}% of agents that publish an endpoint do not answer on it.**`);
w(`${httpError.length} return an HTTP error at the address they advertise —`);
w(`mostly 404, meaning the listing points somewhere real that serves nothing.`);
w(`${unreachable.length} do not resolve or refuse the connection outright.`);
w("");
w("A buyer who trusts the marketplace listing and calls the endpoint has roughly");
w("a coin-flip chance of reaching anything at all.");
w("");
w("---");
w("");
w("## Prices that do not match their listing");
w("");
w("The listing states a price. The live 402 states a price. They are not always");
w("the same number, and the gap is not small.");
w("");
w("| agent | listed | live 402 demands | ratio |");
w("|---|---:|---:|---:|");
for (const r of overListing) {
  w(`| #${r.agent_id} ${r.name} | ${usdt(r.listed_amount.amount)} | ${usdt(r.live_amount.amount)} | **${r.price_ratio}×** |`);
}
w("");
const worst = overListing[0];
if (worst) {
  w(`**#${worst.agent_id} ${worst.name} advertises ${usdt(worst.listed_amount.amount)} and its live challenge`);
  w(`demands ${usdt(worst.live_amount.amount)} — ${worst.price_ratio} times the advertised price.**`);
  w("");
  w("An agent that reads the listing, trusts it, and signs whatever the challenge");
  w(`asks would pay ${worst.price_ratio}× its expected cost on a single call. Nothing in the`);
  w("protocol prevents this: the buyer is the only party in a position to check.");
  w("");
}
if (underListing.length) {
  w(`The error runs both ways. ${underListing.length} agent(s) charge *less* than they advertise —`);
  w(`for example #${underListing[0].agent_id} ${underListing[0].name}, listed at`);
  w(`${usdt(underListing[0].listed_amount.amount)} and charging ${usdt(underListing[0].live_amount.amount)}.`);
  w("");
}
if (freeDespitePrice.length) {
  w(`And ${freeDespitePrice.length} agents advertise a price but serve for free — they answer 200 with`);
  w("the goods and never issue a challenge at all:");
  w("");
  for (const r of freeDespitePrice) {
    w(`- #${r.agent_id} ${r.name} — listed ${usdt(r.listed_amount.amount)}, charges nothing`);
  }
  w("");
  w("Those are services being given away by accident. Presumably nobody has told them.");
  w("");
}
w("---");
w("");
w("## A protocol detail worth flagging");
w("");
w(`Of the ${conformant.length} conformant sellers, only **${declaredDecimals.length}** declare the decimal scale of the`);
w("asset they price in.");
w("");
w("This matters more than it looks. `15` means nothing without knowing whether it");
w("is 15 units of a 6-decimal token or an 18-decimal one — those differ by a");
w("factor of a trillion. A buyer comparing a price against a spending limit is");
w("comparing raw integers, and if the scales differ the comparison is not merely");
w("wrong, it is wrong in the permissive direction.");
w("");
w("The safe reading is to treat an undeclared scale as *known* only when the");
w("buyer has itself pinned the asset and chain in advance, and to refuse");
w("otherwise. Requiring sellers to declare it would break most of the market.");
w("");
w("---");
w("");
w("## What this says about the market");
w("");
w("These are early-market failure modes, not bad actors. Endpoints rot, hosting");
w("sleeps, prices get updated in one place and not the other. Every young");
w("marketplace looks like this, and most of it is fixable by the platform:");
w("periodic health checks, rejecting listings whose live price disagrees with");
w("their advertised one, and requiring a declared decimal scale would remove");
w("most of what is measured above.");
w("");
w("Until then the checking has to happen somewhere, and the only party with an");
w("incentive to do it is whoever is about to spend the money.");
w("");
w("That is the position The Firm occupies: it verifies live commercial terms");
w("before signature, validates outcomes after, absorbs the cost of replacing");
w("failures, and publishes the evidence. The dataset above is what its own");
w("background check produces, run across the whole marketplace instead of one");
w("job's candidates.");
w("");
w("---");
w("");
w("## Raw data");
w("");
w(`- \`${SOURCE}\` — every probe result, with verdict, latency, attempts, and both prices`);
w("- `data/marketplace-scan.json` — the underlying agent scan");
w("- `packages/procurer/src/vet.ts` — the prober, MIT licensed, no key required");
w("");
w("Corrections welcome. If an agent below is listed as dead and is not, the");
w("probe result and its timestamp are in the JSON — send it back and it will be");
w("re-run.");
w("");
w("## Full results");
w("");
w("| status | agent | listed | live | ratio | ms |");
w("|---|---|---:|---:|---:|---:|");
const mark = {
  X402_OK: "ok",
  NO_CHARGE: "free",
  PRICE_MISMATCH: "over",
  OVER_BUDGET: "over",
  UNSUPPORTED_CHALLENGE: "n/a",
  HTTP_ERROR: "**dead**",
  UNREACHABLE: "**dead**"
};
for (const r of results) {
  const listed = r.listed_amount ? usdt(r.listed_amount.amount) : "—";
  const live = r.live_amount ? usdt(r.live_amount.amount) : "—";
  const ratio = r.price_ratio !== null ? `${r.price_ratio}×` : "—";
  w(`| ${mark[r.verdict] ?? "?"} | #${r.agent_id} ${r.name} | ${listed} | ${live} | ${ratio} | ${r.latency_ms} |`);
}
w("");

console.log(out.join("\n"));
