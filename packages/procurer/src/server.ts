import http from "node:http";
import { createHash } from "node:crypto";
import { z } from "zod";

import { assertAggregateCaps, assertPerCall, assertRefundCap, capsFromEnv } from "./caps.js";
import { ensureTables, pool } from "./db.js";

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

async function existingCall(idempotencyKey: string) {
  const client = pool();
  try {
    const result = await client.query("SELECT response FROM procurer_calls WHERE idempotency_key = $1", [idempotencyKey]);
    return result.rows[0]?.response ?? null;
  } finally {
    await client.end();
  }
}

async function saveCall(idempotencyKey: string, request: z.infer<typeof payAndCallSchema>, response: unknown) {
  const client = pool();
  try {
    await client.query(
      `INSERT INTO procurer_calls
       (idempotency_key, task_id, subtask_id, vendor_endpoint, amount, response)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        idempotencyKey,
        request.task_id,
        request.subtask_id,
        request.vendor_endpoint,
        JSON.stringify(request.max_amount),
        JSON.stringify(response)
      ]
    );
  } finally {
    await client.end();
  }
}

async function spendTotals(taskId: string) {
  const client = pool();
  try {
    const result = await client.query(
      `SELECT
         COALESCE(SUM(((amount->>'amount')::bigint)) FILTER (WHERE task_id = $1), 0)::bigint AS task_spend,
         COALESCE(SUM(((amount->>'amount')::bigint)) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::bigint AS daily_spend
       FROM procurer_calls`,
      [taskId]
    );
    return {
      taskSpend: Number(result.rows[0]?.task_spend ?? 0),
      dailySpend: Number(result.rows[0]?.daily_spend ?? 0)
    };
  } finally {
    await client.end();
  }
}

async function refundTotalToday() {
  const client = pool();
  try {
    const result = await client.query(
      `SELECT COALESCE(SUM(((amount->>'amount')::bigint)), 0)::bigint AS refunded
       FROM procurer_refunds
       WHERE created_at >= date_trunc('day', now())`
    );
    return Number(result.rows[0]?.refunded ?? 0);
  } finally {
    await client.end();
  }
}

async function handlePayAndCall(body: unknown) {
  const request = payAndCallSchema.parse(body);
  const idempotencyKey = `${request.task_id}:${request.subtask_id}:${request.vendor_endpoint}`;
  const existing = await existingCall(idempotencyKey);
  if (existing) return existing;

  const caps = capsFromEnv();
  const capCheck = assertPerCall(request.max_amount, caps);
  if (!capCheck.ok) return capCheck;
  const totals = await spendTotals(request.task_id);
  const aggregateCheck = assertAggregateCaps(
    request.max_amount,
    caps,
    totals.taskSpend,
    totals.dailySpend
  );
  if (!aggregateCheck.ok) return aggregateCheck;

  // TODO(unverified): replace with real OKX x402 buyer flow after human-triggered payment spike.
  const response = {
    ok: true,
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
  await saveCall(idempotencyKey, request, response);
  return response;
}

async function handleRefund(body: unknown) {
  const request = refundSchema.parse(body);
  const refundCheck = assertRefundCap(request.amount, capsFromEnv(), await refundTotalToday());
  if (!refundCheck.ok) return refundCheck;
  const client = pool();
  try {
    const existing = await client.query("SELECT response FROM procurer_refunds WHERE task_id = $1", [request.task_id]);
    if (existing.rows[0]) return existing.rows[0].response;
    const response = { tx: simulatedTx("refund", request.task_id) };
    await client.query(
      `INSERT INTO procurer_refunds (task_id, amount, to_address, response)
       VALUES ($1, $2::jsonb, $3, $4::jsonb)`,
      [request.task_id, JSON.stringify(request.amount), request.to_address, JSON.stringify(response)]
    );
    return response;
  } finally {
    await client.end();
  }
}

await ensureTables();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      send(res, 200, { ok: true, service: "firm-procurer", real_payments_enabled: false });
      return;
    }
    if (req.method === "GET" && req.url === "/caps") {
      send(res, 200, capsFromEnv());
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
  console.log(`firm-procurer listening on http://127.0.0.1:${process.env.PORT ?? 8787}`);
});
