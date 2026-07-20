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

import { spawn, ChildProcess } from "node:child_process";
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
        FIRM_PAYTO_ADDRESS: "0xfirmtestpayto",
        FIRM_CHARGE_ASSET: "0xassettest",
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

  it("returns express_run's placeholder without charging for it", async () => {
    const { status, body } = await callTool("express_run", { job_type: "market_snapshot", params: {} });
    expect(status).toBe(200);
    expect(body.error.code).toBe("TODO_UNVERIFIED_EXPRESS_VENDOR_POOL");
  });

  it("does not gate the read-only tools", async () => {
    const { status, body } = await callTool("get_status", { task_id: "t_does_not_exist" });
    expect(status).toBe(200);
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
