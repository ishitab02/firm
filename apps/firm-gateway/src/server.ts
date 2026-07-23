import http from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  buildRequirements,
  ChargingNotConfigured,
  encodeRequirements,
  encodeSettlement,
  paymentHeaderFrom,
  PaymentRequirements,
  sellerConfigFromEnv,
  settlePayment,
  SettleResult,
  verifyPayment
} from "./charging.js";
import { ensureGatewayTables, pool } from "./db.js";
import { mcpDispatch, TOOL_DEFINITIONS } from "./mcp.js";
import {
  EXPRESS_HTTP_INPUT,
  expressInputFailure,
  expressJobTypes,
  normaliseExpressArgs
} from "./express-args.js";
import {
  coerceProjectArgs,
  directHttpToolCall,
  PROJECT_EXECUTE_HTTP_INPUT,
  PROJECT_RUN_HTTP_INPUT,
  PROJECT_RUN_HTTP_OUTPUT,
  projectSpecFromGoal
} from "./project-args.js";
import { fulfilmentFailure, readFulfilmentMode } from "./fulfilment.js";
import { quotePrice, PricingMode } from "./pricing.js";
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
  budget_cap: z.object({
    amount: z.string().regex(/^\d+$/),
    decimals: z.literal(6),
    token: z.literal("USDT").default("USDT")
  }),
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
 * OFF by default so a new environment must explicitly opt into the paid API
 * after verifying its database, worker, paid OKLink procurement, and facilitator.
 */
function expressEnabled(): boolean {
  return process.env.EXPRESS_ENABLED === "true";
}
/** Fixed Express price in base units. The live listing is 0.1 USDT. */
function expressPriceUnits(): string {
  return process.env.EXPRESS_PRICE_UNITS ?? "100000";
}
/** How long express_run waits for the synchronous result before returning PENDING. */
function expressTimeoutMs(): number {
  return Number(process.env.EXPRESS_TIMEOUT_MS ?? 60_000);
}
/** How long a direct Projects purchase waits for an inline terminal result. */
function projectsTimeoutMs(): number {
  const configured = Number(process.env.PROJECTS_TIMEOUT_MS ?? 90_000);
  return Number.isFinite(configured) && configured >= 0 ? Math.min(configured, 110_000) : 90_000;
}
/** job_type -> vendor capability. Only the locked job types appear here. */
const EXPRESS_CAPABILITY: Record<string, string> = { market_snapshot: "market_snapshot" };

/** Returned instead of throwing when a body will not parse. */
export const MALFORMED_BODY = Symbol("malformed-body");

/**
 * Read a request body, normalising everything that is not a JSON object.
 *
 * JSON has six top-level shapes and only one of them can carry a tool call.
 * The other five used to reach the router: `null` threw on `body.id` and Fly
 * reported 502, arrays and bare strings fell through to HTTP 200 UNKNOWN_TOOL,
 * and unparseable input surfaced as a 500 with the raw SyntaxError echoed to
 * the caller.
 *
 * All of that is the same defect the marketplace review already rejected this
 * endpoint for: a paid resource answering an unpaid request with something
 * other than 402. Non-objects normalise to `{}`, which routes to the single
 * paid product and gets a price like any other unpaid call. Unparseable bodies
 * are a client error and say so, without quoting the parser.
 */
async function readJson(req: http.IncomingMessage): Promise<any | typeof MALFORMED_BODY> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return MALFORMED_BODY;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type StoredQuote = { goal: string; quote: Record<string, any>; constraints?: Record<string, any> };

type PreparedProject = {
  request: z.infer<typeof quoteRequest>;
  price: ReturnType<typeof usdt>;
  plan: Array<{ subtask: string; capability: "market_snapshot"; max_amount: null }>;
  projectRequests: Array<Record<string, unknown>>;
  mode: PricingMode;
};

type DeferredCharge = {
  header: string;
  requirements: PaymentRequirements;
  payer: string;
  facilitatorUrl: string;
};

function expressFailureDetail(row: any): string {
  const rejections = row?.provenance?.vendors_rejected;
  if (Array.isArray(rejections)) {
    const reason = [...rejections]
      .reverse()
      .find((entry) => entry && typeof entry.reason === "string" && entry.reason.trim());
    if (reason) return reason.reason;
  }
  if (Array.isArray(row?.progress)) {
    const note = [...row.progress]
      .reverse()
      .find(
        (entry) =>
          entry &&
          typeof entry.note === "string" &&
          !/^(fulfilment failed|generated disclosed books receipt|all candidates exhausted)/i.test(entry.note)
      );
    if (note) return note.note;
  }
  return "upstream fulfilment failed before settlement; buyer was not charged";
}

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

