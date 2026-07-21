/**
 * Pre-payment vendor vetting: an unpaid probe that reads a vendor's 402 and
 * reports what it would actually cost to hire them.
 *
 * This module MUST NOT import the signer, and must never produce a signature.
 * Everything here is free: it sends one unpaid request, reads the challenge the
 * vendor answers with, and throws the challenge away. `vet.test.ts` pins the
 * absence of a signer import so a future edit cannot quietly make vetting
 * spend money.
 *
 * Why it exists: probing the 10 cheapest market_snapshot agents by hand (see
 * data/vendor-reliability-2026-07-21.json) found 4 of 10 dead or misrouted at
 * their listed endpoint, and 2 of 6 live ones charging a different price than
 * they advertise — one by 600x. A buyer's listing is a claim; the 402 is the
 * fact. This turns that one-off research into something the worker can run
 * against any candidate list before it commits money.
 *
 * IMPORTANT: a `hireable: true` verdict is advisory and NOT an authorisation.
 * The vendor can change its price between the probe and the call, so the cap
 * check in vendor.ts still runs against the amount in the challenge we actually
 * sign. Vetting narrows the candidate list; it never widens what may be paid.
 */

import { declaredDecimals, parseChallenge, selectOffer, SelectedOffer, X402Error } from "./x402.js";
import { toolUrl } from "./vendor.js";

export type VetVerdict =
  /** Live, x402-conformant, and priced at or below its listing. */
  | "X402_OK"
  /** Live and conformant, but the live 402 asks for more than the listing says. */
  | "PRICE_MISMATCH"
  /** Live and conformant, but the live price exceeds the caller's ceiling. */
  | "OVER_BUDGET"
  /** Answered 200 without charging. Free, and still hireable. */
  | "NO_CHARGE"
  /** A 402 we cannot sign: aggr_deferred-only, or priced on a foreign decimal scale. */
  | "UNSUPPORTED_CHALLENGE"
  /** Reachable, but the listed endpoint does not serve this tool (typically 404). */
  | "HTTP_ERROR"
  /** No answer at all: DNS failure, connection refused, or timeout. */
  | "UNREACHABLE";

export type MoneyLike = { amount: string; decimals: number; token: string };

export type VetRequest = {
  vendorEndpoint: string;
  tool: string;
  args?: Record<string, unknown>;
  /** What the marketplace index says this costs, if known. Enables PRICE_MISMATCH. */
  listedAmount?: MoneyLike;
  /** The caller's ceiling for this subtask, if known. Enables OVER_BUDGET. */
  maxAmount?: MoneyLike;
};

export type VetResult = {
  vendor_endpoint: string;
  tool: string;
  verdict: VetVerdict;
  /** Whether this candidate is worth spending money on. Advisory only. */
  hireable: boolean;
  detail: string;
  latency_ms: number;
  /** The price the vendor's live 402 actually demands, in its own base units. */
  live_amount: MoneyLike | null;
  listed_amount: MoneyLike | null;
  /** live / listed. 600 means the vendor charges 600x what it advertises. */
  price_ratio: number | null;
  scheme: string | null;
  network: string | null;
  asset: string | null;
  declared_decimals: number | null;
  pay_to: string | null;
  /** Every scheme the vendor offered, not just the one we would sign. */
  schemes_offered: string[];
  /**
   * How many probes it took to get an answer. >1 means the first attempt failed
   * at the network level and a retry succeeded — the vendor is flaky, not dead.
   */
  attempts: number;
};

