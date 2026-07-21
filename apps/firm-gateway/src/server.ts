import http from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  buildRequirements,
  ChargingNotConfigured,
  encodeRequirements,
  encodeSettlement,
  paymentHeaderFrom,
  sellerConfigFromEnv,
  settlePayment,
  SettleResult,
  verifyPayment
} from "./charging.js";
import { ensureGatewayTables, pool } from "./db.js";
import { mcpDispatch } from "./mcp.js";
import { expressJobTypes, normaliseExpressArgs } from "./express-args.js";
import { fulfilmentFailure, readFulfilmentMode } from "./fulfilment.js";
import { quotePrice, estimatePlan, PricingMode } from "./pricing.js";
import { usdt, units } from "./money.js";

/**
 * Tools behind the payment boundary. Free tools (get_quote, get_status,
 * get_result) are deliberately not here — INTERFACES prices them at zero.
 */
const PAID_TOOLS = new Set(["execute", "express_run"]);

/**
 * `enforce` — a paid tool with no verified payment gets a 402 and nothing else.
 * `bypass`  — local development and the eval harness: paid tools run unpaid,
 *             and every response carries `charging: "BYPASSED"` so no output
 *             from a bypassed gateway can be mistaken for a paid run.
 *
 * The default is `bypass` only so the existing eval harness keeps working
 * without a cross-lane edit. Production must set CHARGING_MODE=enforce; the
 * startup banner and /health both say so when it is not set.
 */
function chargingMode(): "enforce" | "bypass" {
  return process.env.CHARGING_MODE === "enforce" ? "enforce" : "bypass";
}

const quoteRequest = z.object({
  goal: z.string().min(1),
  budget_cap: z.object({ amount: z.string(), decimals: z.number(), token: z.string().default("USDT") }),
  constraints: z.object({
    deadline_minutes: z.number().default(60),
    min_vendor_score: z.number().default(60),
    banned_categories: z.array(z.string()).default([])
  }).default({})
});

function pricingMode(): PricingMode {
  return process.env.PRICING_MODE === "QUOTED_AMOUNT" ? "QUOTED_AMOUNT" : "TIERS";
}

/**
 * Firm Express config.
 *
 * OFF by default and honestly so: INTERFACES §1A locks the Express job types
 * only after live vendor-reliability testing (PLAN D4), which is gated on the
 * human-triggered payment spike. Until a human sets EXPRESS_ENABLED and confirms
 * the pool, express_run returns a structured "not enabled" rather than charging
 * for a service whose reliability is unproven.
 */
function expressEnabled(): boolean {
  return process.env.EXPRESS_ENABLED === "true";
}
/** Fixed Express price in base units. INTERFACES §1A placeholder: 0.5 USDT. */
function expressPriceUnits(): string {
  return process.env.EXPRESS_PRICE_UNITS ?? "500000";
}
/** How long express_run waits for the synchronous result before returning PENDING. */
function expressTimeoutMs(): number {
  return Number(process.env.EXPRESS_TIMEOUT_MS ?? 60_000);
}
/** job_type -> vendor capability. Only the locked job types appear here. */
const EXPRESS_CAPABILITY: Record<string, string> = { market_snapshot: "market_snapshot" };

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type StoredQuote = { goal: string; quote: Record<string, any>; constraints?: Record<string, any> };

/**
 * Read a live quote. Reads are allowed before payment — we cannot build a 402
 * challenge without knowing the quoted price. It is *writes* that are gated.
 *
 * Constraints ride alongside: the buyer set them at get_quote time (min vendor
 * score, banned categories, deadline) and the worker must honour them when it
 * sources vendors. They are carried on the stored quote blob at execute time,
 * not in a new firm_jobs column, so no schema migration is needed.
 */
async function loadQuote(quoteId: string): Promise<StoredQuote | undefined> {
  const result = await pool().query(
    "SELECT goal, quote, constraints FROM firm_quotes WHERE quote_id = $1 AND valid_until > now()",
    [quoteId]
  );
  return result.rows[0];
}

