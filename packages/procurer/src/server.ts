import http from "node:http";
import { createHash } from "node:crypto";
import { z } from "zod";

import { bearerFailure } from "./auth.js";
import { capsFromEnv } from "./caps.js";
import {
  ensureTables,
  markRefundPending,
  markSigned,
  recordSignedFailure,
  releaseCall,
  releaseRefund,
  reserveCall,
  reserveRefund,
  settleCall,
  settleRefund,
  spendSnapshot
} from "./db.js";
import { units } from "./money.js";
import {
  executeRefund,
  realRefundsEnabled,
  refundMode,
  refundReadiness,
  refundTransactionStatus
} from "./refund.js";
import { localSigner } from "./local-signer.js";
import { payAndCallVendor } from "./vendor.js";
import { vetVendors } from "./vet.js";

const money = z.object({ amount: z.string(), decimals: z.number(), token: z.string() });
const payAndCallSchema = z.object({
  vendor_endpoint: z.string(),
  tool: z.string(),
  args: z.record(z.unknown()),
  max_amount: money,
  task_id: z.string(),
  subtask_id: z.string()
});
const refundSchema = z.object({
  task_id: z.string(),
  to_address: z.string(),
  amount: money
});
const vetCandidateSchema = z.object({
  vendor_endpoint: z.string(),
  tool: z.string(),
  args: z.record(z.unknown()).optional(),
  listed_amount: money.optional(),
  max_amount: money.optional()
});
/** Accepts one candidate inline, or a batch. Exactly one form must be present. */
const vetSchema = vetCandidateSchema
  .partial()
  .extend({ candidates: z.array(vetCandidateSchema).min(1).optional() })
  .refine(
    (value) => Boolean(value.candidates) !== Boolean(value.vendor_endpoint && value.tool),
    "provide either `candidates`, or `vendor_endpoint` + `tool`, but not both"
  );

function realPaymentsEnabled(): boolean {
  return process.env.REAL_PAYMENTS_ENABLED === "true";
}

function authToken(): string | undefined {
  const token = process.env.PROCURER_AUTH_TOKEN;
  return token && token.length > 0 ? token : undefined;
}

/** Returns null when the request may proceed, or the reason it may not. */
function authFailure(req: http.IncomingMessage): string | null {
  return bearerFailure(req.headers.authorization, authToken());
}

