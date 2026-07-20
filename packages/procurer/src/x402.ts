/**
 * x402 challenge parsing and scheme selection.
 *
 * Pure functions only: no network, no signing, no wallet. Everything here is
 * unit-tested, because this is the code that decides how much money leaves the
 * Firm wallet.
 *
 * Verified against the OKX Agent Payments Protocol buyer surface (onchainos
 * 4.2.6, `payment pay-local --payload`) on 2026-07-20:
 *   - v2: HTTP 402 carries a `PAYMENT-REQUIRED` response header holding
 *     base64 JSON `{x402Version, resource, accepts[]}`; the accepts entry's
 *     price field is `amount`.
 *   - v1: HTTP 402 carries the same JSON in the response *body*; the accepts
 *     entry's price field is `maxAmountRequired`.
 * See docs/status/F1.md for the recorded buyer-flow shape.
 */

export type AcceptsEntry = {
  scheme?: string;
  network?: string;
  asset?: string;
  payTo?: string;
  amount?: string;
  maxAmountRequired?: string;
  maxTimeoutSeconds?: number;
  resource?: string;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
};

export type X402Challenge = {
  version: number;
  /** base64 payload handed verbatim to `onchainos payment pay-local --payload`. */
  payloadBase64: string;
  accepts: AcceptsEntry[];
};

export type SelectedOffer = {
  /** 0-based index into `accepts[]`; passed as `--selected-index`. */
  acceptsIndex: number;
  entry: AcceptsEntry;
  /** Price in base units. The only number the cap checks ever see. */
  amountUnits: number;
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
};

/**
 * `pay-local` signs with a local hex key and supports exactly these schemes.
 * `aggr_deferred` needs a TEE-resident session key, which the procurer does not
 * have, so an aggr_deferred-only vendor is a hard stop rather than a silent
 * fallback to some other entry the human never approved.
 */
export const LOCAL_SIGNABLE_SCHEMES = ["exact", "upto"] as const;

export class X402Error extends Error {
  constructor(
    readonly errorCode: "UNSUPPORTED_CHALLENGE" | "PAYMENT_FAILED",
    message: string
  ) {
    super(message);
    this.name = "X402Error";
  }
}

function decodeBase64Json(value: string): unknown {
  // Accept base64url as well; the protocol permits either.
  const normalised = value.trim().replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(Buffer.from(normalised, "base64").toString("utf8"));
}

function isAcceptsPayload(value: unknown): value is { x402Version: number; accepts: AcceptsEntry[] } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return "x402Version" in candidate && Array.isArray(candidate.accepts);
}

/**
 * Detect an x402 challenge on a 402 response.
 *
 * Priority follows the protocol dispatcher: `PAYMENT-REQUIRED` header (v2)
 * before a body-carried payload (v1). Returns null when the response is a 402
 * but not a shape we can sign — the caller must surface that, never guess.
 */
export function parseChallenge(headers: Record<string, string | undefined>, body: unknown): X402Challenge {
  const headerValue = headers["payment-required"];
  if (headerValue) {
    const decoded = decodeBase64Json(headerValue);
    if (!isAcceptsPayload(decoded)) {
      throw new X402Error("UNSUPPORTED_CHALLENGE", "PAYMENT-REQUIRED header did not decode to an accepts payload");
    }
    return {
      version: Number(decoded.x402Version) || 2,
      payloadBase64: headerValue.trim(),
      accepts: decoded.accepts
    };
  }

  if (isAcceptsPayload(body)) {
    return {
      version: Number(body.x402Version) || 1,
      payloadBase64: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
      accepts: body.accepts
    };
  }

  throw new X402Error(
    "UNSUPPORTED_CHALLENGE",
    "vendor returned HTTP 402 without a PAYMENT-REQUIRED header or an x402Version body; cannot sign this shape"
  );
}

function priceUnits(entry: AcceptsEntry): number {
  // v2 uses `amount`, v1 uses `maxAmountRequired`. Both are base-unit strings.
  const raw = entry.amount ?? entry.maxAmountRequired;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new X402Error(
      "UNSUPPORTED_CHALLENGE",
      `accepts entry has no base-unit integer price (amount/maxAmountRequired), got ${JSON.stringify(raw)}`
    );
  }
  return Number(raw);
}

/**
 * Pick the accepts entry to sign.
 *
 * Deterministic and conservative:
 *   1. drop schemes `pay-local` cannot sign,
 *   2. drop assets outside the allow-list when one is configured,
 *   3. cheapest remaining entry wins; ties break toward the lower index.
 *
 * Cheapest-wins is a spend-minimising rule, not a quality judgment — every
 * surviving entry buys the same resource, so the only thing left to compare is
 * price. Recorded in docs/status/F1.md as a decision open to a human override.
 */
export function selectOffer(
  challenge: X402Challenge,
  options: { allowedAssets?: string[] } = {}
): SelectedOffer {
  if (challenge.accepts.length === 0) {
    throw new X402Error("UNSUPPORTED_CHALLENGE", "challenge carried an empty accepts[] array");
  }

  const allowed = options.allowedAssets?.map((asset) => asset.toLowerCase());
  const candidates = challenge.accepts
    .map((entry, acceptsIndex) => ({ entry, acceptsIndex }))
    .filter(({ entry }) => LOCAL_SIGNABLE_SCHEMES.includes(String(entry.scheme) as never))
    .filter(({ entry }) => !allowed || allowed.includes(String(entry.asset).toLowerCase()));

  if (candidates.length === 0) {
    const offered = challenge.accepts.map((entry) => `${entry.scheme}/${entry.asset}`).join(", ");
    throw new X402Error(
      "UNSUPPORTED_CHALLENGE",
      `no accepts entry is both locally signable (${LOCAL_SIGNABLE_SCHEMES.join("|")}) and asset-allowed; vendor offered: ${offered}`
    );
  }

  let best = candidates[0];
  let bestUnits = priceUnits(best.entry);
  for (const candidate of candidates.slice(1)) {
    const units = priceUnits(candidate.entry);
    if (units < bestUnits) {
      best = candidate;
      bestUnits = units;
    }
  }

  return {
    acceptsIndex: best.acceptsIndex,
    entry: best.entry,
    amountUnits: bestUnits,
    scheme: String(best.entry.scheme),
    network: String(best.entry.network ?? ""),
    asset: String(best.entry.asset ?? ""),
    payTo: String(best.entry.payTo ?? "")
  };
}

/**
 * Assemble the legacy v1 `X-PAYMENT` header from the raw proof the signer
 * returns for a v1 payload. v2 payloads come back pre-assembled as
 * `PAYMENT-SIGNATURE` and never reach here.
 */
export function assembleV1PaymentHeader(
  offer: SelectedOffer,
  proof: { signature: unknown; authorization: unknown }
): string {
  const payload = {
    x402Version: 1,
    scheme: offer.scheme,
    network: offer.network,
    payload: { signature: proof.signature, authorization: proof.authorization }
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/** Decode a `PAYMENT-RESPONSE` header into the settlement facts, or null. */
export function decodePaymentResponse(headerValue: string | undefined): Record<string, unknown> | null {
  if (!headerValue) return null;
  try {
    const decoded = decodeBase64Json(headerValue);
    return typeof decoded === "object" && decoded !== null ? (decoded as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
