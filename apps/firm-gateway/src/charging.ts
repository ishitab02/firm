/**
 * Seller-side x402 charging.
 *
 * The gateway is the paid boundary: `execute` and `express_run` must be
 * unreachable without a settled payment. This module decides that, and it is
 * deliberately the only thing standing between an inbound request and the
 * first database write.
 *
 * What it does NOT do: hold a key, or move money. Charging is a challenge and
 * a verification, both of which are key-free. The Firm's wallet stays in
 * packages/procurer.
 *
 * TODO(unverified): the facilitator verification endpoint is not confirmed. Until
 * a human supplies X402_FACILITATOR_URL, `verifyPayment` fails closed — an
 * unverifiable payment is treated exactly like no payment. Recorded in
 * docs/status/F2.md.
 */

import { okxCredentialsFromEnv, signOkxRequest, splitForSigning } from "./okx-auth.js";

/**
 * Headers for a facilitator call: signed when OKX credentials are configured,
 * bare otherwise.
 *
 * Bare is correct for the local fake facilitator the tests run against, and it
 * is what keeps the existing suite meaningful. Against the real facilitator an
 * unsigned call is rejected — which fails closed, so the worst case is a 402 to
 * the buyer rather than free work.
 */
function facilitatorHeaders(url: string, body: string): Record<string, string> {
  const credentials = okxCredentialsFromEnv();
  if (!credentials) return { "content-type": "application/json" };
  const { requestPath } = splitForSigning(url);
  return signOkxRequest(credentials, { method: "POST", requestPath, body });
}

export type ChargeSpec = {
  /** Base-unit integer string. */
  amount: string;
  decimals: number;
  /** Token contract address on `network`. */
  asset: string;
  /** CAIP-2, e.g. eip155:196. */
  network: string;
  payTo: string;
  resource: string;
  description: string;
};

/**
 * Join a facilitator base URL with a route, preserving any path on the base.
 *
 * `new URL("/verify", "https://host/api/v6/pay/x402")` returns
 * `https://host/verify` — a leading slash resets to the root and silently drops
 * the prefix. OKX's facilitator lives under `/api/v6/pay/x402`, so the naive
 * join pointed every verify and settle call at a path that does not exist, and
 * the failure would have looked like "the facilitator rejected us" rather than
 * "we called the wrong URL".
 */
export function facilitatorUrlFor(base: string, route: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}/${route.replace(/^\//, "")}`;
}

export type PaymentRequirements = {
  x402Version: number;
  accepts: Array<Record<string, unknown>>;
};

export class ChargingNotConfigured extends Error {}

/**
 * Where the Firm gets paid. Every field is required and none is guessed: an
 * unset value is a hard failure, not a default, because a wrong payTo sends the
 * user's money to a stranger.
 */
export function sellerConfigFromEnv() {
  const payTo = process.env.FIRM_PAYTO_ADDRESS;
  const asset = process.env.FIRM_CHARGE_ASSET;
  const network = process.env.FIRM_CHARGE_NETWORK;
  if (!payTo || !asset || !network) {
    throw new ChargingNotConfigured(
      "FIRM_PAYTO_ADDRESS, FIRM_CHARGE_ASSET and FIRM_CHARGE_NETWORK must all be set before the gateway can charge"
    );
  }
  return { payTo, asset, network, facilitatorUrl: process.env.X402_FACILITATOR_URL };
}

/** Build the `accepts` payload for a 402 response. */
export function buildRequirements(spec: ChargeSpec): PaymentRequirements {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: spec.network,
        amount: spec.amount,
        maxAmountRequired: spec.amount,
        asset: spec.asset,
        payTo: spec.payTo,
        resource: spec.resource,
        description: spec.description,
        mimeType: "application/json",
        maxTimeoutSeconds: Number(process.env.CHARGE_TIMEOUT_SECONDS ?? 120),
        outputSchema: { input: { type: "object" }, output: { type: "object" } },
        extra: { decimals: spec.decimals }
      }
    ]
  };
}

export function encodeRequirements(requirements: PaymentRequirements): string {
  return Buffer.from(JSON.stringify(requirements), "utf8").toString("base64");
}