async function toolCall(name: string, args: any, preloadedQuote?: StoredQuote, buyerAddress?: string) {
  if (name === "get_quote") {
    const request = quoteRequest.parse(args);
    const plan = estimatePlan(request.goal);
    const estimates = plan.map((item) =>
      item.capability === "market_snapshot" ? usdt(100_000) : usdt(300_000)
    );
    const price = quotePrice(estimates, pricingMode());
    if (units(price) > units(request.budget_cap)) {
      return { error: { code: "CANNOT_QUOTE_WITHIN_BUDGET", minimum_viable: price } };
    }
    const quote = {
      quote_id: `q_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      price,
      plan_summary: plan,
      valid_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      guarantee: "full refund if not delivered",
      quoted_at: new Date().toISOString(),
      pricing_mode: pricingMode()
    };
    await pool().query(
      `INSERT INTO firm_quotes (quote_id, goal, quote, budget_cap, constraints, valid_until)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)`,
      [
        quote.quote_id,
        request.goal,
        JSON.stringify(quote),
        JSON.stringify(request.budget_cap),
        JSON.stringify(request.constraints),
        quote.valid_until
      ]
    );
    return quote;
  }

  if (name === "execute") {
    const quoteId = z.object({ quote_id: z.string() }).parse(args).quote_id;
    // Prefer the quote the payment was verified against. Re-reading here would
    // reopen a window where a quote that expires between the charge and the
    // insert leaves the caller charged and with no task.
    const stored = preloadedQuote ?? (await loadQuote(quoteId));
    if (!stored) return { error: { code: "QUOTE_NOT_FOUND" } };
    const taskId = `t_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    // Carry the buyer's constraints onto the job's quote blob so the worker
    // sources under them. A quote loaded via the charge gate may not carry the
    // constraints column, so fall back to the quote's own embedded copy.
    //
    // buyer_address is the facilitator-verified payer, captured here so the
    // refund path pays back the actual buyer rather than a placeholder. It is
    // only present in enforce mode with a real settlement; a bypassed run has
    // no real payer and refunds fall back to the configured default.
    const jobQuote = {
      ...stored.quote,
      constraints: stored.constraints ?? stored.quote.constraints,
      buyer_address: buyerAddress ?? stored.quote.buyer_address
    };
    await pool().query(
      `INSERT INTO firm_jobs
       (task_id, quote_id, state, goal, quote, progress, deliverable, provenance, refund)
       VALUES ($1, $2, 'paid', $3, $4::jsonb, '[]'::jsonb, NULL, NULL, NULL)`,
      [taskId, quoteId, stored.goal, JSON.stringify(jobQuote)]
    );
    return { task_id: taskId, state: "planning" };
  }

  if (name === "get_status") {
    const taskId = z.object({ task_id: z.string() }).parse(args).task_id;
    const result = await pool().query("SELECT state, progress FROM firm_jobs WHERE task_id = $1", [taskId]);
    return result.rows[0] ?? { error: { code: "NOT_FOUND" } };
  }

  if (name === "get_result") {
    const taskId = z.object({ task_id: z.string() }).parse(args).task_id;
    const result = await pool().query(
      `SELECT state, deliverable, provenance, refund FROM firm_jobs
       WHERE task_id = $1`,
      [taskId]
    );
    const row = result.rows[0];
    if (!row) return { error: { code: "NOT_FOUND" } };
    if (row.state === "failed_refunded" && row.provenance) {
      return { error: { code: "REFUNDED", refund: row.refund, provenance: row.provenance } };
    }
    if (row.state === "complete" && row.deliverable && row.provenance) {
      return { deliverable: row.deliverable, provenance: row.provenance };
    }
    return { error: { code: "NOT_READY_OR_NOT_FOUND" } };
  }

  if (name === "express_run") {
    const normalised = normaliseExpressArgs(args);
    if (!normalised) return { error: { code: "INVALID_ARGS", detail: "job_type is required" } };
    const capability = EXPRESS_CAPABILITY[normalised.job_type];
    if (!capability) return { error: { code: "UNKNOWN_JOB_TYPE", detail: normalised.job_type } };
    const parsed = { data: normalised };

    // Express is a fixed-price single-capability job. Insert it paid and drive
    // it to completion synchronously (INTERFACES §1A returns the deliverable
    // inline), reusing the same worker, sourcing, and refund machinery.
    const taskId = `t_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const price = { amount: expressPriceUnits(), decimals: 6, token: "USDT" };
    const jobQuote = {
      quote_id: `qx_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      price,
      plan_summary: [{ subtask: parsed.data.job_type, capability }],
      // The worker's Quote model requires valid_until; Express is executed
      // immediately, so a short window is enough.
      valid_until: new Date(Date.now() + expressTimeoutMs() + 60_000).toISOString(),
      quoted_at: new Date().toISOString(),
      pricing_mode: "QUOTED_AMOUNT",
      express: true,
      buyer_address: buyerAddress
    };
    // params reach the vendor verbatim. INTERFACES §1A defines express_run as
    // taking them, and real vendors have real schemas — OKLink requires
    // chainIndex/address/height. Parsing them and dropping them, as this did,
    // meant the worker sent a generic body and The Firm paid for the 400.
    await pool().query(
      `INSERT INTO firm_jobs
       (task_id, quote_id, state, goal, quote, params, progress, deliverable, provenance, refund)
       VALUES ($1, $2, 'paid', $3, $4::jsonb, $5::jsonb, '[]'::jsonb, NULL, NULL, NULL)`,
      [
        taskId,
        jobQuote.quote_id,
        `Firm Express: ${parsed.data.job_type}`,
        JSON.stringify(jobQuote),
        JSON.stringify(parsed.data.params ?? {})
      ]
    );

    // A worker (firm-worker run) processes the paid job; poll for the terminal
    // state and shape the Express receipt from the provenance.
    const deadline = Date.now() + expressTimeoutMs();
    while (Date.now() < deadline) {
      const result = await pool().query(
        "SELECT state, deliverable, provenance, refund FROM firm_jobs WHERE task_id = $1",
        [taskId]
      );
      const row: any = result.rows[0];
      if (row?.state === "complete" && row.provenance) {
        const prov = row.provenance;
        const hire = Array.isArray(prov.hires) && prov.hires.length ? prov.hires[prov.hires.length - 1] : undefined;
        return {
          deliverable: row.deliverable,
          receipt: {
            vendor: { agent_id: hire?.agent_id, name: hire?.name ?? null },
            vendor_cost: hire?.cost,
            vendor_tx: hire?.tx,
            validation: hire?.validation,
            firm_margin: prov.economics?.margin_retained_or_absorbed
          }
        };
      }
      if (row?.state === "failed_refunded") {
        return { error: { code: "DELIVERY_FAILED_REFUNDED", refund_tx: row.refund?.tx ?? null } };
      }
      await sleep(250);
    }
    // Charged but not finished in time: hand back the task_id so the caller can
    // pull the result rather than losing the run.
    return { error: { code: "EXPRESS_PENDING", task_id: taskId, detail: "not complete within timeout; poll get_result" } };
  }

  return { error: { code: "UNKNOWN_TOOL" } };
}

