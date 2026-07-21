#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  buildDeliverable,
  usdt,
  validateDeliverable,
  vendors
} from "../../packages/mocks/src/fixtures.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const liveMode = process.argv.includes("--live");
const gatewayArg = process.argv.find((arg) => arg.startsWith("--gateway-url="));
const gatewayUrl = gatewayArg?.split("=")[1];

function line(text = "") {
  console.log(text);
}

function section(title) {
  line("");
  line(title);
  line("-".repeat(title.length));
}

function money(value) {
  return `${(Number(value.amount) / 10 ** value.decimals).toFixed(2)} ${value.token ?? "USDT"}`;
}

function receipt() {
  const userPrice = usdt(600000);
  const flakyCost = vendors.vendor_flaky.services.find((service) => service.tool === "launch_brief").price;
  const goodCost = vendors.vendor_good.services.find((service) => service.tool === "launch_brief").price;
  const booksCost = usdt(50000);
  const actualVendorCosts = usdt(Number(flakyCost.amount) + Number(goodCost.amount) + Number(booksCost.amount));
  const absorbed = Number(actualVendorCosts.amount) - Number(userPrice.amount);

  return {
    task_id: "t_demo_fixture_001",
    goal: "Prepare a launch and market briefing for a token campaign",
    quote: { price: userPrice, quoted_at: "2026-07-18T12:00:00Z" },
    vendors_vetted: 4,
    vendors_rejected: [
      {
        agent_id: vendors.vendor_rejected.agent_id,
        reason: "trust score 41 below minimum 60"
      }
    ],
    vendors_fired: [
      {
        agent_id: vendors.vendor_flaky.agent_id,
        subtask: "launch brief",
        reason: "validation failed: schema, non_empty_content, freshness",
        cost_absorbed: flakyCost
      }
    ],
    hires: [
      {
        agent_id: vendors.vendor_flaky.agent_id,
        subtask: "launch brief",
        cost: flakyCost,
        tx: `SIMULATED:${vendors.vendor_flaky.agent_id}:1`,
        validation: { passed: false, checks: ["schema", "non_empty_content", "freshness"] }
      },
      {
        agent_id: vendors.vendor_good.agent_id,
        subtask: "launch brief",
        cost: goodCost,
        tx: `SIMULATED:${vendors.vendor_good.agent_id}:1`,
        validation: { passed: true, checks: ["schema", "non_empty_content", "freshness"] }
      }
    ],
    economics: {
      user_price: userPrice,
      actual_vendor_costs: actualVendorCosts,
      margin_retained_or_absorbed: {
        amount: String(absorbed),
        sign: "absorbed"
      }
    },
    books: {
      by: "Treasury Copilot (our own product, intra-team payment, disclosed)",
      cost: booksCost,
      tx: "SIMULATED:treasury-books",
      statement: "SIMULATED fixture-mode books statement"
    },
    guarantee_status: "delivered",
    generated_at: "2026-07-18T12:30:00Z"
  };
}

async function postGateway(tool, args) {
  const response = await fetch(gatewayUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, args })
  });
  return response.json();
}

