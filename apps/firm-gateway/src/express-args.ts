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

/** Job types Express sells, from the environment. */
export function expressJobTypes(): string[] {
  return (process.env.EXPRESS_JOB_TYPES ?? "market_snapshot")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export type ExpressArgs = { job_type: string; params: Record<string, unknown> };

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