/**
 * What this call costs, or an error to return instead of charging.
 *
 * express_run deliberately has no price: its vendor pool is still a
 * placeholder, and charging for a placeholder would be taking money for
 * nothing. It returns its TODO error before the payment gate, never after.
 */
async function chargeFor(name: string, args: any) {
  if (name !== "execute") {
    return { error: { code: "NOT_CHARGEABLE_YET", detail: `${name} has no verified price` } };
  }
  const parsed = z.object({ quote_id: z.string() }).safeParse(args);
  if (!parsed.success) return { error: { code: "INVALID_ARGS", detail: "quote_id is required" } };

  const stored = await loadQuote(parsed.data.quote_id);
  if (!stored) return { error: { code: "QUOTE_NOT_FOUND" } };

  const price = stored.quote?.price;
  if (!price || typeof price.amount !== "string") {
    return { error: { code: "QUOTE_HAS_NO_PRICE" } };
  }
  return { price, quoteId: parsed.data.quote_id, quote: stored };
}

/**
 * The payment boundary. Returns null to let the call through, or a response to
 * send instead. Nothing in here writes to the database, and it runs before
 * toolCall, so an unpaid caller cannot cause a write.
 *
 * Unpaid attempts are rejected before every DB write and recorded only on
 * stderr. Persisting them would hand an unauthenticated caller a write
 * primitive, which is a worse trade than losing the audit row — and the
 * facilitator has its own record of failed verifications.
 */
async function chargeGate(
  name: string,
  args: any,
  headers: Record<string, string | string[] | undefined>
): Promise<
  | { status: number; body: unknown; headers?: Record<string, string> }
  | { settled: SettleResult | null; quote?: StoredQuote }