function envList(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const list = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** Token contracts the procurer may pay in. */
function allowedAssets(): string[] | undefined {
  return envList("X402_ALLOWED_ASSETS");
}

/**
 * CAIP-2 chains the procurer may pay on. As load-bearing as the asset list:
 * "15 units of token X" is meaningless without the chain, so an attacker who
 * deploys a familiar-looking contract address on a chain we never meant to
 * touch would otherwise clear an asset-only allow-list.
 */
function allowedNetworks(): string[] | undefined {
  return envList("X402_ALLOWED_NETWORKS");
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function simulatedTx(prefix: string, key: string) {
  return `SIMULATED:${prefix}:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

type PayRequest = z.infer<typeof payAndCallSchema>;

/**
 * Simulation stands in for the vendor round trip when real payments are off.
 * It still runs behind the same reservation and cap machinery, so the money
 * bookkeeping under test is the same code that runs live.
 */
function simulatedOutcome(request: PayRequest, idempotencyKey: string) {
  return {
    ok: true as const,
    result: {
      kind: request.tool,
      checklist: ["SIMULATED procurer vendor result"],
      generated_at: new Date().toISOString()
    },
    receipt: {
      amount: request.max_amount,
      tx: simulatedTx("pay", idempotencyKey),
      payment_response: "SIMULATED x402 payment; no funds moved"
    },
    latency_ms: 50
  };
}

async function handlePayAndCall(body: unknown) {
  const request = payAndCallSchema.parse(body);
  const idempotencyKey = `${request.task_id}:${request.subtask_id}:${request.vendor_endpoint}`;
  const caps = capsFromEnv();

  let ceilingUnits: number;
  try {
    ceilingUnits = units(request.max_amount);
  } catch (error) {
    return { ok: false, error_code: "VENDOR_ERROR", detail: String(error) };
  }

  // Claim the ceiling against every cap before a single byte goes to the vendor.
  const reservation = await reserveCall(
    {
      idempotencyKey,
      taskId: request.task_id,
      subtaskId: request.subtask_id,
      vendorEndpoint: request.vendor_endpoint,
      ceiling: request.max_amount
    },
    caps,
    realPaymentsEnabled() ? "real" : "simulated"
  );

  if (reservation.kind === "replay") return reservation.response;
  if (reservation.kind === "cap_exceeded") {
    return { ok: false, error_code: "CAP_EXCEEDED", detail: reservation.detail };
  }
  if (reservation.kind === "in_flight") {
    return {
      ok: false,
      error_code: "PAYMENT_FAILED",
      detail: "another call for this (task_id, subtask_id, vendor_endpoint) is already in flight"
    };
  }
  if (reservation.kind === "needs_human") {
    return { ok: false, error_code: "REQUIRES_HUMAN", detail: reservation.detail };
  }

  if (!realPaymentsEnabled()) {
    const response = simulatedOutcome(request, idempotencyKey);
    await settleCall(idempotencyKey, request.max_amount, response);
    return response;
  }

  let outcome;
  try {
    outcome = await payAndCallVendor(
      { vendorEndpoint: request.vendor_endpoint, tool: request.tool, args: request.args },
      {
        // Signs in-process. The nonce is derived from the idempotency key, so a
        // re-sign of this subtask reproduces the same authorization and the
        // token's single-use nonce enforces at-most-once payment on-chain.
        signer: localSigner({ nonceSeed: idempotencyKey }),
        allowedAssets: allowedAssets(),
        allowedNetworks: allowedNetworks(),
        // Real money is moving, so the asset's scale must be known before we
        // sign — declared by the vendor, or pinned by the allow-lists above,
        // which are mandatory in this mode.
        requireKnownDecimals: true,
        // OKLink can transiently reject a valid authorization and immediately
        // re-issue the same 402. Replaying the identical signed header once is
        // safe: its EIP-3009 nonce is unchanged, so it can settle at most once.
        retryRejectedAuthorization: true,
        decimals: request.max_amount.decimals,
        token: request.max_amount.token,
        timeoutMs: Number(process.env.VENDOR_TIMEOUT_MS ?? 60_000),
        onSigned: () => markSigned(idempotencyKey),
        // The reservation already cleared the ceiling against the aggregate caps.
        // The only thing left to prove is that what the vendor actually asked for
        // is not more than what the caller authorised.
        verifyCaps: async (offer) => {
          if (offer.amountUnits > ceilingUnits) {
            return {
              detail: `vendor asked for ${offer.amountUnits} base units, above the caller's max_amount of ${ceilingUnits}`
            };
          }
          if (offer.amountUnits > caps.perCallMax) {
            return { detail: "per-call cap would be exceeded before payment" };
          }
          return null;
        }
      }
    );
  } catch (error) {
    // An unexpected throw would otherwise strand the row in `reserved`, where
    // it blocks every retry of this subtask with IN_FLIGHT and permanently
    // consumes cap budget. Release it — releaseCall only touches `reserved`
    // rows, so a throw that happened after signing is still left alone.
    const failure = { ok: false as const, error_code: "PROCURER_ERROR", detail: String(error) };
    await releaseCall(idempotencyKey, failure);
    await recordSignedFailure(idempotencyKey, failure);
    return failure;
  }

  if (outcome.ok) {
    await settleCall(idempotencyKey, outcome.receipt.amount, outcome);
    return outcome;
  }

  // A failure before signing releases the claim so the worker can retry.
  // A failure after signing does not: markSigned already moved the row out of
  // `reserved`, and releaseCall deliberately only touches `reserved` rows.
  await releaseCall(idempotencyKey, outcome);
  await recordSignedFailure(idempotencyKey, outcome);
  return outcome;
}

