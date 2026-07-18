import http from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { ensureGatewayTables, pool } from "./db.js";
import { quotePrice, estimatePlan, PricingMode } from "./pricing.js";
import { usdt, units } from "./money.js";

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

async function toolCall(name: string, args: any) {
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
    const client = pool();
    try {
      await client.query(
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
    } finally {
      await client.end();
    }
    return quote;
  }

  if (name === "execute") {
    const quoteId = z.object({ quote_id: z.string() }).parse(args).quote_id;
    const lookup = pool();
    let stored: { goal: string; quote: Record<string, unknown> } | undefined;
    try {
      const result = await lookup.query(
        "SELECT goal, quote FROM firm_quotes WHERE quote_id = $1 AND valid_until > now()",
        [quoteId]
      );
      stored = result.rows[0];
    } finally {
      await lookup.end();
    }
    if (!stored) return { error: { code: "QUOTE_NOT_FOUND" } };
    const taskId = `t_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const client = pool();
    try {
      await client.query(
        `INSERT INTO firm_jobs
         (task_id, quote_id, state, goal, quote, progress, deliverable, provenance, refund)
         VALUES ($1, $2, 'paid', $3, $4::jsonb, '[]'::jsonb, NULL, NULL, NULL)`,
        [taskId, quoteId, stored.goal, JSON.stringify(stored.quote)]
      );
    } finally {
      await client.end();
    }
    return { task_id: taskId, state: "planning" };
  }

  if (name === "get_status") {
    const taskId = z.object({ task_id: z.string() }).parse(args).task_id;
    const client = pool();
    try {
      const result = await client.query("SELECT state, progress FROM firm_jobs WHERE task_id = $1", [taskId]);
      return result.rows[0] ?? { error: { code: "NOT_FOUND" } };
    } finally {
      await client.end();
    }
  }

  if (name === "get_result") {
    const taskId = z.object({ task_id: z.string() }).parse(args).task_id;
    const client = pool();
    try {
      const result = await client.query(
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
    } finally {
      await client.end();
    }
  }

  if (name === "express_run") {
    return {
      error: {
        code: "TODO_UNVERIFIED_EXPRESS_VENDOR_POOL",
        detail: "Express job types lock after vendor reliability testing."
      }
    };
  }

  return { error: { code: "UNKNOWN_TOOL" } };
}

await ensureGatewayTables();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      send(res, 200, { ok: true, service: "firm-gateway" });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
      return;
    }
    const body = await readJson(req);
    const method = body.method === "tools/call" ? body.params?.name : body.tool;
    const args = body.method === "tools/call" ? body.params?.arguments ?? {} : body.args ?? {};
    const result = await toolCall(method, args);
    send(res, 200, body.id ? { jsonrpc: "2.0", id: body.id, result } : result);
  } catch (error) {
    send(res, 500, { error: { code: "GATEWAY_ERROR", detail: String(error) } });
  }
});

server.listen(Number(process.env.PORT ?? 8790), "127.0.0.1", () => {
  console.log(`firm-gateway listening on http://127.0.0.1:${process.env.PORT ?? 8790}`);
});