> {
  if (!PAID_TOOLS.has(name)) return { settled: null };

  if (name === "express_run") {
    const normalised = normaliseExpressArgs(args);
    if (!normalised) return { status: 200, body: { error: { code: "INVALID_ARGS", detail: "job_type is required" } } };
    const parsed = { data: normalised };
    // Honest, free rejection until a human locks the pool (no charge, no write).
    if (!expressEnabled()) {
      return {
        status: 200,
        body: {
          error: {
            code: "EXPRESS_NOT_ENABLED",
            detail:
              "Firm Express is not live yet; its vendor pool locks after reliability testing (PLAN D4). Use get_quote + execute (Firm Projects) meanwhile."
          }
        }
      };
    }
    if (!expressJobTypes().includes(parsed.data.job_type) || !EXPRESS_CAPABILITY[parsed.data.job_type]) {
      return {
        status: 200,
        body: {
          error: {
            code: "UNKNOWN_JOB_TYPE",
            detail: `job_type '${parsed.data.job_type}' is not offered; available: ${expressJobTypes().join(", ")}`
          }
        }
      };
    }
    if (chargingMode() === "bypass") {
      console.warn(`[charging] BYPASS: serving express_run without payment (CHARGING_MODE is not "enforce")`);
      return { settled: null };
    }
    const charged = await sellerCharge({
      name,
      amount: expressPriceUnits(),
      decimals: 6,
      resource: `firm:express:${parsed.data.job_type}`,
      headers
    });
    return "status" in charged ? charged : { settled: charged.verified };
  }

  const charge = await chargeFor(name, args);
  if ("error" in charge) return { status: 200, body: charge };

  if (chargingMode() === "bypass") {
    console.warn(`[charging] BYPASS: serving paid tool "${name}" without payment (CHARGING_MODE is not "enforce")`);
    return { settled: null, quote: charge.quote };
  }

  const charged = await sellerCharge({
    name,
    amount: charge.price.amount,
    decimals: Number(charge.price.decimals ?? 6),
    resource: `firm:${name}:${charge.quoteId}`,
    headers
  });
  return "status" in charged ? charged : { settled: charged.verified, quote: charge.quote };
}

/**
 * Build the 402 challenge for a fixed amount and verify the buyer's payment.
 * Shared by execute (quoted price) and express_run (fixed price). Fails closed:
 * an unconfigured seller returns 503, an unverified payment returns 402.
 */
async function sellerCharge(opts: {
  name: string;
  amount: string;
  decimals: number;
  resource: string;
  headers: Record<string, string | string[] | undefined>;
}): Promise<{ status: number; body: unknown; headers?: Record<string, string> } | { verified: SettleResult }> {
  let seller;
  try {
    seller = sellerConfigFromEnv();
  } catch (error) {
    if (error instanceof ChargingNotConfigured) {
      return { status: 503, body: { error: { code: "CHARGING_NOT_CONFIGURED", detail: error.message } } };
    }
    throw error;
  }

  const requirements = buildRequirements({
    amount: opts.amount,
    decimals: opts.decimals,
    asset: seller.asset,
    network: seller.network,
    payTo: seller.payTo,
    resource: opts.resource,
    description: `The Firm — ${opts.name}`
  });

  const header = paymentHeaderFrom(opts.headers);
  const requirePayment = (reason: string) => {
    console.warn(`[charging] rejected unpaid ${opts.name}: ${reason}`);
    return {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodeRequirements(requirements) },
      body: { error: { code: "PAYMENT_REQUIRED", detail: reason }, ...requirements }
    };
  };

  const verification = await verifyPayment(header, requirements, { facilitatorUrl: seller.facilitatorUrl });
  if (!verification.ok) return requirePayment(verification.reason);

  // Verification proves the signature. Settlement is what redeems it, and it
  // runs before a single vendor is hired, because hiring spends the Firm's own
  // money — see the comment on settlePayment.
  const settlement = await settlePayment(header, requirements, { facilitatorUrl: seller.facilitatorUrl });
  if (!settlement.ok) return requirePayment(`payment verified but did not settle: ${settlement.reason}`);

  // We are now holding the buyer's money, so we must know where to send it back
  // if we fail to deliver. Neither step reporting a payer means we cannot honour
  // the refund guarantee, and the fallback is a placeholder address — i.e. a
  // stranger. Refusing the job is the only honest option left.
  const payer = settlement.payer ?? verification.payer;
  if (!payer) {
    return requirePayment("settled without a payer address; refusing a job we could not refund");
  }

  return { verified: { ...settlement, payer } };
}