async function handleRefund(body: unknown) {
  const request = refundSchema.parse(body);
  const caps = capsFromEnv();

  let amountUnits: number;
  try {
    amountUnits = units(request.amount);
  } catch (error) {
    return { error_code: "VENDOR_ERROR", detail: String(error) };
  }

  const reservation = await reserveRefund(
    { taskId: request.task_id, toAddress: request.to_address, amount: request.amount },
    caps
  );

  if (reservation.kind === "replay") return reservation.response;
  if (reservation.kind === "pending") {
    const previous = reservation.response as { tx?: string } | null;
    if (!previous?.tx) {
      return { error_code: "REFUND_PENDING_CONFIRMATION", detail: "pending refund has no transaction hash" };
    }
    const status = await refundTransactionStatus(previous.tx as `0x${string}`);
    if (status.status === "settled") {
      const response = { tx: previous.tx, detail: status.detail };
      await settleRefund(request.task_id, response);
      return response;
    }
    if (status.status === "reverted") {
      const response = { error_code: "REFUND_FAILED", detail: status.detail };
      await releaseRefund(request.task_id, response);
      return response;
    }
    return { error_code: "REFUND_PENDING_CONFIRMATION", tx: previous.tx, detail: status.detail };
  }
  if (reservation.kind === "requires_human") {
    return { error_code: "REQUIRES_HUMAN", detail: reservation.detail };
  }
  if (reservation.kind === "cap_exceeded") {
    return { error_code: "CAP_EXCEEDED", detail: reservation.detail };
  }
  if (reservation.kind === "in_flight") {
    return { error_code: "REFUND_IN_FLIGHT", detail: "a refund for this task is already in flight" };
  }

  const mode = refundMode({ realPayments: realPaymentsEnabled(), realRefunds: realRefundsEnabled() });

  // Fails closed, and releases the reservation: nothing was refunded, so it must
  // not keep holding against the daily refund cap. The detail carries the exact
  // command a human can run — preparing it without firing it is the standing
  // rule for real-money operations.
  if (mode === "requires_human") {
    const response = {
      error_code: "REQUIRES_HUMAN",
      detail:
        `real payments are enabled but real refunds are not, so this refund was NOT sent. ` +
        `Owed: ${request.amount.amount} base units of ${request.amount.token} to ${request.to_address} ` +
        `for task ${request.task_id}. Send it manually, then set REAL_REFUNDS_ENABLED=true to close this path: ` +
        `cast send $REFUND_TOKEN_CONTRACT "transfer(address,uint256)" ${request.to_address} ${amountUnits} ` +
        `--rpc-url $X402_RPC_URL --private-key $FIRM_WALLET_KEY`
    };
    await releaseRefund(request.task_id, response);
    return response;
  }

  if (mode === "simulated") {
    const response = { tx: simulatedTx("refund", request.task_id) };
    await settleRefund(request.task_id, response);
    return response;
  }

  const result = await executeRefund({ toAddress: request.to_address, amountUnits });
  if (!result.ok) {
    if (result.pendingTx) {
      const response = {
        error_code: "REFUND_PENDING_CONFIRMATION",
        tx: result.pendingTx,
        detail: result.detail
      };
      await markRefundPending(request.task_id, response);
      return response;
    }
    const response = { error_code: "REFUND_FAILED", detail: result.detail };
    await releaseRefund(request.task_id, response);
    return response;
  }
  const response = { tx: result.tx, detail: result.detail };
  await settleRefund(request.task_id, response);
  return response;
}

/**
 * Vetting is free and never signs, so it deliberately does NOT go through the
 * reservation or cap machinery — there is nothing to reserve. It is also not an
 * authorisation: /pay-and-call re-reads the challenge and re-checks every cap
 * against the amount it is about to sign, because a vendor can reprice between
 * the probe and the call.
 */
