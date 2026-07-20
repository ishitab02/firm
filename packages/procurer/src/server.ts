import http from "node:http";
import { createHash } from "node:crypto";
import { z } from "zod";

import { capsFromEnv } from "./caps.js";
import {
  ensureTables,
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
import { executeRefund, realRefundsEnabled } from "./refund.js";
import { realSigner } from "./signer.js";
import { payAndCallVendor } from "./vendor.js";

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

function realPaymentsEnabled(): boolean {
  return process.env.REAL_PAYMENTS_ENABLED === "true";
}

function allowedAssets(): string[] | undefined {
  const raw = process.env.X402_ALLOWED_ASSETS;
  if (!raw) return undefined;
  const list = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
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
    ceilingUnits,
    caps
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
        signer: realSigner(),
        allowedAssets: allowedAssets(),
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
    amountUnits,
    caps
  );

  if (reservation.kind === "replay") return reservation.response;
  if (reservation.kind === "requires_human") {
    return { error_code: "REQUIRES_HUMAN", detail: reservation.detail };
  }
  if (reservation.kind === "cap_exceeded") {
    return { error_code: "CAP_EXCEEDED", detail: reservation.detail };
  }
  if (reservation.kind === "in_flight") {
    return { error_code: "REFUND_IN_FLIGHT", detail: "a refund for this task is already in flight" };
  }

  if (!realRefundsEnabled()) {
    const response = { tx: simulatedTx("refund", request.task_id) };
    await settleRefund(request.task_id, response);
    return response;
  }

  const result = await executeRefund({ toAddress: request.to_address, amountUnits });
  if (!result.ok) {
    const response = { error_code: "REFUND_FAILED", detail: result.detail };
    await releaseRefund(request.task_id, response);
    return response;
  }
  const response = { tx: result.tx, detail: result.detail };
  await settleRefund(request.task_id, response);
  return response;
}

await ensureTables();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      send(res, 200, {
        ok: true,
        service: "firm-procurer",
        real_payments_enabled: realPaymentsEnabled(),
        real_refunds_enabled: realRefundsEnabled(),
        wallet_key_present: Boolean(process.env.FIRM_WALLET_KEY)
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
    const body = await readJson(req);
    if (req.url === "/pay-and-call") {
      send(res, 200, await handlePayAndCall(body));
      return;
    }
    if (req.url === "/refund") {
      send(res, 200, await handleRefund(body));
      return;
    }
    send(res, 404, { error: "NOT_FOUND" });
  } catch (error) {
    send(res, 500, { ok: false, error_code: "PROCURER_ERROR", detail: String(error) });
  }
});

server.listen(Number(process.env.PORT ?? 8787), "127.0.0.1", () => {
  const mode = realPaymentsEnabled() ? "REAL PAYMENTS ENABLED" : "simulation only";
  console.log(`firm-procurer listening on http://127.0.0.1:${process.env.PORT ?? 8787} (${mode})`);
});
