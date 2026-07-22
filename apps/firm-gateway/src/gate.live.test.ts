/**
 * End-to-end payment-boundary test against a real gateway process and a real
 * Postgres.
 *
 * The claim under test is not "execute returns 402" — it is "an unpaid execute
 * causes no database write". That can only be shown by running the real server
 * and then looking at the table, so this test spawns the actual entrypoint.
 *
 * Skipped unless GATEWAY_TEST_DATABASE_URL is set:
 *   GATEWAY_TEST_DATABASE_URL=postgresql://firm:firm@127.0.0.1:5433/firm pnpm -F @firm/gateway test
 */

import http from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.GATEWAY_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

let child: ChildProcess | undefined;
let base = "";
let db: pg.Pool;

async function waitForHealth(target: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${target}/health`);
      if (response.ok) return (await response.json()) as Record<string, unknown>;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`gateway did not become healthy at ${target}`);
}

async function callTool(tool: string, args: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ tool, args })
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}


/**
 * A stand-in procurer that reports a fully live fulfilment mode.
 *
 * These suites test the PAYMENT boundary, not fulfilment coherence — but the
 * gateway now refuses to start in enforce mode unless its procurer confirms it
 * will do real work and can honour a refund. Pointing the spawned gateways at
 * this keeps that guard exercised (rather than bypassed by a test-only escape
 * hatch, which is the kind of flag that eventually ships) while letting the
 * payment tests get past boot.
 */
let fulfilmentStub: http.Server | undefined;
let fulfilmentStubUrl = "";

async function startFulfilmentStub() {
  if (fulfilmentStubUrl) return fulfilmentStubUrl;
  fulfilmentStub = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "firm-procurer",
        real_payments_enabled: true,
        real_refunds_enabled: true,
        wallet_key_present: true,
        refund_ready: true
      })
    );
  });
  await new Promise<void>((resolve) => fulfilmentStub!.listen(0, "127.0.0.1", resolve));
  fulfilmentStubUrl = `http://127.0.0.1:${(fulfilmentStub.address() as AddressInfo).port}`;
  return fulfilmentStubUrl;
}

afterAll(async () => {
  if (fulfilmentStub) await new Promise((resolve) => fulfilmentStub!.close(resolve));
});