export type VerifyResult =
  | { ok: true; payer?: string; transaction?: string; amount?: string; raw: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Verify a buyer's payment header against the facilitator.
 *
 * Fails closed in every uncertain case. There is no branch here that returns
 * `ok: true` without a facilitator having said so.
 */
export async function verifyPayment(
  headerValue: string | undefined,
  requirements: PaymentRequirements,
  options: { facilitatorUrl?: string; timeoutMs?: number } = {}
): Promise<VerifyResult> {
  if (!headerValue) return { ok: false, reason: "no payment header on the request" };
  if (!options.facilitatorUrl) {
    return {
      ok: false,
      reason: "X402_FACILITATOR_URL is not configured; cannot verify a payment and will not assume one"
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const url = facilitatorUrlFor(options.facilitatorUrl, "verify");
    // Serialise once and sign that exact string: re-serialising can reorder
    // keys and invalidate the signature.
    const body = JSON.stringify({ paymentHeader: headerValue, paymentRequirements: requirements.accepts[0] });
    const response = await fetch(url, {
      method: "POST",
      headers: facilitatorHeaders(url, body),
      body,
      signal: controller.signal
    });
    if (!response.ok) {
      return { ok: false, reason: `facilitator returned HTTP ${response.status}` };
    }
    const raw = (await response.json()) as Record<string, unknown>;
    const valid = raw.isValid === true || raw.valid === true || raw.status === "success";
    if (!valid) {
      const reason = raw.invalidReason ?? raw.reason ?? raw.error ?? "facilitator rejected the payment";
      return { ok: false, reason: String(reason) };
    }
    return {
      ok: true,
      payer: typeof raw.payer === "string" ? raw.payer : undefined,
      transaction: typeof raw.transaction === "string" ? raw.transaction : undefined,
      amount: typeof raw.amount === "string" ? raw.amount : undefined,
      raw
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `facilitator verification failed: ${detail}` };
  } finally {
    clearTimeout(timer);
  }
}

export type SettleResult =
  | {
      ok: true;
      transaction: string;
      payer?: string;
      amount?: string;
      /** CAIP-2 chain the settlement landed on, when the facilitator says. */
      network?: string;
      raw: Record<string, unknown>;
    }
  | { ok: false; reason: string };

/**
 * Redeem a verified authorization. This is the step that actually moves money.
 *
 * `verify` only answers "is this signature cryptographically valid for these
 * requirements". It does not broadcast anything, so a gateway that stops after
 * verifying has served a paid request for free — the buyer's authorization sits
 * unredeemed and expires. Settlement is what submits it.
 *
 * The Firm has a sharper reason than most sellers to settle BEFORE fulfilling:
 * fulfilling costs us real money, because we pay vendors out of our own wallet.
 * Verifying, spending on vendors, and only then discovering that settlement
 * fails would mean absorbing the whole job for a buyer who never paid.
 *
 * Fails closed, and specifically refuses to report success without a
 * transaction reference: "settled, no idea what the tx was" is indistinguishable
 * from "not settled", and the receipt would be asserting a payment we cannot
 * evidence.
 *
 * TODO(unverified): the facilitator's settle route and body shape are not
 * confirmed against the real OKX facilitator — only against the local fake.
 * X402_FACILITATOR_URL gates the whole path; recorded in docs/status/F2.md.
 */
export async function settlePayment(
  headerValue: string | undefined,
  requirements: PaymentRequirements,
  options: { facilitatorUrl?: string; timeoutMs?: number } = {}
): Promise<SettleResult> {
  if (!headerValue) return { ok: false, reason: "no payment header to settle" };
  if (!options.facilitatorUrl) {
    return {
      ok: false,
      reason: "X402_FACILITATOR_URL is not configured; cannot settle a payment and will not assume one"
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const url = facilitatorUrlFor(options.facilitatorUrl, "settle");
    const body = JSON.stringify({ paymentHeader: headerValue, paymentRequirements: requirements.accepts[0] });
    const response = await fetch(url, {
      method: "POST",
      headers: facilitatorHeaders(url, body),
      body,
      signal: controller.signal
    });
    if (!response.ok) {
      return { ok: false, reason: `facilitator settle returned HTTP ${response.status}` };
    }
    const raw = (await response.json()) as Record<string, unknown>;
    const settled = raw.success === true || raw.status === "success" || raw.settled === true;
    if (!settled) {
      const reason = raw.errorReason ?? raw.invalidReason ?? raw.reason ?? raw.error ?? "facilitator did not settle";
      return { ok: false, reason: String(reason) };
    }

    const transaction = raw.transaction ?? raw.txHash ?? raw.tx_hash;
    if (typeof transaction !== "string" || transaction.length === 0) {
      return { ok: false, reason: "facilitator reported settlement without a transaction reference" };
    }

    return {
      ok: true,
      transaction,
      payer: typeof raw.payer === "string" ? raw.payer : undefined,
      amount: typeof raw.amount === "string" ? raw.amount : undefined,
      network: typeof raw.network === "string" ? raw.network : undefined,
      raw
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `facilitator settlement failed: ${detail}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Read the buyer's payment header under either the v2 or the legacy v1 name. */
export function paymentHeaderFrom(headers: Record<string, string | string[] | undefined>): string | undefined {
  const value = headers["payment-signature"] ?? headers["x-payment"];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Encode a settlement result for the `PAYMENT-RESPONSE` response header.
 *
 * Takes a settlement, not a verification. The previous version took a verify
 * result and emitted `status: "success"` with whatever transaction field the
 * verify response happened to carry — usually none, because verification does
 * not produce a transaction. That header asserted a settled payment that had
 * not settled.
 */
export function encodeSettlement(result: Extract<SettleResult, { ok: true }>): string {
  return Buffer.from(
    JSON.stringify({
      // Real ASPs on this marketplace emit `success: true`, not
      // `status: "success"` — verified by decoding the PAYMENT-RESPONSE headers
      // OKLink #2023 returned for the G1 and G2 payments:
      //   {"success":true,"transaction":"0x…","network":"eip155:196","payer":"0x…"}
      // We emit both, because a buyer written against the marketplace's actual
      // convention would read a status-only header as an unsettled payment.
      success: true,
      status: "success",
      transaction: result.transaction,
      network: result.network ?? "",
      payer: result.payer ?? "",
      amount: result.amount ?? ""
    }),
    "utf8"
  ).toString("base64");
}