if (gatewayUrl) {
  const goal = "Prepare a launch briefing";
  line("Firm Projects demo spine");
  line("========================");
  line("Mode: LOCAL SERVICE SIMULATION via gateway + worker");
  line("Payments/txs in this mode are SIMULATED unless the configured procurer says otherwise.");
  line("");
  section("Quote");
  const quote = await postGateway("get_quote", {
    goal,
    budget_cap: { amount: "5000000", decimals: 6, token: "USDT" },
    constraints: { deadline_minutes: 60, min_vendor_score: 60, banned_categories: [] }
  });
  line(`Goal: ${goal}`);
  line(`Fixed price: ${money(quote.price)}`);
  line(`Quote id: ${quote.quote_id}`);
  section("Execution (live)");
  const execution = await postGateway("execute", { quote_id: quote.quote_id });
  line(`Task id: ${execution.task_id}`);

  // Run the worker in the background and stream its checkpoints as the Firm
  // sources, hires, validates, fires, and re-hires — so the fallback is watched
  // live rather than summarised after the fact.
  const worker = spawn("uv", ["run", "firm-worker", "work-task-demo", execution.task_id], {
    cwd: new URL("../../apps/firm", import.meta.url),
    env: { ...process.env, UV_CACHE_DIR: "/tmp/firm-uv-cache" },
    encoding: "utf8"
  });
  let workerStderr = "";
  let workerExited = false;
  worker.stderr.on("data", (chunk) => (workerStderr += chunk));
  worker.on("exit", () => (workerExited = true));

  const terminal = new Set(["complete", "failed_refunded", "refunded"]);
  let printed = 0;
  let finalState = execution.state;
  for (let poll = 0; poll < 600; poll += 1) {
    const status = await postGateway("get_status", { task_id: execution.task_id });
    const progress = status.progress ?? [];
    for (; printed < progress.length; printed += 1) {
      line(`- ${progress[printed].state}: ${progress[printed].note}`);
    }
    finalState = status.state ?? finalState;
    if (terminal.has(finalState)) break;
    if (workerExited) {
      // One last read to flush any checkpoint written just before exit.
      const flush = await postGateway("get_status", { task_id: execution.task_id });
      for (const checkpoint of (flush.progress ?? []).slice(printed)) {
        line(`- ${checkpoint.state}: ${checkpoint.note}`);
      }
      finalState = flush.state ?? finalState;
      break;
    }
    await sleep(250);
  }
  if (!terminal.has(finalState) && workerStderr) {
    throw new Error(workerStderr);
  }
  line(`Final state: ${finalState}`);

  section("Result");
  const result = await postGateway("get_result", { task_id: execution.task_id });
  line(`Guarantee: ${result.provenance.guarantee_status}`);
  line(
    `Economics: ${result.provenance.economics.margin_retained_or_absorbed.sign} ${money({
      ...result.provenance.economics.margin_retained_or_absorbed,
      decimals: 6,
      token: "USDT"
    })}`
  );
  line("Profit and Provenance Receipt");
  line(JSON.stringify(result.provenance, null, 2));
} else if (liveMode) {
  line("LIVE MODE REQUESTED");
  line("No live vendor pool is configured in F4 yet. Set this up after F2 emits data/vendor-index.json.");
  process.exitCode = 1;
} else {
  const badResult = buildDeliverable("vendor_flaky", "launch_brief", { failure_mode: "stale_schema" });
  const badValidation = validateDeliverable(badResult);
  const goodResult = buildDeliverable("vendor_good", "launch_brief", {});
  const goodValidation = validateDeliverable(goodResult);
  const provenance = receipt();

  line("Firm Projects demo spine");
  line("========================");
  line("Mode: SIMULATED fixture run");
  line("");
  line(`1. Quote issued: ${money(provenance.quote.price)} fixed price, full refund if not delivered`);
  line(
    `2. Trust rejection: ${provenance.vendors_rejected[0].agent_id} rejected (${provenance.vendors_rejected[0].reason})`
  );
  line(`3. Hire: ${vendors.vendor_flaky.name} at ${money(provenance.hires[0].cost)}`);
  line(
    `4. Validation failed: ${badValidation.failures.map((failure) => failure.check).join(", ")}`
  );
  line(`5. Fired: ${vendors.vendor_flaky.agent_id}; cost absorbed by Firm`);
  line(`6. Re-hire: ${vendors.vendor_good.name} at ${money(provenance.hires[1].cost)}`);
  line(`7. Validation passed: ${goodValidation.checks_run.join(", ")}`);
  line(`8. Delivered: ${goodResult.checklist.join(" ")}`);
  line("");
  line("Profit and Provenance Receipt");
  line(JSON.stringify(provenance, null, 2));
}
