/**
 * Reservation and cap tests against a real Postgres.
 *
 * These are the tests that prove the property the brief asks for: "no
 * interleaving of calls can breach a cap". That property lives in a
 * transaction and an advisory lock, so it cannot be demonstrated with mocks —
 * it needs a real database and genuinely concurrent callers.
 *
 * Skipped unless PROCURER_TEST_DATABASE_URL is set, so `pnpm test` stays green
 * on a machine with no database:
 *   PROCURER_TEST_DATABASE_URL=postgresql://firm:firm@127.0.0.1:5433/firm pnpm -F @firm/procurer test
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Caps } from "./caps.js";
import {
  closePool,
  ensureTables,
  markSigned,
  pool,
  releaseCall,
  reserveCall,
  reserveRefund,
  settleCall,
  settleRefund,
  spendSnapshot
} from "./db.js";

const configured = process.env.PROCURER_TEST_DATABASE_URL;
const suite = configured ? describe : describe.skip;

/**
 * The daily-cap tests assert on a SUM over every row created today, so they
 * cannot share tables with the eval suite or the demo — a run of either would
 * silently consume the budget under test and the failure would look like a bug
 * in the lock. Each run gets its own Postgres schema instead of deleting rows
 * out from under whatever else is using the database.
 */
const SCHEMA = `procurer_test_${process.pid}`;

function urlWithSchema(base: string, schema: string) {
  const parsed = new URL(base);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  return parsed.toString();
}

const url = configured ? urlWithSchema(configured, SCHEMA) : undefined;

async function createSchema() {
  const admin = new (await import("pg")).default.Pool({ connectionString: configured });
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  } finally {
    await admin.end();
  }
}

async function dropSchema() {
  const admin = new (await import("pg")).default.Pool({ connectionString: configured });
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  } finally {
    await admin.end();
  }
}

const caps: Caps = {
  perCallMax: 100_000,
  perTaskMax: 250_000,
  dailyMax: 500_000,
  dailyRefundMax: 200_000
};

const usdt = (units: number) => ({ amount: String(units), decimals: 6, token: "USDT" });

const call = (taskId: string, subtaskId: string, endpoint = "http://vendor.test") => ({
  idempotencyKey: `${taskId}:${subtaskId}:${endpoint}`,
  taskId,
  subtaskId,
  vendorEndpoint: endpoint,
  ceiling: usdt(0)
});

