#!/usr/bin/env node
/**
 * One-command, filmable hackathon proof.
 *
 * Truth classes never share a section:
 *   1. LIVE + UNPAID: current 402 probes. No signer is imported.
 *   2. REAL + HISTORICAL: already-settled outbound payments, linked on-chain.
 *   3. SIMULATED: deterministic fixture failure/fallback and its economics.
 *
 * This script never signs, settles, refunds, or loads a wallet key.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const paced = process.argv.includes("--paced");

// Captured by the human-triggered G1/G2 runs and recorded in
// docs/firm/HANDOFF_ISHITA.md. These are outbound costs, never customer revenue.
const PAYMENTS = [
  {
    gate: "G1 procurer payment spike",
    tx: "0x493a34a5b33dc8c17760a81d4b028f298ccb9264d19dd1032e9549b182f26072"
  },
  {
    gate: "G2 full graph -> live vendor",
    tx: "0x2672820a7d1429a7a84c03f330d89b64bf3701e090aab9bb4ee83a08bbec7eb9"
  }
];

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

banner("REAL / SETTLED", "Two outbound x402 payments to OKLink agent #2023");
line("Each payment was 15 base units (0.000015 USDT) on X Layer.");
line("These are Firm procurement costs — not customer revenue.");
line("");
for (const payment of PAYMENTS) {
  line(payment.gate);
  line(`  tx: ${payment.tx}`);
  line(`  ${`https://www.oklink.com/xlayer/tx/${payment.tx}`}`);
}
line("");
line("Idempotency evidence: three worker runs produced two payments;");
line("the retry returned the recorded G2 receipt instead of paying again.");
await pause(7_000);

banner("SIMULATED", "Failure, replacement, and absorbed-margin guarantee");
line("The marketplace failure below is a deterministic fixture demonstration.");
line("No claim is made that a real vendor failed, and every tx is SIMULATED.");
line("");
await run("scenario.js", ["--compact"]);
await pause(7_000);

banner("THE PRODUCT", "The accountable employer for an agent workforce");
line("Live probes decide who is safe to pay. Real transactions prove we can hire.");
line("Validation and replacement keep the customer's fixed price fixed.");
line("Every result ends with a costed provenance receipt.");
