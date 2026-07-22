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
  /** base64 of the challenge exactly as the vendor sent it. */
  payloadBase64: string;
  /** The decoded envelope, kept so a single-offer payload can preserve `resource`. */
  envelope: Record<string, unknown>;
  accepts: AcceptsEntry[];
};

export type SelectedOffer = {
  /** 0-based index into the vendor's original `accepts[]`. Recorded, not passed. */
  acceptsIndex: number;
  entry: AcceptsEntry;
  /** Price in base units. The only number the cap checks ever see. */
  amountUnits: number;
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  /**
   * Decimals the vendor declared for its asset, or null when it declared none.
   *
   * This matters more than it looks. Every cap comparison is raw base-unit
   * integer arithmetic, which is only meaningful when both sides share a
   * decimal scale. 15 units of a 6-decimal token and 15 units of an 18-decimal
   * token differ by a factor of a trillion, so comparing the vendor's price
   * against a max_amount on a different scale would authorise a payment
   * astronomically larger than the caller intended.
   */
  declaredDecimals: number | null;
};

/**
 * Schemes a local hex key can sign. `aggr_deferred` needs a TEE-resident
 * session key, which the procurer does not have, so an aggr_deferred-only
 * vendor is a hard stop rather than a silent fallback to some other entry the
 * human never approved.
 */
export const LOCAL_SIGNABLE_SCHEMES = ["exact", "upto"] as const;

/**
 * What a signer returns: a ready-to-send header, plus the facts worth recording.
 *
 * Lives here rather than beside an implementation so the payment flow depends on
 * the protocol shape, not on how the signature happens to be produced.
 */
export type SignedPayment = {
  headerName: string;
  headerValue: string;
  scheme: string;
  wallet?: string;
};

export type Signer = (challenge: X402Challenge, offer: SelectedOffer) => Promise<SignedPayment>;

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
      envelope: decoded as unknown as Record<string, unknown>,
      accepts: decoded.accepts
    };
  }

  if (isAcceptsPayload(body)) {
    return {
      version: Number(body.x402Version) || 1,
      payloadBase64: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
      envelope: body as unknown as Record<string, unknown>,
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

  // Every cap comparison downstream is a JS number. Past 2^53-1 those stop
  // being exact, so `Number(raw)` would quietly hand the caps a value that is
  // not the amount the vendor asked for — and the signature covers the vendor's
  // original string, not our rounded copy.
  //
  // At 6 decimals this is unreachable (9e9 USDT). At 18 it is 0.009 tokens, so
  // it stops being theoretical the moment anyone adds an 18-decimal asset.
  // Refusing costs nothing today and removes the class; converting the whole
  // money path to bigint is the real fix and not a three-days-out change.
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new X402Error(
      "UNSUPPORTED_CHALLENGE",
      `accepts entry price ${raw} exceeds the safe integer range; refusing rather than comparing a rounded amount`
    );
  }
  return value;
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
  options: { allowedAssets?: string[]; allowedNetworks?: string[] } = {}
): SelectedOffer {
  if (challenge.accepts.length === 0) {
    throw new X402Error("UNSUPPORTED_CHALLENGE", "challenge carried an empty accepts[] array");
  }

  // Both allow-lists filter *before* the cheapest entry is chosen, rather than
  // checking the winner afterwards. A challenge that offers a disallowed asset
  // alongside an allowed one should be payable on the allowed one; rejecting
  // the whole challenge because the cheapest entry happened to be the bad one
  // would refuse business we can legitimately do.
  //
  // The network list matters as much as the asset list. "15 units of token X"
  // means nothing without knowing which chain token X is on: an attacker who
  // deploys a contract at a familiar-looking address on a chain we never meant
  // to touch gets a signature for an asset we never meant to hold.
  const allowed = options.allowedAssets?.map((asset) => asset.toLowerCase());
  const networks = options.allowedNetworks?.map((network) => network.toLowerCase());
  const candidates = challenge.accepts
    .map((entry, acceptsIndex) => ({ entry, acceptsIndex }))
    .filter(({ entry }) => LOCAL_SIGNABLE_SCHEMES.includes(String(entry.scheme) as never))
    .filter(({ entry }) => !allowed || allowed.includes(String(entry.asset).toLowerCase()))
    .filter(({ entry }) => !networks || networks.includes(String(entry.network).toLowerCase()));

  if (candidates.length === 0) {
    const offered = challenge.accepts
      .map((entry) => `${entry.scheme}/${entry.asset}@${entry.network}`)
      .join(", ");
    throw new X402Error(
      "UNSUPPORTED_CHALLENGE",
      `no accepts entry is locally signable (${LOCAL_SIGNABLE_SCHEMES.join("|")}), asset-allowed and network-allowed; vendor offered: ${offered}`
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
    payTo: String(best.entry.payTo ?? ""),
    declaredDecimals: declaredDecimals(best.entry)
  };
}

/**
 * The payload handed to the signer: the vendor's envelope with `accepts`
 * narrowed to the single entry we selected and verified against the caps.
 *
 * `onchainos payment pay-local` has no `--selected-index` — that flag exists
 * only on the TEE `payment pay` path. Left to itself the CLI auto-selects an
 * entry by its own rule, which is not necessarily the entry whose amount we
 * just checked against the caps. On a challenge offering two `exact` entries at
 * different prices, we could verify the cheap one and have the CLI sign the
 * expensive one.
 *
 * Narrowing to one entry removes the choice entirely, so the signature can only
 * ever cover the offer that passed the cap check. The signature itself is over
 * the payment fields, not over the accepts array, so the vendor accepts a header
 * derived from the narrowed payload exactly as it would the full one.
 */
export function payloadForOffer(challenge: X402Challenge, offer: SelectedOffer): string {
  const narrowed = { ...challenge.envelope, accepts: [offer.entry] };
  return Buffer.from(JSON.stringify(narrowed), "utf8").toString("base64");
}

/** The vendor's declared decimals for its asset, or null if it declared none. */
export function declaredDecimals(entry: AcceptsEntry): number | null {
  const raw = (entry.extra as Record<string, unknown> | undefined)?.decimals;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return null;
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