suite("procurer reservations", () => {
  beforeAll(async () => {
    await createSchema();
    process.env.DATABASE_URL = url;
    await ensureTables();
    // Mirrors apps/firm/migrations/001_init.sql. F3 owns this table; the
    // procurer only ever reads it, and this test needs a row to read.
    await pool().query(`
      CREATE TABLE IF NOT EXISTS firm_jobs (
        task_id TEXT PRIMARY KEY,
        quote_id TEXT NOT NULL,
        state TEXT NOT NULL,
        goal TEXT NOT NULL,
        quote JSONB NOT NULL,
        progress JSONB NOT NULL DEFAULT '[]'::jsonb,
        deliverable JSONB,
        provenance JSONB,
        refund JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    // The schema belongs to this test run, so a full truncate is safe and
    // leaves no cross-test residue in the daily-cap sums.
    await pool().query("TRUNCATE procurer_calls, procurer_refunds, firm_jobs");
  });

  describe("real and simulated spend ledgers", () => {
    it("simulated spend does not consume the real daily budget", async () => {
      // The bug this pins: eval traffic and real payments shared one ledger, so
      // a day of tests could exhaust the live daily cap — and did, blocking a
      // real run.
      const tight = { ...caps, dailyMax: 100_000 };
      const sim = { ...call("test_modes_sim", "s0"), ceiling: usdt(100_000) };
      expect((await reserveCall(sim, 100_000, tight, "simulated")).kind).toBe("reserved");

      // The real ledger is untouched by that, so a real call of the full daily
      // budget still fits.
      const real = { ...call("test_modes_real", "s0"), ceiling: usdt(100_000) };
      expect((await reserveCall(real, 100_000, tight, "real")).kind).toBe("reserved");
    });

    it("real spend does not consume the simulated budget either", async () => {
      const tight = { ...caps, dailyMax: 100_000 };
      expect((await reserveCall({ ...call("test_modes_r2", "s0"), ceiling: usdt(100_000) }, 100_000, tight, "real")).kind).toBe("reserved");
      expect((await reserveCall({ ...call("test_modes_s2", "s0"), ceiling: usdt(100_000) }, 100_000, tight, "simulated")).kind).toBe("reserved");
    });

    it("refuses to replay a simulated receipt for a real request", async () => {
      // Returning a SIMULATED receipt to a real caller would look exactly like a
      // completed payment that never happened.
      const request = { ...call("test_modes_mix", "s0"), ceiling: usdt(50_000) };
      expect((await reserveCall(request, 50_000, caps, "simulated")).kind).toBe("reserved");
      await settleCall(request.idempotencyKey, usdt(50_000), { ok: true, receipt: { tx: "SIMULATED:pay:x" } });

      const asReal = await reserveCall(request, 50_000, caps, "real");
      expect(asReal).toMatchObject({ kind: "needs_human" });
      expect((asReal as { detail: string }).detail).toMatch(/simulated and real/);
    });

    it("reports the two ledgers separately so simulated never reads as money", async () => {
      const before = await spendSnapshot();
      const outcome = await reserveCall({ ...call("test_modes_snap", "s0"), ceiling: usdt(70_000) }, 70_000, caps, "simulated");
      expect(outcome.kind).toBe("reserved");
      const after = await spendSnapshot();

      expect(after.simulated_today - before.simulated_today).toBe(70_000);
      expect(after.spent_today).toBe(before.spent_today);
    });
  });

  it("admits exactly one of two concurrent requests for the same subtask", async () => {
    const request = { ...call("test_idem", "s1"), ceiling: usdt(50_000) };
    const [first, second] = await Promise.all([
      reserveCall(request, 50_000, caps, "real"),
      reserveCall(request, 50_000, caps, "real")
    ]);

    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["in_flight", "reserved"]);
  });

  it("never lets concurrent distinct subtasks breach the per-task cap", async () => {
    // Six callers, 50k each, per-task cap 250k. At most five can be admitted,
    // and the sum of what is admitted must never exceed the cap.
    const requests = Array.from({ length: 6 }, (_, index) => ({
      ...call("test_task_cap", `s${index}`),
      ceiling: usdt(50_000)
    }));

    const outcomes = await Promise.all(requests.map((request) => reserveCall(request, 50_000, caps, "real")));
    const admitted = outcomes.filter((outcome) => outcome.kind === "reserved").length;

    expect(admitted).toBe(5);
    expect(outcomes.filter((outcome) => outcome.kind === "cap_exceeded")).toHaveLength(1);

    const total = await pool().query(
      `SELECT COALESCE(SUM((reserved_amount->>'amount')::bigint), 0)::bigint AS spend
       FROM procurer_calls WHERE task_id = 'test_task_cap' AND state <> 'released'`
    );
    expect(Number(total.rows[0].spend)).toBeLessThanOrEqual(caps.perTaskMax);
  });

  it("never lets concurrent tasks breach the daily cap", async () => {
    const requests = Array.from({ length: 8 }, (_, index) => ({
      ...call(`test_daily_${index}`, "s0"),
      ceiling: usdt(100_000)
    }));

    const outcomes = await Promise.all(requests.map((request) => reserveCall(request, 100_000, caps, "real")));
    const admitted = outcomes.filter((outcome) => outcome.kind === "reserved").length;

    expect(admitted).toBe(5); // 5 x 100k = the 500k daily cap exactly.
    const snapshot = await spendSnapshot();
    expect(snapshot.spent_today).toBeLessThanOrEqual(caps.dailyMax);
  });

  it("rejects a single call above the per-call cap before it reserves anything", async () => {
    const outcome = await reserveCall({ ...call("test_percall", "s0"), ceiling: usdt(100_001) }, 100_001, caps, "real");
    expect(outcome).toMatchObject({ kind: "cap_exceeded", detail: /per-call/ });

    const rows = await pool().query("SELECT 1 FROM procurer_calls WHERE task_id = 'test_percall'");
    expect(rows.rowCount).toBe(0);
  });

  it("replays a settled receipt instead of paying twice", async () => {
    const request = { ...call("test_replay", "s0"), ceiling: usdt(50_000) };
    expect((await reserveCall(request, 50_000, caps, "real")).kind).toBe("reserved");

    const receipt = { ok: true, receipt: { tx: "0xrecorded" } };
    await settleCall(request.idempotencyKey, usdt(50_000), receipt);

    const repeat = await reserveCall(request, 50_000, caps, "real");
    expect(repeat).toEqual({ kind: "replay", response: receipt });
  });

  it("refuses to sign a second authorization when the first one's fate is unknown", async () => {
    const request = { ...call("test_signed", "s0"), ceiling: usdt(50_000) };
    await reserveCall(request, 50_000, caps, "real");
    await markSigned(request.idempotencyKey);

    const repeat = await reserveCall(request, 50_000, caps, "real");
    expect(repeat).toMatchObject({ kind: "needs_human" });
  });

  it("frees the cap budget when a call fails before signing", async () => {
    const request = { ...call("test_release", "s0"), ceiling: usdt(100_000) };
    await reserveCall(request, 100_000, caps, "real");
    await releaseCall(request.idempotencyKey, { ok: false, error_code: "VENDOR_TIMEOUT" });

    const snapshot = await spendSnapshot();
    expect(snapshot.spent_today).toBe(0);

    // ...and the same key can be retried.
    expect((await reserveCall(request, 100_000, caps, "real")).kind).toBe("reserved");
  });

  it("reclaims a reservation left behind by a procurer that died mid-call", async () => {
    const request = { ...call("test_stale", "s0"), ceiling: usdt(50_000) };
    expect((await reserveCall(request, 50_000, caps, "real")).kind).toBe("reserved");
    // A fresh reservation still blocks a concurrent caller.
    expect((await reserveCall(request, 50_000, caps, "real")).kind).toBe("in_flight");

    await pool().query(
      "UPDATE procurer_calls SET updated_at = now() - interval '2 hours' WHERE idempotency_key = $1",
      [request.idempotencyKey]
    );

    expect((await reserveCall(request, 50_000, caps, "real")).kind).toBe("reserved");
    // Reclaimed, not duplicated: the budget is still one call's worth.
    const snapshot = await spendSnapshot();
    expect(snapshot.spent_today).toBe(50_000);
  });

  it("never reclaims a signed row, however old", async () => {
    const request = { ...call("test_stale_signed", "s0"), ceiling: usdt(50_000) };
    await reserveCall(request, 50_000, caps, "real");
    await markSigned(request.idempotencyKey);
    await pool().query(
      "UPDATE procurer_calls SET updated_at = now() - interval '30 days' WHERE idempotency_key = $1",
      [request.idempotencyKey]
    );

    expect(await reserveCall(request, 50_000, caps, "real")).toMatchObject({ kind: "needs_human" });
  });

  it("does not free the budget for a call that already signed", async () => {
    const request = { ...call("test_no_release", "s0"), ceiling: usdt(100_000) };
    await reserveCall(request, 100_000, caps, "real");
    await markSigned(request.idempotencyKey);
    await releaseCall(request.idempotencyKey, { ok: false, error_code: "VENDOR_TIMEOUT" });

    const snapshot = await spendSnapshot();
    expect(snapshot.spent_today).toBe(100_000);
    expect(snapshot.unconfirmed_signatures).toBe(1);
  });
});

suite("procurer refunds", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    await ensureTables();
  });

  afterAll(async () => {
    await closePool();
    await dropSchema();
  });

  beforeEach(async () => {
    await pool().query("TRUNCATE procurer_refunds, firm_jobs");
  });

  async function seedJob(taskId: string, priceUnits: number) {
    await pool().query(
      `INSERT INTO firm_jobs (task_id, quote_id, state, goal, quote)
       VALUES ($1, 'q_test', 'complete', 'test goal', $2::jsonb)`,
      [taskId, JSON.stringify({ price: usdt(priceUnits) })]
    );
  }

  it("auto-approves a refund at or below the task's quoted price", async () => {
    await seedJob("test_refund_ok", 100_000);
    const outcome = await reserveRefund(
      { taskId: "test_refund_ok", toAddress: "0xuser", amount: usdt(100_000) },
      100_000,
      caps
    );
    expect(outcome.kind).toBe("reserved");
  });

  it("requires a human above the quoted price", async () => {
    await seedJob("test_refund_over", 100_000);
    const outcome = await reserveRefund(
      { taskId: "test_refund_over", toAddress: "0xuser", amount: usdt(100_001) },
      100_001,
      caps
    );
    expect(outcome).toMatchObject({ kind: "requires_human", detail: /exceeds the task's quoted price/ });
  });

  it("requires a human when there is no quote to bound the refund", async () => {
    const outcome = await reserveRefund(
      { taskId: "test_refund_unknown", toAddress: "0xuser", amount: usdt(1) },
      1,
      caps
    );
    expect(outcome).toMatchObject({ kind: "requires_human", detail: /no quoted price on record/ });
  });

  it("enforces the daily refund cap across concurrent refunds", async () => {
    for (let index = 0; index < 4; index += 1) {
      await seedJob(`test_refund_daily_${index}`, 100_000);
    }

    const outcomes = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        reserveRefund(
          { taskId: `test_refund_daily_${index}`, toAddress: "0xuser", amount: usdt(100_000) },
          100_000,
          caps
        )
      )
    );

    expect(outcomes.filter((outcome) => outcome.kind === "reserved")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome.kind === "cap_exceeded")).toHaveLength(2);
  });

  it("replays a settled refund instead of sending a second transfer", async () => {
    await seedJob("test_refund_replay", 100_000);
    await reserveRefund({ taskId: "test_refund_replay", toAddress: "0xuser", amount: usdt(50_000) }, 50_000, caps);
    await settleRefund("test_refund_replay", { tx: "0xrefund" });

    const repeat = await reserveRefund(
      { taskId: "test_refund_replay", toAddress: "0xuser", amount: usdt(50_000) },
      50_000,
      caps
    );
    expect(repeat).toEqual({ kind: "replay", response: { tx: "0xrefund" } });
  });

});
