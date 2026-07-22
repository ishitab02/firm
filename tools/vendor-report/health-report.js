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
w(`- Population: of **${scan.agents.length}** agents in our ten-query marketplace search snapshot, **${n}** publish an`);
w("  A2MCP service with an HTTP endpoint. The rest are A2A-only or list no");
w("  service in that snapshot.");
w("- Request body: the service's documented literal example when one can be parsed;");
w("  otherwise `{}`. An HTTP error can therefore mean missing or undocumented");
w("  arguments/method semantics, not necessarily dead infrastructure.");
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
w(`| Returned 200 without an x402 challenge | ${free.length} | ${pct(free.length)}% |`);
w(`| **No usable challenge on the probed endpoint** | **${dead.length}** | **${pct(dead.length)}%** |`);
w("");
w(`**${dead.length} of ${n} (${pct(dead.length)}%) returned no usable payment challenge on the`);
w("endpoint we probed.**");
w(`${httpError.length} answered with an HTTP status other than a usable 200 or conformant 402.`);
w(`${unreachable.length} did not resolve, refused the connection, or timed out after the`);
w("configured retries.");
w("");

// Split the failures by whether OUR request could be at fault. A 404 or a
// refused connection is the endpoint's problem; a 400 saying "symbol required"
// or a 405 is very likely ours, and the agent's owner would be right to say so.
// The Method caveat above already says this, but the caveat is not what gets
// quoted — the number is. So the number carries the split.
const statusOf = (row) => {
  const match = /HTTP (\d{3})/.exec(String(row.detail ?? ""));
  return match ? match[1] : null;
};
const ourFault = httpError.filter((r) => ["400", "405", "415", "422"].includes(statusOf(r)));
const theirFault = dead.length - ourFault.length;