suite("gateway payment boundary (CHARGING_MODE=enforce)", () => {
  beforeAll(async () => {
    const port = 8791;
    base = `http://127.0.0.1:${port}`;
    db = new pg.Pool({ connectionString: url });

    child = spawn(path.join(packageRoot, "node_modules/.bin/tsx"), ["src/server.ts"], {
      cwd: packageRoot,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: url,
        PRICING_MODE: "TIERS",
        CHARGING_MODE: "enforce",
        PROCURER_URL: await startFulfilmentStub(),
        FIRM_PAYTO_ADDRESS: "0xfirmtestpayto",
        FIRM_CHARGE_ASSET: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
        FIRM_CHARGE_NETWORK: "eip155:196"
        // X402_FACILITATOR_URL deliberately unset: an unverifiable payment must
        // be treated exactly like no payment.
      },
      stdio: "ignore"
    });

    const health = await waitForHealth(base);
    expect(health.charging_mode).toBe("enforce");
  }, 40_000);

  afterAll(async () => {
    child?.kill();
    await db?.end();
  });

  it("still serves the free quote tool", async () => {
    const { status, body } = await callTool("get_quote", {
      goal: "market snapshot for BTC",
      budget_cap: { amount: "5000000", decimals: 6, token: "USDT" },
      constraints: {}
    });
    expect(status).toBe(200);
    expect(body.quote_id).toMatch(/^q_/);
  });

  it("answers an unpaid execute with 402 and writes no job row", async () => {
    const quote = await callTool("get_quote", {
      goal: "market snapshot for BTC",
      budget_cap: { amount: "5000000", decimals: 6, token: "USDT" },
      constraints: {}
    });
    const quoteId = quote.body.quote_id as string;

    const before = await db.query("SELECT count(*)::int AS n FROM firm_jobs WHERE quote_id = $1", [quoteId]);

    const attempt = await callTool("execute", { quote_id: quoteId });
    expect(attempt.status).toBe(402);
    expect(attempt.body.error.code).toBe("PAYMENT_REQUIRED");

    // The 402 must carry a challenge the buyer can actually act on, priced at
    // exactly the quote.
    const header = attempt.headers.get("payment-required");
    expect(header).toBeTruthy();
    const requirements = JSON.parse(Buffer.from(header as string, "base64").toString("utf8"));
    expect(requirements.accepts[0].amount).toBe(quote.body.price.amount);
    expect(requirements.accepts[0].payTo).toBe("0xfirmtestpayto");

    const after = await db.query("SELECT count(*)::int AS n FROM firm_jobs WHERE quote_id = $1", [quoteId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(after.rows[0].n).toBe(0);
  });

  it("rejects a forged payment header just as hard as a missing one", async () => {
    const quote = await callTool("get_quote", {
      goal: "market snapshot for ETH",
      budget_cap: { amount: "5000000", decimals: 6, token: "USDT" },
      constraints: {}
    });
    const quoteId = quote.body.quote_id as string;

    const attempt = await callTool(
      "execute",
      { quote_id: quoteId },
      { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ fake: true })).toString("base64") }
    );

    expect(attempt.status).toBe(402);
    const after = await db.query("SELECT count(*)::int AS n FROM firm_jobs WHERE quote_id = $1", [quoteId]);
    expect(after.rows[0].n).toBe(0);
  });

  it("rejects express_run honestly while its pool is unlocked, without charging", async () => {
    const { status, body } = await callTool("express_run", { job_type: "market_snapshot", params: {} });
    expect(status).toBe(200);
    expect(body.error.code).toBe("EXPRESS_NOT_ENABLED");
  });

  it("does not gate the read-only tools", async () => {
    const { status, body } = await callTool("get_status", { task_id: "t_does_not_exist" });
    expect(status).toBe(200);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

suite("gateway express boundary (EXPRESS_ENABLED, CHARGING_MODE=enforce)", () => {
  let expressChild: ChildProcess | undefined;
  let expressBase = "";
  let expressDb: pg.Pool;

  beforeAll(async () => {
    const port = 8794;
    expressBase = `http://127.0.0.1:${port}`;
    expressDb = new pg.Pool({ connectionString: url });
    expressChild = spawn(path.join(packageRoot, "node_modules/.bin/tsx"), ["src/server.ts"], {
      cwd: packageRoot,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: url,
        CHARGING_MODE: "enforce",
        PROCURER_URL: await startFulfilmentStub(),
        EXPRESS_ENABLED: "true",
        EXPRESS_JOB_TYPES: "market_snapshot",
        EXPRESS_PRICE_UNITS: "500000",
        FIRM_PAYTO_ADDRESS: "0xfirmtestpayto",
        FIRM_CHARGE_ASSET: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
        FIRM_CHARGE_NETWORK: "eip155:196"
      },
      stdio: "ignore"
    });
    await waitForHealth(expressBase);
  }, 40_000);

  afterAll(async () => {
    expressChild?.kill();
    await expressDb?.end();
  });

  async function callExpress(tool: string, args: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(expressBase, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ tool, args })
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }

  it("charges the fixed Express price for an unpaid enabled call, and writes no job", async () => {
    const before = await expressDb.query("SELECT count(*)::int AS n FROM firm_jobs WHERE goal LIKE 'Firm Express%'");
    const attempt = await callExpress("express_run", { job_type: "market_snapshot", params: {} });

    expect(attempt.status).toBe(402);
    expect(attempt.body.error.code).toBe("PAYMENT_REQUIRED");
    const header = attempt.headers.get("payment-required");
    const requirements = JSON.parse(Buffer.from(header as string, "base64").toString("utf8"));
    expect(requirements.accepts[0].amount).toBe("500000");
    expect(requirements.accepts[0].asset).toBe("0x779ded0c9e1022225f8e0630b35a9b54be713736");
    expect(requirements.accepts[0].network).toBe("eip155:196");
    expect(requirements.accepts[0].outputSchema.input.body.required).toEqual([
      "symbol",
      "timeframe",
      "prompt"
    ]);

    const after = await expressDb.query("SELECT count(*)::int AS n FROM firm_jobs WHERE goal LIKE 'Firm Express%'");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("rejects an unknown job_type before charging", async () => {
    const { status, body } = await callExpress("express_run", { job_type: "not_a_type", params: {} });
    expect(status).toBe(200);
    expect(body.error.code).toBe("UNKNOWN_JOB_TYPE");
  });
});

/**
 * The settlement boundary, against a facilitator we control.
 *
 * The defect this pins: the gateway used to accept a payment on verification
 * alone. Verification only says the signature is valid — it broadcasts nothing.
 * A gateway that stops there hands over the goods while the buyer's
 * authorization quietly expires unredeemed, and answers with a PAYMENT-RESPONSE
 * claiming success.
 *
 * These tests fail if that regresses, because a facilitator that verifies and
 * then declines to settle must produce no job row.
 */
suite("gateway settlement boundary", () => {
  let settleChild: ChildProcess | undefined;
  let settleBase = "";
  let facilitator: http.Server;
  let settleDb: pg.Pool;
  /** Flipped per test to decide what /settle answers. */
  let settleBehaviour: "success" | "declined" | "no_transaction" | "no_payer" = "success";
  let paths: string[] = [];

  beforeAll(async () => {
    facilitator = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        // drain
      }
      paths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/verify") {
        res.end(JSON.stringify({ isValid: true, payer: "0xbuyer", amount: "500000" }));
        return;
      }
      if (settleBehaviour === "declined") {
        res.end(JSON.stringify({ success: false, errorReason: "authorization_expired" }));
        return;
      }
      if (settleBehaviour === "no_transaction") {
        res.end(JSON.stringify({ success: true, payer: "0xbuyer" }));
        return;
      }
      res.end(
        JSON.stringify({
          success: true,
          transaction: "0xsettledtx",
          payer: settleBehaviour === "no_payer" ? undefined : "0xbuyer",
          amount: "500000"
        })
      );
    });
    await new Promise<void>((resolve) => facilitator.listen(0, "127.0.0.1", resolve));
    const facilitatorPort = (facilitator.address() as AddressInfo).port;

    const port = 8795;
    settleBase = `http://127.0.0.1:${port}`;
    settleDb = new pg.Pool({ connectionString: url });
    settleChild = spawn(path.join(packageRoot, "node_modules/.bin/tsx"), ["src/server.ts"], {
      cwd: packageRoot,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: url,
        PRICING_MODE: "TIERS",
        CHARGING_MODE: "enforce",
        PROCURER_URL: await startFulfilmentStub(),
        FIRM_PAYTO_ADDRESS: "0xfirmtestpayto",
        FIRM_CHARGE_ASSET: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
        FIRM_CHARGE_NETWORK: "eip155:196",
        X402_FACILITATOR_URL: `http://127.0.0.1:${facilitatorPort}`,
        EXPRESS_ENABLED: "true",
        EXPRESS_JOB_TYPES: "market_snapshot",
        EXPRESS_PRICE_UNITS: "500000",
        EXPRESS_TIMEOUT_MS: "5000"
      },
      stdio: "ignore"
    });
    await waitForHealth(settleBase);
  }, 40_000);

  afterAll(async () => {
    settleChild?.kill();
    await new Promise((resolve) => facilitator.close(resolve));
    await settleDb?.end();
  });

  async function quoteThenExecute(goal: string) {
    const quoteResponse = await fetch(settleBase, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "get_quote",
        args: { goal, budget_cap: { amount: "5000000", decimals: 6, token: "USDT" }, constraints: {} }
      })
    });
    const quote = (await quoteResponse.json()) as any;
    paths = [];
    const response = await fetch(settleBase, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ authorization: "valid" })).toString("base64")
      },
      body: JSON.stringify({ tool: "execute", args: { quote_id: quote.quote_id } })
    });
    return { quoteId: quote.quote_id as string, status: response.status, headers: response.headers, body: await response.json() };
  }

  it("settles before creating the job, and reports the settlement transaction", async () => {
    settleBehaviour = "success";
    const result = await quoteThenExecute("settled market snapshot");

    expect(result.status).toBe(200);
    expect(result.body.task_id).toMatch(/^t_/);
    expect(paths).toEqual(["/verify", "/settle"]);

    const settlement = JSON.parse(
      Buffer.from(result.headers.get("payment-response") as string, "base64").toString("utf8")
    );
    expect(settlement.transaction).toBe("0xsettledtx");

    const rows = await settleDb.query("SELECT quote->>'buyer_address' AS buyer FROM firm_jobs WHERE quote_id = $1", [
      result.quoteId
    ]);
    expect(rows.rows[0].buyer).toBe("0xbuyer");
  });

  it("writes no job when the payment verifies but does not settle", async () => {
    settleBehaviour = "declined";
    const result = await quoteThenExecute("unsettled market snapshot");

    expect(result.status).toBe(402);
    expect(result.body.error.detail).toMatch(/did not settle/);
    expect(paths).toEqual(["/verify", "/settle"]);

    const rows = await settleDb.query("SELECT count(*)::int AS n FROM firm_jobs WHERE quote_id = $1", [result.quoteId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("writes no job when settlement reports success without a transaction", async () => {
    settleBehaviour = "no_transaction";
    const result = await quoteThenExecute("evidence-free market snapshot");

    expect(result.status).toBe(402);
    const rows = await settleDb.query("SELECT count(*)::int AS n FROM firm_jobs WHERE quote_id = $1", [result.quoteId]);
    expect(rows.rows[0].n).toBe(0);
  });

  async function waitForAuthorizedExpress() {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const rows = await settleDb.query(
        "SELECT task_id, state FROM firm_jobs WHERE goal = 'Firm Express: market_snapshot' ORDER BY created_at DESC LIMIT 1"
      );
      if (rows.rows[0]?.state === "authorized") return rows.rows[0].task_id as string;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Express task never reached authorized");
  }

  function paidExpress() {
    return fetch(settleBase, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ authorization: "valid" })).toString("base64")
      },
      body: JSON.stringify({
        symbol: "ETH",
        timeframe: "4h",
        prompt: "price action, trend, support and resistance"
      })
    });
  }

  async function markExpressValidated(taskId: string) {
    await settleDb.query(
      `UPDATE firm_jobs
       SET state = 'ready_to_settle',
           deliverable = $2::jsonb,
           provenance = $3::jsonb,
           updated_at = now()
       WHERE task_id = $1`,
      [
        taskId,
        JSON.stringify({ result: { symbol: "ETH", timeframe: "4h", price_action: "validated" } }),
        JSON.stringify({
          hires: [{
            agent_id: "2023",
            name: "Onchain Data Explorer",
            cost: { amount: "15", decimals: 6, token: "USDT" }
          }],
          economics: {
            actual_vendor_costs: { amount: "15", decimals: 6, token: "USDT" },
            margin_retained_or_absorbed: { amount: "99985", sign: "retained" }
          },
          books: { cost: { amount: "0", decimals: 6, token: "USDT" } },
          guarantee_status: "delivered"
        })
      ]
    );
  }

  it("settles Express only after a validated output is ready", async () => {
    settleBehaviour = "success";
    paths = [];
    const pending = paidExpress();
    const taskId = await waitForAuthorizedExpress();
    expect(paths).toEqual(["/verify"]);

    await markExpressValidated(taskId);
    const response = await pending;
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.deliverable.result.symbol).toBe("ETH");
    expect(body.receipt.vendor).toEqual({ agent_id: "2023", name: "Onchain Data Explorer" });
    expect(paths).toEqual(["/verify", "/settle"]);
    const row = await settleDb.query("SELECT state FROM firm_jobs WHERE task_id = $1", [taskId]);
    expect(row.rows[0].state).toBe("complete");
  });

  it("never settles a valid authorization for invalid Express inputs", async () => {
    settleBehaviour = "success";
    paths = [];
    const response = await fetch(settleBase, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ authorization: "valid" })).toString("base64")
      },
      body: JSON.stringify({ symbol: "ETH", timeframe: "4h" })
    });
    const body = await response.json() as any;
    expect(body.error.code).toBe("INVALID_ARGS");
    expect(paths).toEqual(["/verify"]);
  });

  it("hides the validated result and records not-charged when settlement fails", async () => {
    settleBehaviour = "declined";
    paths = [];
    const pending = paidExpress();
    const taskId = await waitForAuthorizedExpress();
    await markExpressValidated(taskId);

    const response = await pending;
    expect(response.status).toBe(402);
    const body = await response.json() as any;
    expect(body.error.code).toBe("PAYMENT_NOT_SETTLED");
    const row = await settleDb.query(
      `SELECT state, deliverable,
              provenance->>'guarantee_status' AS guarantee,
              provenance #>> '{economics,margin_retained_or_absorbed,amount}' AS margin_amount,
              provenance #>> '{economics,margin_retained_or_absorbed,sign}' AS margin_sign
       FROM firm_jobs WHERE task_id = $1`,
      [taskId]
    );
    expect(row.rows[0]).toMatchObject({
      state: "failed_not_charged",
      deliverable: null,
      guarantee: "not_charged",
      margin_amount: "15",
      margin_sign: "absorbed"
    });
  });
});