async function handleVet(body: unknown) {
  const request = vetSchema.parse(body);
  const candidates = request.candidates ?? [
    {
      vendor_endpoint: request.vendor_endpoint!,
      tool: request.tool!,
      args: request.args,
      listed_amount: request.listed_amount,
      max_amount: request.max_amount
    }
  ];

  const results = await vetVendors(
    candidates.map((candidate) => ({
      vendorEndpoint: candidate.vendor_endpoint,
      tool: candidate.tool,
      args: candidate.args,
      listedAmount: candidate.listed_amount,
      maxAmount: candidate.max_amount
    })),
    { allowedAssets: allowedAssets(), timeoutMs: Number(process.env.VET_TIMEOUT_MS ?? 10_000) }
  );

  return {
    ok: true,
    cost: "none — no payment was signed or sent for any probe",
    vetted: results.length,
    hireable: results.filter((result) => result.hireable).length,
    results
  };
}

await ensureTables();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      const readiness = await refundReadiness();
      send(res, 200, {
        ok: true,
        service: "firm-procurer",
        real_payments_enabled: realPaymentsEnabled(),
        real_refunds_enabled: realRefundsEnabled(),
        wallet_key_present: Boolean(process.env.FIRM_WALLET_KEY),
        refund_ready: readiness.ready,
        refund_readiness_detail: readiness.detail,
        refund_gas_balance_wei: readiness.balanceWei,
        refund_gas_required_wei: readiness.requiredWei
      });
      return;
    }
    if (req.method === "GET" && req.url === "/caps") {
      send(res, 200, { ...capsFromEnv(), ...(await spendSnapshot()) });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }
    // Everything below this point can spend money or read the spend ledger.
    // /health and /caps above are deliberately open: they carry no secrets and
    // a container healthcheck needs them.
    const denied = authFailure(req);
    if (denied) {
      send(res, 401, { ok: false, error_code: "UNAUTHORIZED", detail: denied });
      return;
    }
    const body = await readJson(req);
    if (req.url === "/pay-and-call") {
      send(res, 200, await handlePayAndCall(body));
      return;
    }
    if (req.url === "/refund") {
      send(res, 200, await handleRefund(body));
      return;
    }
    if (req.url === "/vet") {
      send(res, 200, await handleVet(body));
      return;
    }
    send(res, 404, { error: "NOT_FOUND" });
  } catch (error) {
    send(res, 500, { ok: false, error_code: "PROCURER_ERROR", detail: String(error) });
  }
});

/**
 * The procurer is a spending API: anything that can reach /pay-and-call can
 * move the Firm's money, up to the caps. On a laptop that is fine, because it
 * only ever listens on loopback. In a container it has to be reachable by the
 * worker over the compose network, and then "whoever can reach it" is no longer
 * just us.
 *
 * So a non-loopback bind requires PROCURER_AUTH_TOKEN, and refuses to start
 * without one. Loopback keeps working with no token, so nothing about local
 * development changes.
 */
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const isPublicBind = host !== "127.0.0.1" && host !== "localhost" && host !== "::1";

// Both allow-lists are optional in simulation and mandatory once real money can
// move. An empty asset list means "pay in whatever the vendor names"; an empty
// network list means "on whatever chain it names". Together those turn a
// malicious 402 into a signature for an asset we never intended to hold, and
// the cap arithmetic cannot see the difference because base units are just
// integers. Refuse at startup rather than mid-payment.
if (realPaymentsEnabled() && (!allowedAssets() || !allowedNetworks())) {
  console.error(
    "[procurer] refusing to start with REAL_PAYMENTS_ENABLED=true and no X402_ALLOWED_ASSETS " +
      "or X402_ALLOWED_NETWORKS. Without both, a vendor chooses which asset and which chain we " +
      "sign for, and a base-unit cap check cannot tell the difference."
  );
  process.exit(1);
}

if (isPublicBind && !authToken()) {
  console.error(
    `[procurer] refusing to bind ${host} without PROCURER_AUTH_TOKEN. Anything that can reach ` +
      "/pay-and-call can spend the Firm's money up to the caps; on a non-loopback interface that " +
      "must be authenticated. Bind 127.0.0.1 for local use, or set a token."
  );
  process.exit(1);
}

server.listen(port, host, () => {
  const mode = realPaymentsEnabled() ? "REAL PAYMENTS ENABLED" : "simulation only";
  const auth = authToken() ? "token required" : "loopback only, no token";
  console.log(`firm-procurer listening on http://${host}:${port} (${mode}, ${auth})`);
});
