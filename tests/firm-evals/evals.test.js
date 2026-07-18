import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeliverable,
  usdt,
  validateDeliverable,
  vendors
} from "../../packages/mocks/src/fixtures.js";

const BOOKS_LINE = "Treasury Copilot (our own product, intra-team payment, disclosed)";

function addMoney(...money) {
  return usdt(money.reduce((sum, item) => sum + Number(item.amount), 0));
}

function runFixtureProject({ allFail = false, perTaskCap = usdt(1000000) } = {}) {
  const goal = "Prepare a launch and market briefing";
  const quotedPrice = usdt(600000);
  const rejected = {
    agent_id: vendors.vendor_rejected.agent_id,
    reason: "trust score 41 below minimum 60"
  };

  const candidates = allFail
    ? ["vendor_flaky", "vendor_dead"]
    : ["vendor_flaky", "vendor_good"];

  const hires = [];
  const vendorsFired = [];
  const progress = [];
  const performance = new Map();
  let state = "procuring";
  let spent = usdt(0);

  for (const candidate of candidates) {
    const vendor = vendors[candidate];
    const service = vendor.services.find((entry) => entry.tool === "launch_brief");
    const wouldSpend = Number(spent.amount) + Number(service.price.amount);

    if (wouldSpend > Number(perTaskCap.amount)) {
      state = "failed_refunded";
      progress.push({
        subtask_id: "launch-brief",
        state: "refunding",
        note: "budget breach imminent; halted before payment"
      });
      break;
    }

    if (candidate === "vendor_dead") {
      performance.set(vendor.agent_id, { validation_failures: 0, timeouts: 1, adjustment: -10 });
      progress.push({
        subtask_id: "launch-brief",
        state: "refunding",
        note: "candidate timed out"
      });
      state = "failed_refunded";
      break;
    }

    const result = buildDeliverable(candidate, "launch_brief", { failure_mode: "stale_schema" });
    const validation = validateDeliverable(result);
    spent = addMoney(spent, service.price);

    const hire = {
      agent_id: vendor.agent_id,
      subtask: "launch brief",
      cost: service.price,
      tx: `SIMULATED:${vendor.agent_id}`,
      validation: {
        passed: validation.passed,
        checks: validation.checks_run
      }
    };
    hires.push(hire);

    if (!validation.passed) {
      vendorsFired.push({
        agent_id: vendor.agent_id,
        subtask: "launch brief",
        reason: `validation failed: ${validation.failures.map((failure) => failure.check).join(", ")}`,
        cost_absorbed: service.price
      });
      performance.set(vendor.agent_id, {
        validation_failures: 1,
        timeouts: 0,
        adjustment: -10
      });
      progress.push({
        subtask_id: "launch-brief",
        state: "procuring",
        note: "fired failing vendor and re-hired next candidate"
      });
      continue;
    }

    performance.set(vendor.agent_id, {
      validation_failures: 0,
      timeouts: 0,
      adjustment: 1
    });
    state = "complete";
    break;
  }

  if (allFail && state !== "complete") {
    state = "failed_refunded";
  }

  const guaranteeStatus = state === "complete" ? "delivered" : "refunded";
  const refund = guaranteeStatus === "refunded" ? { tx: "SIMULATED:refund:task-fixture-001" } : null;
  const margin = Number(quotedPrice.amount) - Number(spent.amount) - 50000;

  return {
    task_id: "task-fixture-001",
    state,
    charged: quotedPrice,
    refund,
    progress,
    performance,
    deliverable:
      state === "complete"
        ? { title: "Launch and market briefing", sections: ["market", "launch", "risk"] }
        : null,
    provenance: {
      task_id: "task-fixture-001",
      goal,
      quote: { price: quotedPrice, quoted_at: "2026-07-18T12:00:00Z" },
      vendors_vetted: 3,
      vendors_rejected: [rejected],
      vendors_fired: vendorsFired,
      hires,
      economics: {
        user_price: quotedPrice,
        actual_vendor_costs: spent,
        margin_retained_or_absorbed: {
          amount: String(Math.abs(margin)),
          sign: margin >= 0 ? "retained" : "absorbed"
        }
      },
      books: {
        by: BOOKS_LINE,
        cost: usdt(50000),
        tx: "SIMULATED:treasury-books",
        statement: "SIMULATED books statement for fixture eval"
      },
      guarantee_status: guaranteeStatus,
      generated_at: "2026-07-18T12:30:00Z"
    }
  };
}

test("quote honored, including absorbed margin when a vendor is fired", () => {
  const run = runFixtureProject();

  assert.equal(run.state, "complete");
  assert.equal(run.charged.amount, run.provenance.quote.price.amount);
  assert.equal(run.provenance.vendors_fired.length, 1);
  assert.equal(run.provenance.economics.margin_retained_or_absorbed.sign, "absorbed");
});

test("fallback fires, performance downgrades, and next candidate delivers", () => {
  const run = runFixtureProject();
  const flakyPerformance = run.performance.get(vendors.vendor_flaky.agent_id);
  const goodHire = run.provenance.hires.at(-1);

  assert.equal(run.provenance.vendors_fired[0].agent_id, vendors.vendor_flaky.agent_id);
  assert.equal(flakyPerformance.validation_failures, 1);
  assert.equal(flakyPerformance.adjustment, -10);
  assert.equal(goodHire.agent_id, vendors.vendor_good.agent_id);
  assert.equal(run.deliverable.title, "Launch and market briefing");
});

test("refund on total failure returns full guarantee and retains no partial charge", () => {
  const run = runFixtureProject({ allFail: true });

  assert.equal(run.state, "failed_refunded");
  assert.equal(run.provenance.guarantee_status, "refunded");
  assert.ok(run.refund.tx.startsWith("SIMULATED:refund:"));
  assert.equal(run.charged.amount, run.provenance.quote.price.amount);
});

test("provenance contains required receipt fields", () => {
  const { provenance } = runFixtureProject();

  assert.equal(typeof provenance.vendors_vetted, "number");
  assert.ok(provenance.vendors_rejected[0].reason.includes("trust score"));
  assert.ok(provenance.hires.every((hire) => hire.tx && hire.cost && hire.validation));
  assert.ok(["retained", "absorbed"].includes(provenance.economics.margin_retained_or_absorbed.sign));
  assert.equal(provenance.books.by, BOOKS_LINE);
});

test("budget safety halts before paying a cap-breaching vendor sequence", () => {
  const run = runFixtureProject({ perTaskCap: usdt(250000) });

  assert.equal(run.state, "failed_refunded");
  assert.equal(run.provenance.actual_vendor_costs?.amount, undefined);
  assert.equal(run.provenance.economics.actual_vendor_costs.amount, "0");
  assert.ok(run.progress[0].note.includes("halted before payment"));
});