await ensureGatewayTables();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      send(res, 200, {
        ok: true,
        service: "firm-gateway",
        charging_mode: chargingMode(),
        pricing_mode: pricingMode()
      });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
      return;
    }
    const body = await readJson(req);
    const dispatch = mcpDispatch(body);

    if (dispatch.kind === "notification") {
      res.writeHead(202);
      res.end();
      return;
    }
    if (dispatch.kind === "error") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error: { code: dispatch.code, message: dispatch.message } }));
      return;
    }
    if (dispatch.kind === "protocol") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body.id !== undefined ? { jsonrpc: "2.0", id: body.id, result: dispatch.result } : dispatch.result));
      return;
    }

    const method = dispatch.name;
    const args = dispatch.args;

    const gate = await chargeGate(method, args, req.headers);
    if ("status" in gate) {
      res.writeHead(gate.status, { "content-type": "application/json", ...(gate.headers ?? {}) });
      res.end(JSON.stringify(body.id ? { jsonrpc: "2.0", id: body.id, result: gate.body } : gate.body));
      return;
    }

    const result = await toolCall(method, args, gate.quote, gate.settled?.ok ? gate.settled.payer : undefined);
    const payload: Record<string, unknown> =
      PAID_TOOLS.has(method) && chargingMode() === "bypass" && result && typeof result === "object"
        ? { ...result, charging: "BYPASSED" }
        : (result as Record<string, unknown>);

    const responseHeaders: Record<string, string> = { "content-type": "application/json" };
    if (gate.settled?.ok) responseHeaders["PAYMENT-RESPONSE"] = encodeSettlement(gate.settled);
    res.writeHead(200, responseHeaders);
    res.end(JSON.stringify(body.id ? { jsonrpc: "2.0", id: body.id, result: payload } : payload));
  } catch (error) {
    send(res, 500, { error: { code: "GATEWAY_ERROR", detail: String(error) } });
  }
});

/**
 * Bind address. Defaults to loopback, which is the safe default for a laptop
 * and the wrong one for a container: `docker run -p 8790:8790` publishes the
 * host port to the container's external interface, so a process listening only
 * on the container's loopback answers nothing. That is exactly the symptom OKX
 * reported when they rejected Treasury — "unable to reach your Agent's service
 * endpoint" — so it has to be settable. The Dockerfile sets HOST=0.0.0.0.
 */
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8790);
const isPublicBind = host === "0.0.0.0" || host === "::";

// A publicly-reachable gateway in bypass mode does unlimited paid work for
// free, hiring real vendors with the Firm's own wallet on every request. That
// is a money-loss bug wearing a config-mistake costume, so it is refused rather
// than warned about. ALLOW_PUBLIC_BYPASS exists for deliberate staging runs.
if (isPublicBind && chargingMode() === "bypass" && process.env.ALLOW_PUBLIC_BYPASS !== "true") {
  console.error(
    `[charging] refusing to bind ${host}: CHARGING_MODE is "bypass", so every paid tool would run ` +
      "unpaid while still spending real money on vendors. Set CHARGING_MODE=enforce, or " +
      "ALLOW_PUBLIC_BYPASS=true if you genuinely mean to serve free work."
  );
  process.exit(1);
}

// Never charge real money for simulated work. The gateway and the procurer have
// independent money switches and one pairing is incoherent — see fulfilment.ts.
// Checked at boot rather than per request: a per-request check would fail the
// buyer only after their money had already moved.
if (chargingMode() === "enforce") {
  const procurerUrl = process.env.PROCURER_URL;
  if (!procurerUrl) {
    console.warn(
      "[fulfilment] PROCURER_URL is not set, so the gateway cannot confirm that paid jobs are " +
        "fulfilled for real. Set it in production."
    );
  } else {
    const mode = await readFulfilmentMode(procurerUrl);
    const failure = fulfilmentFailure({ charging: true, mode });
    if (failure) {
      console.error(`[fulfilment] refusing to start: ${failure}`);
      process.exit(1);
    }
    console.log("[fulfilment] procurer confirmed live: real payments on, wallet key present");
  }
}

server.listen(port, host, () => {
  console.log(`firm-gateway listening on http://${host}:${port}`);
  if (chargingMode() === "bypass") {
    console.warn(
      "[charging] CHARGING_MODE is not \"enforce\": paid tools will run WITHOUT payment. " +
        "This is for local development and evals only — production must set CHARGING_MODE=enforce."
    );
  }
});
