#!/usr/bin/env node
/**
 * One-command, filmable hackathon proof.
 *
 * Truth classes never share a section:
 *   1. LIVE + UNPAID: current 402 probes. No signer is imported.
 *   2. REAL + HISTORICAL: settled transactions, every one linked on-chain.
 *
 * Rewritten 2026-07-22. The third section used to be a SIMULATED fixture
 * demonstration of failure and fallback, carried because no real incident
 * existed. One does now, so the fixtures are gone: the failure, the refund and
 * the delivery below all happened, on X Layer, and every hash resolves.
 *
 * Every inbound payment shown was made by this team from its own wallet as QA.
 * It is labelled that way on screen. It is not revenue and must never be
 * narrated as a customer.
 *
 * This script never signs, settles, refunds, or loads a wallet key.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const paced = process.argv.includes("--paced");

// Outbound: what The Firm paid third-party agents. Costs, never revenue.
// G1/G2 were signed by the OKX CLI on a laptop; G3 is the one that matters,
// signed in-process by the deployed procurer on a machine that cannot run that
// CLI at all.
const PAYMENTS = [
  {
    gate: "G1 procurer payment spike (laptop)",
    tx: "0x493a34a5b33dc8c17760a81d4b028f298ccb9264d19dd1032e9549b182f26072"
  },
  {
    gate: "G2 full graph -> live vendor (laptop)",
    tx: "0x2672820a7d1429a7a84c03f330d89b64bf3701e090aab9bb4ee83a08bbec7eb9"
  },
  {
    gate: "G3 deployed procurer, unattended, in-process signing",
    tx: "0xf8413f4b891678a2f4a602ea8935c30661d6958365dd8068ea47a89564406fb8"
  }
];

// Inbound: real settled purchases of Firm Express. Ours, as QA. Task ids are in
// firm_jobs; the vendor sequence below is that job's own progress log verbatim.
const REFUNDED_JOB = {
  task: "t_25d01a301c094563",
  settle: "0x5914f59bdd0222291df1f83e4146e0492370feebbc98bd9ed8bf2d25eec8a639",
  refund: "0xef5c392ba796d1a4f5dfb445aed8f356b1f1b7ac1d8994e9424624149737fa94",
  fired: [
    "2143 Predexon          failed to deliver  -> fired",
    "5082 Proof of Behavior failed to deliver  -> fired",
    "3733 Scope             unsignable challenge -> refused before payment",
    "5524 API2ASP Factory   failed to deliver  -> fired",
    "5557 Pitchook          failed to deliver  -> fired",
    "3209 Clawby            live price over cap -> refused before payment"
  ]
};

const DELIVERED_JOB = {
  task: "t_c6aaf880fb2a441f",
  settle: "0x47b3572a7dd59003b215d386a4b9d36e6b201469bd8ad3e6128b078c80779713",
  vendor: "2013 CoinAnk OpenAPI",
  seconds: 12
};

const explorer = (tx) => `https://www.oklink.com/xlayer/tx/${tx}`;

const line = (text = "") => console.log(text);

function banner(label, title) {
  line("");
  line("=".repeat(72));
  line(`${label}  |  ${title}`);
  line("=".repeat(72));
}

async function pause(ms) {
  if (paced) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(script, args = []) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], {
      cwd: path.resolve(HERE, "../.."),
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with ${signal ?? `code ${code}`}`));
    });
  });
}

line("THE FIRM — 90-SECOND PROOF");
line("One goal. One fixed price. Vetted agents. One accountable result.");
line("This command cannot spend money: it imports no signer and loads no wallet key.");

banner("LIVE / UNPAID", "Check vendors before trusting a marketplace listing");
await run("background-check.js", ["--compact"]);
line("");
line("JULY 21 SNAPSHOT / UNPAID");
line("  95 endpoint-bearing agents in our 218-agent ten-query search snapshot.");
line("  41 failed the unpaid preflight: 9 unreachable, 32 unusable HTTP responses.");
line("  7 returned 200 without a challenge; 5 advertised nonzero fees.");
line("  5 live prices exceeded their listings.");
line("  Source: data/marketplace-health-2026-07-21.json");
await pause(7_000);

banner("REAL / SETTLED", "The Firm pays third-party agents on X Layer");
line("Each payment was 15 base units (0.000015 USDT) to OKLink agent #2023.");
line("These are Firm procurement costs — not customer revenue.");
line("");
for (const payment of PAYMENTS) {
  line(payment.gate);
  line(`  tx: ${payment.tx}`);
  line(`  ${explorer(payment.tx)}`);
}
line("");
line("Idempotency is enforced by the token, not just our database: the EIP-3009");
line("nonce is derived from the job key, so a re-signed subtask reproduces the");
line("same authorization and the chain refuses the duplicate.");
await pause(7_000);

banner("REAL / REFUNDED", "It failed. The guarantee paid out. Nobody intervened.");
line("A real purchase of Firm Express. OUR OWN WALLET — QA, not a customer.");
line(`Task ${REFUNDED_JOB.task}`);
line("");
for (const attempt of REFUNDED_JOB.fired) line(`  ${attempt}`);
line("");
line("No vendor delivered. The Firm refunded the buyer in full, automatically,");
line("and absorbed the vendor cost it had already paid.");
line(`  paid in : ${explorer(REFUNDED_JOB.settle)}`);
line(`  refunded: ${explorer(REFUNDED_JOB.refund)}`);
line("");
line("Our own July 21 probe predicted this: the first vendors it reached were");
line("agents that scan had already recorded as dead.");
await pause(7_000);

banner("REAL / DELIVERED", "Rank on measured liveness, and the same job completes");
line("OUR OWN WALLET — QA, not a customer.");
line(`Task ${DELIVERED_JOB.task} — delivered via ${DELIVERED_JOB.vendor} in ~${DELIVERED_JOB.seconds}s`);
line(`  settled : ${explorer(DELIVERED_JOB.settle)}`);
line("");
line("  user price            100000");
line("  vendor costs         −  1000");
line("  ─────────────────────────────");
line("  margin retained         99000");
await pause(7_000);

banner("THE PRODUCT", "The accountable employer for an agent workforce");
line("Live probes decide who is safe to pay. Real transactions prove we can hire.");
line("Validation and replacement keep the customer's fixed price fixed.");
line("Every result ends with a costed provenance receipt.");