function headerBag(response: Response): Record<string, string | undefined> {
  const bag: Record<string, string | undefined> = {};
  response.headers.forEach((value, name) => {
    bag[name.toLowerCase()] = value;
  });
  return bag;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function unitsOf(money: MoneyLike | undefined): number | null {
  if (!money) return null;
  const parsed = Number(money.amount);
  return Number.isFinite(parsed) ? parsed : null;
}

function base(request: VetRequest, latencyMs: number): VetResult {
  return {
    vendor_endpoint: request.vendorEndpoint,
    tool: request.tool,
    verdict: "UNREACHABLE",
    hireable: false,
    detail: "",
    latency_ms: latencyMs,
    live_amount: null,
    listed_amount: request.listedAmount ?? null,
    price_ratio: null,
    scheme: null,
    network: null,
    asset: null,
    declared_decimals: null,
    pay_to: null,
    schemes_offered: [],
    attempts: 0
  };
}

/**
 * Probe one vendor without paying. Never throws for vendor-side problems: a
 * dead vendor is a verdict, not an exception, because the caller is vetting a
 * list and one corpse must not abort the batch.
 */
export async function vetVendor(
  request: VetRequest,
  options: { timeoutMs?: number; allowedAssets?: string[]; attempts?: number } = {}
): Promise<VetResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxAttempts = Math.max(1, options.attempts ?? 2);
  const url = toolUrl(request.vendorEndpoint, request.tool);
  const started = Date.now();

  // Retry ONLY network-level failures, and only those. A 402 or a 404 is a
  // definitive answer and gets one shot. This exists because SignalForge #6560
  // failed one probe and answered the next two: cold-starting containers are
  // common on free hosting, and condemning a live vendor on a single timeout is
  // exactly the kind of false accusation the validator bug already taught us to
  // avoid. `attempts` is reported so a flaky vendor stays visibly flaky.
  let response: Response | null = null;
  let lastError = "";
  let attempts = 0;

  while (attempts < maxAttempts && response === null) {
    attempts++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.args ?? {}),
        signal: controller.signal
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
  }

  if (response === null) {
    const failed = base(request, Date.now() - started);
    failed.verdict = "UNREACHABLE";
    failed.attempts = attempts;
    failed.detail = `${lastError} (${attempts} attempt${attempts === 1 ? "" : "s"})`;
    return failed;
  }

  const result = base(request, Date.now() - started);
  result.attempts = attempts;

  // A vendor that serves without charging is not broken; it is free.
  if (response.status === 200) {
    result.verdict = "NO_CHARGE";
    result.hireable = true;
    result.detail = "vendor served without issuing a payment challenge";
    result.live_amount = { amount: "0", decimals: request.listedAmount?.decimals ?? 6, token: request.listedAmount?.token ?? "USDT" };
    return result;
  }

  if (response.status !== 402) {
    result.verdict = "HTTP_ERROR";
    result.detail = `listed endpoint returned HTTP ${response.status}: ${JSON.stringify(await readBody(response)).slice(0, 300)}`;
    return result;
  }

  let offer: SelectedOffer;
  let accepts: ReturnType<typeof parseChallenge>["accepts"];
  try {
    const challenge = parseChallenge(headerBag(response), await readBody(response));
    accepts = challenge.accepts;
    offer = selectOffer(challenge, { allowedAssets: options.allowedAssets });
  } catch (error) {
    if (error instanceof X402Error) {
      result.verdict = "UNSUPPORTED_CHALLENGE";
      result.detail = error.message;
      return result;
    }
    throw error;
  }

  result.schemes_offered = accepts.map((entry) => String(entry.scheme ?? "unknown"));
  result.scheme = offer.scheme;
  result.network = offer.network;
  result.asset = offer.asset;
  result.pay_to = offer.payTo;
  result.declared_decimals = offer.declaredDecimals;

  // Decimals first. Comparing base units across different scales is the one
  // error that fails in the permissive direction, so it disqualifies the
  // candidate before any price comparison is attempted on those units.
  const callerDecimals = request.maxAmount?.decimals ?? request.listedAmount?.decimals ?? null;
  if (offer.declaredDecimals !== null && callerDecimals !== null && offer.declaredDecimals !== callerDecimals) {
    result.verdict = "UNSUPPORTED_CHALLENGE";
    result.detail =
      `vendor prices in ${offer.declaredDecimals} decimals but the caller's amounts are in ${callerDecimals}; ` +
      "base units are not comparable across scales";
    return result;
  }

  const decimals = offer.declaredDecimals ?? callerDecimals ?? 6;
  result.live_amount = {
    amount: String(offer.amountUnits),
    decimals,
    token: request.listedAmount?.token ?? "USDT"
  };

  const listedUnits = unitsOf(request.listedAmount);
  if (listedUnits !== null && listedUnits > 0) {
    result.price_ratio = Number((offer.amountUnits / listedUnits).toFixed(4));
  }

  const ceilingUnits = unitsOf(request.maxAmount);
  if (ceilingUnits !== null && offer.amountUnits > ceilingUnits) {
    result.verdict = "OVER_BUDGET";
    result.detail = `live price ${offer.amountUnits} exceeds the ceiling ${ceilingUnits} for this subtask`;
    return result;
  }

  if (listedUnits !== null && offer.amountUnits > listedUnits) {
    // Still hireable if it fits the ceiling — the buyer's budget is what binds,
    // not the marketplace listing. But it is recorded, because a vendor whose
    // listing lies is a vendor whose other claims deserve less weight.
    result.verdict = "PRICE_MISMATCH";
    result.hireable = ceilingUnits !== null;
    result.detail = `listed ${listedUnits} but the live 402 demands ${offer.amountUnits} (${result.price_ratio}x)`;
    return result;
  }

  result.verdict = "X402_OK";
  result.hireable = true;
  result.detail = `live and conformant at ${offer.amountUnits} base units via ${offer.scheme}`;
  return result;
}

/**
 * Vet a candidate list concurrently. Bounded because a plan can carry dozens of
 * candidates and we are hitting third-party endpoints we do not own.
 */
export async function vetVendors(
  requests: VetRequest[],
  options: { timeoutMs?: number; allowedAssets?: string[]; concurrency?: number; attempts?: number } = {}
): Promise<VetResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const results: VetResult[] = new Array(requests.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= requests.length) return;
      results[index] = await vetVendor(requests[index], options);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, worker));
  return results;
}
