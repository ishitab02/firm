/**
 * Express argument normalisation.
 *
 * The marketplace listing documents Firm Express as taking `symbol`,
 * `timeframe` and `prompt` — the fields a buyer of a market snapshot naturally
 * thinks in — while the tool contract is `{job_type, params}`. A buyer
 * following the listing sent a flat bag with no `job_type`, got `INVALID_ARGS`
 * with HTTP 200, and never saw a 402 at all.
 *
 * That is not merely unfriendly. `x402-check` reads the status code, so with the
 * documented body OKX's own validator returned
 *   "Endpoint returned HTTP 200 (not 402); not a valid x402 service"
 * which is verbatim the reason Treasury was rejected twice.
 *
 * The fix belongs here rather than in the listing copy: the endpoint should
 * accept what we tell people to send. An explicit `job_type` still wins; a flat
 * bag is treated as params for the single job type we sell.
 *
 * Lives in its own module so it can be tested without importing server.ts,
 * which binds a port at import time.
 */

/**
 * Is this an MCP/JSON-RPC request, or a buyer POSTing the listing's fields raw?
 *
 * The marketplace listing documents Firm Express as taking `symbol`, `timeframe`
 * and `prompt`. A buyer — including OKX's own reviewer — POSTs exactly that to
 * the listed endpoint, with no JSON-RPC envelope. That is not a malformed MCP
 * call; it is the documented request. Treating it as a protocol error returned
 * HTTP 200 and no 402, which is what the review rejected #7138 for:
 *
 *   "POST-with-body returns HTTP 200 … never issues an HTTP 402 challenge"
 *
 * A genuine MCP client always sends `jsonrpc` and `method`, so keying off their
 * absence separates the two without weakening the protocol path.
 */
export function isJsonRpcRequest(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const bag = body as Record<string, unknown>;
  return typeof bag.jsonrpc === "string" || typeof bag.method === "string";
}

/**
 * The Express call a bare POST body represents, or null if this is not one.
 *
 * Deliberately permissive about the fields: `normaliseExpressArgs` already maps
 * a flat bag onto the single job type Express sells, so anything object-shaped
 * that is not JSON-RPC is treated as a purchase attempt and answered with a 402.
 * Answering "here is the price" is always safe — no work happens and no money
 * moves until a valid payment arrives.
 */
export function directExpressCall(body: unknown): ExpressArgs | null {
  if (isJsonRpcRequest(body)) return null;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return normaliseExpressArgs(body);
}

/** Job types Express sells, from the environment. */
export function expressJobTypes(): string[] {
  return (process.env.EXPRESS_JOB_TYPES ?? "market_snapshot")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export type ExpressArgs = { job_type: string; params: Record<string, unknown> };

export const SUPPORTED_MARKET_SYMBOLS = ["BTC", "ETH"] as const;
export const SUPPORTED_MARKET_TIMEFRAMES = ["1h", "2h", "4h", "1d"] as const;

const supportedSymbols = new Set<string>(SUPPORTED_MARKET_SYMBOLS);
const supportedTimeframes = new Set<string>(SUPPORTED_MARKET_TIMEFRAMES);

/**
 * What a buyer must POST, declared in the 402 challenge itself.
 *
 * The enums are the SAME constants `expressInputFailure` validates against, not
 * a restatement of them. They were restated once and drifted: the challenge
 * advertised twelve timeframes (`1m` … `1w`) while the endpoint accepted four.
 * A machine buyer reading the schema would have requested `15m`, been refused,
 * and reasonably concluded the service does not do what it advertises — the
 * exact impression a reviewer forms right before a rejection. Deriving both
 * from one constant makes that drift unrepresentable, and the test below pins
 * it so a future edit to one cannot silently miss the other.
 *
 * `type: "http"` and `method: "POST"` matter as much as the field list. Buyer
 * tooling probes GET by default; with no declared method an automated buyer
 * never learns how to call the paid endpoint, which surfaces as "paid replay
 * returned no content" rather than as a schema problem.
 *
 * Lives here rather than in server.ts so it can be tested without importing a
 * module that binds a port at import time.
 */
export const EXPRESS_HTTP_INPUT = {
  type: "http",
  method: "POST",
  bodyType: "json",
  body: {
    type: "object",
    required: ["symbol", "timeframe", "prompt"],
    properties: {
      symbol: {
        type: "string",
        enum: [...SUPPORTED_MARKET_SYMBOLS],
        description: "Crypto base symbol"
      },
      timeframe: { type: "string", enum: [...SUPPORTED_MARKET_TIMEFRAMES] },
      prompt: {
        type: "string",
        description: "Requested market-analysis focus, e.g. price, trend, support, resistance"
      }
    }
  }
} as const;

/** A free, deterministic precondition check run before any authorization settles. */
export function expressInputFailure(call: ExpressArgs): string | null {
  if (call.job_type !== "market_snapshot") return `unsupported Express job type ${call.job_type}`;
  const symbol = call.params.symbol;
  const timeframe = call.params.timeframe;
  const prompt = call.params.prompt;
  if (typeof symbol !== "string" || !symbol.trim()) return "symbol is required";
  const normalisedSymbol = symbol.trim().toUpperCase().replace(/(?:-|\/)USDT$/, "");
  if (!supportedSymbols.has(normalisedSymbol)) {
    return `unsupported symbol ${JSON.stringify(symbol)}; supported: ${SUPPORTED_MARKET_SYMBOLS.join(", ")}`;
  }
  if (typeof timeframe !== "string" || !timeframe.trim()) return "timeframe is required";
  if (!supportedTimeframes.has(timeframe.trim().toLowerCase())) {
    return `unsupported timeframe ${JSON.stringify(timeframe)}; supported: ${SUPPORTED_MARKET_TIMEFRAMES.join(", ")}`;
  }
  if (typeof prompt !== "string" || !prompt.trim()) return "prompt is required";
  const supportedFocus = ["price", "trend", "support", "resistance", "market", "snapshot", "technical"];
  if (!supportedFocus.some((term) => prompt.toLowerCase().includes(term))) {
    return "prompt must request a market or technical snapshot";
  }
  return null;
}

export function normaliseExpressArgs(args: unknown): ExpressArgs | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const bag = args as Record<string, unknown>;

  if (typeof bag.job_type === "string" && bag.job_type.length > 0) {
    const params = bag.params;
    return {
      job_type: bag.job_type,
      params: typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {}
    };
  }

  // No job_type. Inferring is only safe when we sell exactly one, which is the
  // deliberate listing shape. Guessing across several would mean deciding for
  // the buyer what they meant to purchase — a worse failure than asking.
  const types = expressJobTypes();
  if (types.length !== 1) return null;

  const { params, job_type: _ignored, ...rest } = bag;
  return {
    job_type: types[0],
    params: {
      ...(typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {}),
      ...rest
    }
  };
}