function prepareProject(
  args: unknown,
  mode: PricingMode = pricingMode()
): PreparedProject | { error: Record<string, unknown> } {
  // The OKX payment CLI can only send flat string params, so a buyer's
  // `--param budget_cap={...}` arrives as a JSON string, not an object. Coerce
  // it back before validation; a direct JSON POST is unaffected. See
  // coerceProjectArgs.
  const parsed = quoteRequest.safeParse(coerceProjectArgs(args));
  if (!parsed.success) {
    return {
      error: {
        code: "INVALID_ARGS",
        detail: "goal and a base-unit, 6-decimal USDT budget_cap are required"
      }
    };
  }
  const project = projectSpecFromGoal(parsed.data.goal);
  if (!project.ok) {
    return { error: { code: "UNSUPPORTED_PROJECT_GOAL", detail: project.detail } };
  }
  const price = quotePrice(project.spec.plan.map(() => usdt(100_000)), mode);
  if (units(price) > units(parsed.data.budget_cap)) {
    return { error: { code: "CANNOT_QUOTE_WITHIN_BUDGET", minimum_viable: price } };
  }
  return {
    request: parsed.data,
    price,
    plan: project.spec.plan,
    projectRequests: project.spec.requests,
    mode
  };
}

async function persistProjectQuote(prepared: PreparedProject) {
  const quote = {
    quote_id: `q_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    price: prepared.price,
    plan_summary: prepared.plan,
    valid_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    guarantee: "full refund if not delivered",
    quoted_at: new Date().toISOString(),
    pricing_mode: prepared.mode,
    project_requests: prepared.projectRequests
  };
  await pool().query(
    `INSERT INTO firm_quotes (quote_id, goal, quote, budget_cap, constraints, valid_until)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)`,
    [
      quote.quote_id,
      prepared.request.goal,
      JSON.stringify(quote),
      JSON.stringify(prepared.request.budget_cap),
      JSON.stringify(prepared.request.constraints),
      quote.valid_until
    ]
  );
  return quote;
}

async function toolCall(
  name: string,
  args: any,
  preloadedQuote?: StoredQuote,
  buyerAddress?: string,
  initialState: "paid" | "authorized" | "awaiting_settlement" = "paid"
) {
  if (name === "get_quote") {
    const prepared = prepareProject(args);
    if ("error" in prepared) return prepared;
    return persistProjectQuote(prepared);
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
    const projectRequests = Array.isArray(stored.quote.project_requests) ? stored.quote.project_requests : [];
    await pool().query(
      `INSERT INTO firm_jobs
       (task_id, quote_id, state, goal, quote, params, progress, deliverable, provenance, refund)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, '[]'::jsonb, NULL, NULL, NULL)`,
      [
        taskId,
        quoteId,
        initialState,
        stored.goal,
        JSON.stringify(jobQuote),
        JSON.stringify({ project_requests: projectRequests })
      ]
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
    if (row.state === "failed_not_charged") {
      return {
        error: {
          code: "FAILED_NOT_CHARGED",
          detail: "fulfilment or settlement failed before buyer funds moved",
          provenance: row.provenance
        }
      };
    }
    if (row.state === "complete" && row.deliverable && row.provenance) {
      return { deliverable: row.deliverable, provenance: row.provenance };
    }
    return { error: { code: "NOT_READY_OR_NOT_FOUND" } };
  }

  if (name === "express_run") {
    const normalised = normaliseExpressArgs(args);
    if (!normalised) return { error: { code: "INVALID_ARGS", detail: "job_type is required" } };
    const inputFailure = expressInputFailure(normalised);
    if (inputFailure) return { error: { code: "INVALID_ARGS", detail: inputFailure } };
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
    // Persist the buyer's contract verbatim. The worker validates it, then maps
    // it to OKLink's documented chainIndex/tokenAddress/granularity schema.
    await pool().query(
      `INSERT INTO firm_jobs
       (task_id, quote_id, state, goal, quote, params, progress, deliverable, provenance, refund)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, '[]'::jsonb, NULL, NULL, NULL)`,
      [
        taskId,
        jobQuote.quote_id,
        initialState,
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
        "SELECT state, deliverable, provenance, refund, progress FROM firm_jobs WHERE task_id = $1",
        [taskId]
      );
      const row: any = result.rows[0];
      if ((row?.state === "ready_to_settle" || row?.state === "complete") && row.provenance) {
        const prov = row.provenance;
        const hire = Array.isArray(prov.hires) && prov.hires.length ? prov.hires[prov.hires.length - 1] : undefined;
        return {
          deliverable: row.deliverable,
          receipt: {
            vendor: hire ? { agent_id: hire.agent_id, name: hire.name ?? null } : null,
            data_source: Array.isArray(prov.data_sources) ? (prov.data_sources[0] ?? null) : null,
            vendor_cost: hire?.cost ?? { amount: "0", decimals: 6, token: "USDT" },
            vendor_tx: hire?.tx ?? null,
            validation: hire?.validation ?? {
              passed: true,
              checks: ["request_contract", "asset_match", "timeframe_match", "prompt_match", "content_contract", "topic_match"]
            },
            firm_margin: prov.economics?.margin_retained_or_absorbed
          },
          _settlement_task_id: taskId
        };
      }
      if (row?.state === "failed_refunded") {
        return { error: { code: "DELIVERY_FAILED_REFUNDED", refund_tx: row.refund?.tx ?? null } };
      }
      if (row?.state === "failed_not_charged") {
        const detail = expressFailureDetail(row);
        console.error(
          `[alert] express_fulfilment_failed ${JSON.stringify({
            task_id: taskId,
            symbol: parsed.data.params?.symbol ?? null,
            timeframe: parsed.data.params?.timeframe ?? null,
            state: row.state,
            detail,
            buyer_charged: false,
            retriable: true
          })}`
        );
        return {
          error: {
            code: "DELIVERY_FAILED_NOT_CHARGED",
            detail,
            retriable: true,
            task_id: taskId
          }
        };
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
 * Projects prices come from stored quotes. Express uses its separately pinned
 * fixed price in chargeGate and therefore never reaches this helper.
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
  | { settled: SettleResult | null; quote?: StoredQuote; deferred?: DeferredCharge }
> {
  if (!PAID_TOOLS.has(name)) return { settled: null };

  if (name === "express_run") {
    const normalised = normaliseExpressArgs(args);
    if (!normalised) return { status: 200, body: { error: { code: "INVALID_ARGS", detail: "job_type is required" } } };
    const parsed = { data: normalised };
    // Honest, free rejection until this environment enables the full path.
    if (!expressEnabled()) {
      return {
        status: 200,
        body: {
          error: {
            code: "EXPRESS_NOT_ENABLED",
            detail:
              "Firm Express is disabled in this environment; enable it only after the worker, paid OKLink source, and x402 facilitator pass their readiness checks."
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
    const charged = await sellerAuthorize({
      name,
      amount: expressPriceUnits(),
      decimals: 6,
      resource: `firm:express:${parsed.data.job_type}`,
      headers
    });
    return "status" in charged ? charged : { settled: null, deferred: charged.authorized };
  }

  const charge = await chargeFor(name, args);
  if ("error" in charge) return { status: 200, body: charge };

  if (chargingMode() === "bypass") {
    console.warn(`[charging] BYPASS: serving paid tool "${name}" without payment (CHARGING_MODE is not "enforce")`);
    return { settled: null, quote: charge.quote };
  }

  // Refund readiness is an operational fact, not a boot-time constant. Gas can
  // be spent after startup, so re-check immediately before settling a Projects
  // payment. A non-ready backend yields a free 503, never a charged job whose
  // advertised guarantee is already impossible.
  const procurerUrl = process.env.PROCURER_URL;
  const liveMode = procurerUrl ? await readFulfilmentMode(procurerUrl) : null;
  const readinessFailure = fulfilmentFailure({ charging: true, mode: liveMode });
  if (readinessFailure) {
    return {
      status: 503,
      body: { error: { code: "FULFILMENT_NOT_READY", detail: readinessFailure } }
    };
  }

  const charged = await sellerCharge({
    name,
    amount: charge.price.amount,
    decimals: Number(charge.price.decimals ?? 6),
    resource: `firm:${name}:${charge.quoteId}`,
    headers,
    inputSchema: PROJECT_EXECUTE_HTTP_INPUT
  });
  return "status" in charged ? charged : { settled: charged.verified, quote: charge.quote };
}

/**
 * Build the Projects 402 challenge, verify, and settle before vendor spend.
 * Express uses sellerAuthorize below because its zero-cost fulfilment can be
 * validated before settlement. Both paths fail closed.
 */
async function sellerCharge(opts: {
  name: string;
  amount: string;
  decimals: number;
  resource: string;
  headers: Record<string, string | string[] | undefined>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
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
    description: `The Firm — ${opts.name}`,
    resourceUrl: seller.resourceUrl,
    inputSchema: opts.inputSchema,
    outputSchema: opts.outputSchema
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

/** Verify an authorization without redeeming it. */
async function sellerAuthorize(opts: {
  name: string;
  amount: string;
  decimals: number;
  resource: string;
  headers: Record<string, string | string[] | undefined>;
  resourcePath?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}): Promise<
  { status: number; body: unknown; headers?: Record<string, string> }
  | { authorized: DeferredCharge }
> {
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
    description: `The Firm — ${opts.name}`,
    resourceUrl:
      opts.resourcePath && seller.resourceUrl
        ? new URL(opts.resourcePath, seller.resourceUrl).toString()
        : seller.resourceUrl,
    inputSchema: opts.inputSchema ?? EXPRESS_HTTP_INPUT,
    outputSchema: opts.outputSchema
  });
  const header = paymentHeaderFrom(opts.headers);
  const requirePayment = (reason: string) => ({
    status: 402,
    headers: { "PAYMENT-REQUIRED": encodeRequirements(requirements) },
    body: { error: { code: "PAYMENT_REQUIRED", detail: reason }, ...requirements }
  });
  const verification = await verifyPayment(header, requirements, { facilitatorUrl: seller.facilitatorUrl });
  if (!verification.ok) return requirePayment(verification.reason);
  if (!header) return requirePayment("verified request did not carry a payment header");
  if (!verification.payer) {
    return requirePayment("authorization has no payer address; refusing work whose settlement cannot be attributed");
  }
  if (!seller.facilitatorUrl) return requirePayment("X402_FACILITATOR_URL is not configured");
  return {
    authorized: {
      header,
      requirements,
      payer: verification.payer,
      facilitatorUrl: seller.facilitatorUrl
    }
  };
}

async function projectsReadinessFailure(): Promise<string | null> {
  const procurerUrl = process.env.PROCURER_URL;
  const liveMode = procurerUrl ? await readFulfilmentMode(procurerUrl) : null;
  return fulfilmentFailure({ charging: true, mode: liveMode });
}

async function projectRunGate(
  args: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<
  | { status: number; body: unknown; headers?: Record<string, string> }
  | { prepared: PreparedProject; authorized: DeferredCharge | null }
> {
  // The direct listed service is the fixed 1-USDT tier. MCP get_quote keeps
  // supporting the configured pricing mode, but a public API listing cannot
  // advertise one price and challenge for another.
  // Challenge before parsing the business contract. Marketplace validators
  // probe paid endpoints with `{}`; returning INVALID_ARGS first makes a real
  // paid resource look non-x402. A valid authorization still settles only
  // after the free precondition check below succeeds.
  let authorized: DeferredCharge | null = null;
  if (chargingMode() === "enforce") {
    const readinessFailure = await projectsReadinessFailure();
    if (readinessFailure) {
      return {
        status: 503,
        body: { error: { code: "FULFILMENT_NOT_READY", detail: readinessFailure } }
      };
    }
    const charged = await sellerAuthorize({
      name: "Firm Projects",
      amount: "1000000",
      decimals: 6,
      resource: "firm:projects:v1",
      resourcePath: "/projects",
      inputSchema: PROJECT_RUN_HTTP_INPUT,
      outputSchema: PROJECT_RUN_HTTP_OUTPUT,
      headers
    });
    if ("status" in charged) return charged;
    authorized = charged.authorized;
  }

  const prepared = prepareProject(args, "TIERS");
  if ("error" in prepared) {
    const code = (prepared.error.code as string | undefined) ?? "INVALID_ARGS";
    return { status: code === "UNSUPPORTED_PROJECT_GOAL" ? 422 : 400, body: prepared };
  }
  return { prepared, authorized };
}

async function startDirectProject(prepared: PreparedProject, authorized: DeferredCharge | null) {
  // A verified authorization is enough authority to create the durable job,
  // but not to let the worker spend. The non-claimable intermediate state
  // closes the old settle-before-insert hole: settlement can only happen after
  // a job exists, and the worker only sees it after settlement succeeds.
  const quote = await persistProjectQuote(prepared);
  const stored: StoredQuote = {
    goal: prepared.request.goal,
    quote,
    constraints: prepared.request.constraints
  };
  const result = await toolCall(
    "execute",
    { quote_id: quote.quote_id },
    stored,
    authorized?.payer,
    authorized ? "awaiting_settlement" : "paid"
  );
  const taskId = result && typeof result === "object" && typeof result.task_id === "string" ? result.task_id : null;
  if (!taskId) throw new Error("Projects job was not durably created");

  let settlement: SettleResult | null = null;
  if (authorized) {
    settlement = await settlePayment(authorized.header, authorized.requirements, {
      facilitatorUrl: authorized.facilitatorUrl
    });
    if (!settlement.ok) {
      await pool().query(
        `UPDATE firm_jobs
         SET state = 'failed_not_charged', updated_at = now()
         WHERE task_id = $1 AND state = 'awaiting_settlement'`,
        [taskId]
      );
      return {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodeRequirements(authorized.requirements)
        },
        body: {
          error: {
            code: "PAYMENT_NOT_SETTLED",
            detail: `job was created but authorization did not settle; buyer was not charged: ${settlement.reason}`
          },
          ...authorized.requirements
        }
      };
    }
    await pool().query(
      "UPDATE firm_jobs SET state = 'paid', updated_at = now() WHERE task_id = $1 AND state = 'awaiting_settlement'",
      [taskId]
    );
  }

  const responseHeaders: Record<string, string> = { "content-type": "application/json" };
  if (settlement?.ok) responseHeaders["PAYMENT-RESPONSE"] = encodeSettlement(settlement);

  // Most two-to-four-leg Projects finish inside the challenge's 120-second
  // window. Return the purchased content inline when they do, because a generic
  // marketplace buyer should not need to understand our queue to receive what
  // it paid for. The stable result URL remains a free recovery path for a slow
  // job or a response lost in transit.
  const deadline = Date.now() + projectsTimeoutMs();
  let outcome: Record<string, unknown> = { state: "pending" };
  do {
    const rows = await pool().query(
      `SELECT state, deliverable, provenance, refund
       FROM firm_jobs WHERE task_id = $1`,
      [taskId]
    );
    const current = rows.rows[0];
    if (current?.state === "complete" && current.deliverable && current.provenance) {
      outcome = {
        state: "complete",
        deliverable: current.deliverable,
        provenance: current.provenance
      };
      break;
    }
    if (current?.state === "failed_refunded") {
      outcome = {
        state: "failed_refunded",
        error: {
          code: "DELIVERY_FAILED_REFUNDED",
          refund: current.refund,
          provenance: current.provenance
        }
      };
      break;
    }
    if (current?.state === "failed_not_charged") {
      outcome = {
        state: "failed_not_charged",
        error: { code: "DELIVERY_FAILED_NOT_CHARGED" }
      };
      break;
    }
    if (Date.now() >= deadline) break;
    await sleep(250);
  } while (true);

  return {
    status: 200,
    headers: responseHeaders,
    body: {
      quote_id: quote.quote_id,
      ...result,
      ...outcome,
      result_url: `/projects/${taskId}`,
      ...(chargingMode() === "bypass" ? { charging: "BYPASSED" } : {})
    }
  };
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

    const requestUrl = new URL(req.url ?? "/", "http://firm-gateway.local");

    // Firm Projects has its own listed x402 resource. Keeping it off `/`
    // prevents the 0.1-USDT Express challenge from shadowing the 1-USDT
    // Projects service when marketplace validators probe the endpoint.
    if (requestUrl.pathname === "/projects") {
      if (req.method === "GET") {
        if (chargingMode() === "enforce") {
          const readinessFailure = await projectsReadinessFailure();
          if (readinessFailure) {
            send(res, 503, { error: { code: "FULFILMENT_NOT_READY", detail: readinessFailure } });
            return;
          }
        }
        const gate = await sellerAuthorize({
          name: "Firm Projects",
          amount: "1000000",
          decimals: 6,
          resource: "firm:projects:v1",
          resourcePath: "/projects",
          inputSchema: PROJECT_RUN_HTTP_INPUT,
          outputSchema: PROJECT_RUN_HTTP_OUTPUT,
          headers: req.headers
        });
        if ("status" in gate) {
          res.writeHead(gate.status, { "content-type": "application/json", ...(gate.headers ?? {}) });
          res.end(JSON.stringify(gate.body));
          return;
        }
        send(res, 400, {
          error: { code: "INVALID_ARGS", detail: "POST goal, budget_cap, and optional constraints to run a Project" }
        });
        return;
      }
      if (req.method !== "POST") {
        send(res, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
        return;
      }
      const projectBody = await readJson(req);
      if (projectBody === MALFORMED_BODY) {
        send(res, 400, { error: { code: "INVALID_JSON", detail: "request body is not valid JSON" } });
        return;
      }
      const gate = await projectRunGate(projectBody, req.headers);
      if ("status" in gate) {
        res.writeHead(gate.status, { "content-type": "application/json", ...(gate.headers ?? {}) });
        res.end(JSON.stringify(gate.body));
        return;
      }
      const started = await startDirectProject(gate.prepared, gate.authorized);
      res.writeHead(started.status, started.headers);
      res.end(JSON.stringify(started.body));
      return;
    }

    if (req.method === "GET" && /^\/projects\/t_[a-zA-Z0-9]+$/.test(requestUrl.pathname)) {
      const taskId = requestUrl.pathname.slice("/projects/".length);
      const result = await toolCall("get_result", { task_id: taskId });
      if (result?.error?.code === "NOT_READY_OR_NOT_FOUND") {
        const status = await toolCall("get_status", { task_id: taskId });
        send(res, 200, { task_id: taskId, ...status });
        return;
      }
      send(res, 200, { task_id: taskId, ...result });
      return;
    }

    // An unpaid GET to a paid resource is a 402, not a 405. The review flagged
    // the 405 explicitly ("Return HTTP 402 (not 405/200) on unpaid requests"),
    // and answering with the challenge is also what lets a standard x402 buyer
    // — which probes with GET before it ever POSTs — discover the price at all.
    if (req.method === "GET") {
      const gate = await chargeGate("express_run", {}, req.headers);
      if ("status" in gate) {
        res.writeHead(gate.status, { "content-type": "application/json", ...(gate.headers ?? {}) });
        res.end(JSON.stringify(gate.body));
        return;
      }
      // A GET carries no job parameters, so a *paid* GET still cannot be run.
      send(res, 400, { error: { code: "INVALID_ARGS", detail: "send the job parameters in a POST body" } });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
      return;
    }
    const body = await readJson(req);
    if (body === MALFORMED_BODY) {
      send(res, 400, { error: { code: "INVALID_JSON", detail: "request body is not valid JSON" } });
      return;
    }
    const dispatch = mcpDispatch(body);

    if (dispatch.kind === "notification") {
      res.writeHead(202);
      res.end();
      return;
    }
    // A buyer following the marketplace listing POSTs {symbol, timeframe, prompt}
    // with no JSON-RPC envelope. That is the documented request, not a protocol
    // error, and answering it with HTTP 200 is what got this endpoint rejected.
    // Route it as express_run so it reaches the 402 like any other paid call.
    //
    // Note the dispatch shape: a body with no `method` does NOT come back as an
    // error — mcpDispatch reads it as the legacy `{tool, args}` REST form and
    // returns a tool call with an undefined name, which fell through to
    // UNKNOWN_TOOL at HTTP 200. So the trigger is "no tool we recognise",
    // not "the dispatcher errored".
    const unresolved =
      dispatch.kind === "error" ||
      (dispatch.kind === "tool" && !TOOL_DEFINITIONS.some((tool) => tool.name === dispatch.name));
    const direct = unresolved ? directHttpToolCall(body) : null;

    if (dispatch.kind === "error" && !direct) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error: { code: dispatch.code, message: dispatch.message } }));
      return;
    }
    if (dispatch.kind === "protocol") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body.id !== undefined ? { jsonrpc: "2.0", id: body.id, result: dispatch.result } : dispatch.result));
      return;
    }

    const method = direct ? direct.name : (dispatch as { name: string }).name;
    const args = direct ? direct.args : (dispatch as { args: any }).args;

    const gate = await chargeGate(method, args, req.headers);
    if ("status" in gate) {
      res.writeHead(gate.status, { "content-type": "application/json", ...(gate.headers ?? {}) });
      res.end(JSON.stringify(body.id ? { jsonrpc: "2.0", id: body.id, result: gate.body } : gate.body));
      return;
    }

    const result = await toolCall(
      method,
      args,
      gate.quote,
      gate.deferred?.payer ?? (gate.settled?.ok ? gate.settled.payer : undefined),
      gate.deferred ? "authorized" : "paid"
    );

    // Express returns an internal task marker only after the worker has built
    // and strictly validated the requested output. Settle at that point, make
    // the result public only on settlement success, and remove the marker from
    // the buyer-visible body in every case.
    const settlementTaskId =
      result && typeof result === "object" && typeof result._settlement_task_id === "string"
        ? result._settlement_task_id
        : undefined;
    let responseSettlement = gate.settled;
    if (settlementTaskId && gate.deferred) {
      const settlement = await settlePayment(gate.deferred.header, gate.deferred.requirements, {
        facilitatorUrl: gate.deferred.facilitatorUrl
      });
      if (!settlement.ok) {
        await pool().query(
          `UPDATE firm_jobs
           SET state = 'failed_not_charged', deliverable = NULL,
               provenance = jsonb_set(
                 jsonb_set(
                   COALESCE(provenance, '{}'::jsonb),
                   '{guarantee_status}',
                   '"not_charged"'::jsonb
                 ),
                 '{economics,margin_retained_or_absorbed}',
                 jsonb_build_object(
                   'amount',
                   (
                     COALESCE(provenance #>> '{economics,actual_vendor_costs,amount}', '0')::numeric
                     + COALESCE(provenance #>> '{books,cost,amount}', '0')::numeric
                   )::text,
                   'sign',
                   'absorbed'
                 )
               ),
               updated_at = now()
           WHERE task_id = $1 AND state = 'ready_to_settle'`,
          [settlementTaskId]
        );
        res.writeHead(402, {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodeRequirements(gate.deferred.requirements)
        });
        res.end(
          JSON.stringify({
            error: {
              code: "PAYMENT_NOT_SETTLED",
              detail: `output validated but authorization did not settle; buyer was not charged: ${settlement.reason}`
            },
            ...gate.deferred.requirements
          })
        );
        return;
      }
      responseSettlement = { ...settlement, payer: settlement.payer ?? gate.deferred.payer };
      await pool().query(
        "UPDATE firm_jobs SET state = 'complete', updated_at = now() WHERE task_id = $1 AND state = 'ready_to_settle'",
        [settlementTaskId]
      );
    } else if (settlementTaskId && chargingMode() === "bypass") {
      await pool().query(
        "UPDATE firm_jobs SET state = 'complete', updated_at = now() WHERE task_id = $1 AND state = 'ready_to_settle'",
        [settlementTaskId]
      );
    }
    if (settlementTaskId && result && typeof result === "object") delete result._settlement_task_id;
    const payload: Record<string, unknown> =
      PAID_TOOLS.has(method) && chargingMode() === "bypass" && result && typeof result === "object"
        ? { ...result, charging: "BYPASSED" }
        : (result as Record<string, unknown>);

    const responseHeaders: Record<string, string> = { "content-type": "application/json" };
    if (responseSettlement?.ok) responseHeaders["PAYMENT-RESPONSE"] = encodeSettlement(responseSettlement);
    const responseError =
      payload && typeof payload === "object" && "error" in payload
        ? (payload.error as Record<string, unknown> | undefined)
        : undefined;
    const transientFulfilmentFailure = responseError?.code === "DELIVERY_FAILED_NOT_CHARGED";
    if (transientFulfilmentFailure) responseHeaders["Retry-After"] = "2";
    res.writeHead(transientFulfilmentFailure ? 503 : 200, responseHeaders);
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
  const mode = procurerUrl ? await readFulfilmentMode(procurerUrl) : null;
  const failure = fulfilmentFailure({ charging: true, mode });
  if (failure) {
    const configuration = procurerUrl ? "" : "PROCURER_URL is not set; ";
    console.error(`[fulfilment] refusing to start: ${configuration}${failure}`);
    process.exit(1);
  }
  console.log("[fulfilment] procurer confirmed live: real payments and refunds on, wallet key present");
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
