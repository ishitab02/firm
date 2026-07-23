import {
  isJsonRpcRequest,
  normaliseExpressArgs,
  SUPPORTED_MARKET_SYMBOLS,
  SUPPORTED_MARKET_TIMEFRAMES,
  type ExpressArgs
} from "./express-args.js";

export type ProjectMarketRequest = {
  subtask: string;
  symbol: (typeof SUPPORTED_MARKET_SYMBOLS)[number];
  timeframe: (typeof SUPPORTED_MARKET_TIMEFRAMES)[number];
  prompt: string;
};

export type ProjectSpec = {
  requests: ProjectMarketRequest[];
  plan: Array<{ subtask: string; capability: "market_snapshot"; max_amount: null }>;
};

export type ProjectSpecResult =
  | { ok: true; spec: ProjectSpec }
  | { ok: false; detail: string };

/**
 * Coerce JSON-string-valued fields on a Projects body back into objects.
 *
 * The OKX payment CLI passes business params as `--param key=value`, flat
 * strings only — there is no nested-object form. A buyer following the standard
 * flow sends `--param budget_cap={"amount":"1000000",...}`, which reaches the
 * server as `{ budget_cap: "{\"amount\":\"1000000\",...}" }`: `budget_cap` a
 * STRING, not the object the schema requires. It then failed `INVALID_ARGS`
 * with HTTP 400 — the same "paid replay is not a valid x402 call" shape this
 * entry has already been rejected for, and the way a reviewer buying through
 * the CLI would first meet Projects.
 *
 * A direct JSON POST already sends the object and is untouched: coercion only
 * fires when the field arrived as a string, and a string that is not JSON is
 * left as-is so the schema still rejects genuine garbage. Applied to
 * `constraints` too, which is the other object-valued field a CLI buyer might
 * pass the same way.
 */
export function coerceProjectArgs(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const bag = args as Record<string, unknown>;
  const coerced: Record<string, unknown> = { ...bag };
  for (const key of ["budget_cap", "constraints"]) {
    const value = bag[key];
    if (typeof value !== "string") continue;
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        coerced[key] = parsed;
      }
    } catch {
      // Not JSON: leave the string in place so schema validation still fails it.
    }
  }
  return coerced;
}

function uniqueMatches<T extends string>(text: string, expression: RegExp, allowed: readonly T[]): T[] {
  const found: T[] = [];
  for (const match of text.matchAll(expression)) {
    const value = match[1] as T;
    if (allowed.includes(value) && !found.includes(value)) found.push(value);
  }
  return found;
}

/**
 * Turn the buyer's natural-language Projects goal into the exact contracts we
 * can currently fulfil with a verified marketplace supplier.
 *
 * Projects deliberately requires at least two legs. A single BTC/ETH snapshot
 * is the cheaper synchronous Express product; charging ten times as much for
 * the same work would be indefensible. Multiple symbols on one timeframe, one
 * symbol on multiple timeframes, or their (bounded) cross-product are real
 * projects: every leg is separately procured, validated and receipted before
 * the bundle is assembled.
 */
export function projectSpecFromGoal(goal: string): ProjectSpecResult {
  const prompt = goal.trim();
  if (!prompt) return { ok: false, detail: "goal is required" };

  const symbols = uniqueMatches(
    prompt.toUpperCase(),
    /(?:^|[^A-Z0-9])(BTC|ETH)(?=$|[^A-Z0-9])/g,
    SUPPORTED_MARKET_SYMBOLS
  );
  const timeframes = uniqueMatches(
    prompt.toLowerCase(),
    /(?:^|[^a-z0-9])(1h|2h|4h|1d)(?=$|[^a-z0-9])/g,
    SUPPORTED_MARKET_TIMEFRAMES
  );

  if (symbols.length === 0) {
    return {
      ok: false,
      detail: `Projects v1 needs BTC and/or ETH in the goal; supported: ${SUPPORTED_MARKET_SYMBOLS.join(", ")}`
    };
  }
  if (timeframes.length === 0) {
    return {
      ok: false,
      detail: `Projects v1 needs a timeframe in the goal; supported: ${SUPPORTED_MARKET_TIMEFRAMES.join(", ")}`
    };
  }

  const requests: ProjectMarketRequest[] = [];
  for (const symbol of symbols) {
    for (const timeframe of timeframes) {
      requests.push({
        subtask: `${symbol} ${timeframe} market snapshot`,
        symbol,
        timeframe,
        prompt
      });
    }
  }
  if (requests.length < 2) {
    return {
      ok: false,
      detail:
        "Projects v1 requires at least two market-analysis legs; use Express for one symbol and one timeframe"
    };
  }
  if (requests.length > 4) {
    return {
      ok: false,
      detail: "Projects v1 supports at most four symbol/timeframe legs in one fixed-price project"
    };
  }

  return {
    ok: true,
    spec: {
      requests,
      plan: requests.map((request) => ({
        subtask: request.subtask,
        capability: "market_snapshot",
        max_amount: null
      }))
    }
  };
}

export const PROJECT_EXECUTE_HTTP_INPUT = {
  type: "http",
  method: "POST",
  bodyType: "json",
  body: {
    type: "object",
    required: ["quote_id"],
    properties: {
      quote_id: {
        type: "string",
        description: "The unexpired quote_id returned by get_quote"
      }
    }
  }
} as const;

export const PROJECT_RUN_HTTP_INPUT = {
  type: "http",
  method: "POST",
  bodyType: "json",
  body: {
    type: "object",
    required: ["goal", "budget_cap"],
    properties: {
      goal: {
        type: "string",
        description: "A 2-4 leg BTC/ETH market-research goal naming supported timeframes"
      },
      budget_cap: {
        type: "object",
        required: ["amount", "decimals"],
        properties: {
          amount: { type: "string" },
          decimals: { type: "number", const: 6 },
          token: { type: "string", const: "USDT" }
        }
      },
      constraints: {
        type: "object",
        properties: {
          deadline_minutes: { type: "number" },
          min_vendor_score: { type: "number" },
          banned_categories: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
} as const;

export const PROJECT_RUN_HTTP_OUTPUT = {
  type: "object",
  required: ["task_id", "state", "result_url"],
  properties: {
    quote_id: { type: "string" },
    task_id: { type: "string" },
    state: { type: "string", enum: ["complete", "pending", "failed_refunded", "failed_not_charged"] },
    result_url: { type: "string" },
    deliverable: { type: "object" },
    provenance: { type: "object" },
    error: { type: "object" }
  }
} as const;

export type DirectToolCall =
  | { name: "get_quote"; args: Record<string, unknown> }
  | { name: "execute"; args: { quote_id: string } }
  | { name: "express_run"; args: ExpressArgs };

/** Route the documented bare HTTP bodies alongside the MCP envelope. */
export function directHttpToolCall(body: unknown): DirectToolCall | null {
  if (isJsonRpcRequest(body) || typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const bag = body as Record<string, unknown>;
  if (typeof bag.quote_id === "string" && bag.quote_id.length > 0) {
    return { name: "execute", args: { quote_id: bag.quote_id } };
  }
  if (typeof bag.goal === "string" && typeof bag.budget_cap === "object" && bag.budget_cap !== null) {
    return { name: "get_quote", args: bag };
  }
  const express = normaliseExpressArgs(bag);
  return express ? { name: "express_run", args: express } : null;
}