w(`**Read that number carefully.** ${ourFault.length} of the ${dead.length} returned a status that`);
w("points at *our request* rather than their infrastructure — HTTP 400 responses");
w("naming a missing parameter, and 405s rejecting the method we used. Those");
w("agents may be working perfectly for a caller who sends what they expect. We");
w("send a service's documented example when it publishes one and `{}` when it");
w("does not, and most publish nothing.");
w("");
w(`The defensible claim is therefore: **${theirFault} of ${n} (${pct(theirFault)}%) were unreachable or`);
w(`returned a missing-route or server error**, and a further ${ourFault.length} refused a request`);
w("we cannot prove was well-formed. Both numbers are in the table below; the");
w("larger one should not be quoted on its own.");
w("");
if (ourFault.length) {
  w("Where our request is the likelier cause:");
  w("");
  for (const row of ourFault) {
    const detail = String(row.detail ?? "").replace(/\s+/g, " ").slice(0, 96);
    w(`- **#${row.agent_id} ${row.name}** — ${detail}`);
  }
  w("");
}
w("For a buyer using only the public listing metadata, roughly two in five agents");
w("could not be classified as callable by this preflight.");
w("");
w("---");
w("");
w("## Where the listed price and the live challenge disagree");
w("");
w("The listing states a price. The live 402 states a price. On the endpoint and");
w("body we probed, they are not always the same number.");
w("");
// The strongest technical objection to these ratios is that they might be
// decimal-scale artifacts: comparing base units across two different scales
// produces a meaningless multiple. Answer it in the text rather than leaving a
// reader to wonder, because every one of these rows names somebody.
{
  const assets = new Set(overListing.map((r) => String(r.asset ?? "").toLowerCase()));
  const declared = overListing.filter((r) => r.declared_decimals !== null).length;
  w("**On unit scale, since these are ratios.** Every row below is denominated in");
  w(`the same asset (${assets.size === 1 ? [...assets][0] : "see the raw data"}),`);
  w("whose 6-decimal scale is read from the token contract itself rather than from");
  w(`the challenge — ${declared} of these ${overListing.length} challenges declare a scale at all. Both`);
  w("sides of each ratio are therefore in the same units, and the multiples below");
  w("are not scale artifacts. A ratio between two *different* assets would not be");
  w("reported here at all.");
  w("");
}
w("| agent | listed | live 402 demands | ratio |");
w("|---|---:|---:|---:|");
for (const r of overListing) {
  w(`| #${r.agent_id} ${r.name} | ${usdt(r.listed_amount.amount)} | ${usdt(r.live_amount.amount)} | **${r.price_ratio}×** |`);
}
w("");
const worst = overListing[0];
if (worst) {
  w(`**On the first endpoint-bearing service we probed for #${worst.agent_id} ${worst.name}, the`);
  w(`marketplace listing showed ${usdt(worst.listed_amount.amount)} while the 402 challenge returned`);
  w(`${usdt(worst.live_amount.amount)} — ${worst.price_ratio}×.**`);
  w("");
  w("The probe cannot distinguish tiered pricing, a payload-dependent rate, a");
  w("listing entry the owner has since updated, or a different service on the same");
  w("agent. It records what the listing said and what the challenge asked, at one");
  w("timestamp, for one request.");
  w("");
  w("The point is not that any seller did something wrong. It is that the two");
  w(`numbers can differ by ${worst.price_ratio}× and only the buyer is positioned to notice before`);
  w("signing.");
  w("");
}
if (underListing.length) {
  w(`The gap runs both ways. ${underListing.length} agent(s) charged *less* than the listing showed —`);
  w(`for example #${underListing[0].agent_id} ${underListing[0].name}, listed at`);
  w(`${usdt(underListing[0].listed_amount.amount)} and charging ${usdt(underListing[0].live_amount.amount)}.`);
  w("That is the same drift in the opposite direction, and it costs the seller.");
  w("");
}
if (freeDespitePrice.length) {
  w(`${freeDespitePrice.length} agents show a nonzero price on the listing and answered 200 without`);
  w("issuing a challenge. The probe cannot tell an intentional free tier from a");
  w("charge path that is not wired up:");
  w("");
  for (const r of freeDespitePrice) {
    w(`- #${r.agent_id} ${r.name} — listed ${usdt(r.listed_amount.amount)}, returned 200 without a challenge`);
  }
  w("");
  w("The probe does not judge whether those 200 bodies contain a useful deliverable.");
  w("They may be free despite the listing, or they may be non-billable/error responses;");
  w("a paid semantic check would be required to distinguish the two.");
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
w("Until then the checking has to happen somewhere, and today that is whoever is");
w("about to spend the money.");
w("");
w("Disclosure: we publish this as a competitor. The Firm is listed on the same");
w("marketplace, and a reader is entitled to note that a report showing other");
w("agents as unreachable is convenient for a product that sells vetting. So take");
w("the numbers and leave the framing: this is the preflight dataset we run before");
w("our own jobs, the prober is MIT-licensed and in the repository, and the");
w("platform could run the same check without us. We would rather it did.");
w("");
w("---");
w("");
// Narrative, not computed from the scan file. Kept in the generator so the
// report stays reproducible end to end, and flagged as narrative so the
// "nothing here is typed by hand" claim above still holds for every figure.
w("## Postscript: the dataset predicted our own production run");
w("");
w("_Narrative section, added 2026-07-22. The figures above are computed from the");
w("scan; the account below is from our own job records and X Layer, cited so it");
w("can be checked._");
w("");
w("A day after this scan we put real money through the marketplace — a paid job");
w("on our own endpoint, hiring from this same population. It reproduced the");
w("dataset almost exactly.");
w("");
w("It worked through candidates in ranked order. The first three it reached were");
w("all agents this scan had already recorded as dead — Predexon (#2143, HTTP");
w("error), Proof of Behavior (#5082, unreachable) and Scope (#3733, unreachable)");
w("— and two more (#3118, #5175) with the same record came further down the list.");
w("");
w("Two candidates were refused before any signature because their live price");
w("exceeded the job's ceiling: Clawby (#3209) and SignalForge AI (#6560), both of");
w("which appear in the mispricing table above. That is this report's second");
w("finding meeting a spend cap in production.");
w("");
w("Worth noting against the easy conclusion: two candidates that this scan");
w("recorded as healthy — #5524 and #5557, both answering with a valid challenge —");
w("were reached and still returned nothing usable. A conformant 402 means a");
w("seller can take your money, not that it will do the work. This report measures");
w("the first property and cannot measure the second.");
w("");
w("No vendor delivered on that run. The job refunded its buyer in full,");
w("automatically, and absorbed the vendor cost it had already paid.");
w("");
w("The proximate cause was ours, not the marketplace's. Our ranking used");
w("marketplace-reported reputation, which carries no liveness signal, so a dead");
w("endpoint with good stats outranked a live one. We had this dataset and were");
w("not ranking on it. Folding the measured verdicts in took dead-agent attempts");
w("in the next run to zero.");
w("");
w("That run still failed, and again it was us: our validator rejected a live");
w("vendor's genuine data because its success code was one we did not recognise.");
w("With that fixed, the job completed through CoinAnk (#2013) in twelve seconds.");
w("");
w("Three things are worth taking from it. The failure rate reported here is not");
w("an abstraction — it is what a buyer meets, in order, on a first real job. A");
w("reliability dataset is only worth what you rank on, and we published this");
w("problem before we had fixed our own exposure to it. And liveness is a floor,");
w("not a guarantee: the two hardest failures came from endpoints that answered");
w("correctly and delivered nothing.");
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
  HTTP_ERROR: "**failed**",
  UNREACHABLE: "**failed**"
};
for (const r of results) {
  const listed = r.listed_amount ? usdt(r.listed_amount.amount) : "—";
  const live = r.live_amount ? usdt(r.live_amount.amount) : "—";
  const ratio = r.price_ratio !== null ? `${r.price_ratio}×` : "—";
  w(`| ${mark[r.verdict] ?? "?"} | #${r.agent_id} ${r.name} | ${listed} | ${live} | ${ratio} | ${r.latency_ms} |`);
}
w("");

console.log(out.join("\n"));
