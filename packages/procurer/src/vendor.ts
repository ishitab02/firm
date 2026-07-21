/**
 * Buyer-side pay-and-call against a vendor endpoint.
 *
 * Order of operations is load-bearing and must not be rearranged:
 *   probe -> parse 402 -> select offer -> VERIFY CAPS -> sign -> replay.
 * The cap verification callback runs before the signer is ever constructed, so
 * there is no code path that pays first and checks later.
 */

import { decodePaymentResponse, parseChallenge, selectOffer, SelectedOffer, X402Error } from "./x402.js";
import { Signer } from "./signer.js";

export type VendorCallRequest = {
  vendorEndpoint: string;
  tool: string;
  args: Record<string, unknown>;
};

export type VendorCallOutcome =
  | {
      ok: true;
      result: unknown;
      receipt: {
        amount: { amount: string; decimals: number; token: string };
        tx: string;
        payment_response: string;
        scheme?: string;
        network?: string;
        asset?: string;
        declared_decimals?: number | null;
        pay_to?: string;
        settlement?: Record<string, unknown> | null;
      };
      latency_ms: number;
    }
  | {
      ok: false;
      error_code: "VENDOR_TIMEOUT" | "PAYMENT_FAILED" | "CAP_EXCEEDED" | "VENDOR_ERROR" | "UNSUPPORTED_CHALLENGE";
      detail: string;
    };

/**
 * Returns null to approve the spend, or a reason to abort before any signature
 * is produced. Every rejection from here is reported as CAP_EXCEEDED.
 */
export type CapVerifier = (offer: SelectedOffer) => Promise<{ detail: string } | null>;

function headerBag(response: Response): Record<string, string | undefined> {
  const bag: Record<string, string | undefined> = {};
  response.headers.forEach((value, name) => {
    bag[name.toLowerCase()] = value;
  });
  return bag;
}

/**
 * The mock vendors and the Firm gateway both expose tools at `/tools/<tool>`.
 * A vendor_endpoint that already carries a path is used verbatim.
 * TODO(unverified): confirm the marketplace's canonical tool path during the
 * first live vendor call; recorded in docs/status/F1.md.
 */
export function toolUrl(vendorEndpoint: string, tool: string): string {
  const url = new URL(vendorEndpoint);
  if (url.pathname && url.pathname !== "/") return url.toString();
  url.pathname = `/tools/${tool}`;
  return url.toString();
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when the caller has named both the assets and the networks it will pay
 * on. selectOffer filters against both, so an offer that got this far under
 * both lists is an asset the caller chose, not one the vendor proposed.
 */
function bothAllowListsConfigured(options: { allowedAssets?: string[]; allowedNetworks?: string[] }): boolean {
  return Boolean(options.allowedAssets?.length && options.allowedNetworks?.length);
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

export async function payAndCallVendor(
  request: VendorCallRequest,
  options: {
    signer: Signer;
    verifyCaps: CapVerifier;
    /**
     * Called the instant a signature exists, before the paid replay. Once this
     * fires the call is no longer safely retryable: the authorization is out
     * there and the vendor's facilitator may redeem it even if our replay
     * never lands.
     */
    onSigned?: (offer: SelectedOffer) => Promise<void>;
    decimals: number;
    token: string;
    allowedAssets?: string[];
    allowedNetworks?: string[];
    /**
     * Require the asset's decimal scale to be KNOWN before signing — either
     * declared by the vendor, or pinned by having both allow-lists configured.
     * Set whenever real money can move. Off in simulation, where nothing is at
     * stake and the mock vendors are not all well-formed.
     */
    requireKnownDecimals?: boolean;
    timeoutMs?: number;
  }
): Promise<VendorCallOutcome> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const url = toolUrl(request.vendorEndpoint, request.tool);
  const started = Date.now();

  let probe: Response;
  try {
    probe = await postJson(url, request.args, {}, timeoutMs);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error_code: "VENDOR_TIMEOUT", detail: `probe failed: ${detail}` };
  }

  // A vendor that answers without charging is not an error; it is a free call.
  if (probe.status === 200) {
    return {
      ok: true,
      result: await readBody(probe),
      receipt: {
        amount: { amount: "0", decimals: options.decimals, token: options.token },
        tx: "NONE:vendor served without a payment challenge",
        payment_response: "no x402 challenge issued by vendor",
        settlement: null
      },
      latency_ms: Date.now() - started
    };
  }

  if (probe.status !== 402) {
    return {
      ok: false,
      error_code: "VENDOR_ERROR",
      detail: `vendor returned HTTP ${probe.status}: ${JSON.stringify(await readBody(probe)).slice(0, 500)}`
    };
  }

  let offer: SelectedOffer;
  let challenge;
  try {
    challenge = parseChallenge(headerBag(probe), await readBody(probe));
    offer = selectOffer(challenge, {
      allowedAssets: options.allowedAssets,
      allowedNetworks: options.allowedNetworks
    });
  } catch (error) {
    if (error instanceof X402Error) return { ok: false, error_code: error.errorCode, detail: error.message };
    throw error;
  }

  // Every cap check below is raw base-unit integer arithmetic, which only means
  // anything when the vendor's price and the caller's max_amount share a
  // decimal scale. If the vendor declared a different one, the comparison is
  // not merely wrong, it is dangerously wrong in the permissive direction — so
  // refuse rather than convert. Converting would mean deciding on the caller's
  // behalf what they meant to authorise.
  if (offer.declaredDecimals !== null && offer.declaredDecimals !== options.decimals) {
    return {
      ok: false,
      error_code: "UNSUPPORTED_CHALLENGE",
      detail:
        `vendor prices in ${offer.declaredDecimals} decimals but max_amount is in ${options.decimals}; ` +
        "refusing to compare base units across different scales"
    };
  }

  // An offer that declares no scale at all is the same hazard wearing a
  // friendlier face: `15 <= 15` passes whether those 15 units are 0.000015 USDT
  // or 15 units of something wei-scaled.
  //
  // The obvious fix — demand a declared scale whenever real money moves — is
  // wrong here, and measurably so. Of the 47 live x402 vendors on this
  // marketplace, 41 declare no `extra.decimals`, including OKLink #2023, the
  // vendor both G1 and G2 actually paid. That rule would cut the hireable pool
  // to six and break the payment path that already works.
  //
  // What the check is really for is not knowing the scale. So require the
  // scale to be *known*, not *declared*: an undeclared scale is safe exactly
  // when the asset and network are both explicitly allow-listed, because then
  // the scale is a fact about a token we chose in advance rather than a claim
  // the vendor is making. USD₮0 on X Layer is 6 decimals whether or not the
  // seller says so. selectOffer has already refused anything outside both
  // lists, so reaching here with both configured means the asset is one we
  // named ourselves.
  if (offer.declaredDecimals === null && options.requireKnownDecimals && !bothAllowListsConfigured(options)) {
    return {
      ok: false,
      error_code: "UNSUPPORTED_CHALLENGE",
      detail:
        "vendor declared no decimal scale and the asset is not on a configured asset+network " +
        `allow-list, so ${options.decimals} decimals would be an assumption rather than a fact`
    };
  }

  // --- Nothing above this line has spent anything. Nothing below it may spend
  // --- until verifyCaps has approved the exact amount the vendor asked for.
  const capFailure = await options.verifyCaps(offer);
  if (capFailure) return { ok: false, error_code: "CAP_EXCEEDED", detail: capFailure.detail };

  let signed;
  try {
    signed = await options.signer(challenge, offer);
  } catch (error) {
    if (error instanceof X402Error) return { ok: false, error_code: error.errorCode, detail: error.message };
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error_code: "PAYMENT_FAILED", detail };
  }

  // A signature now exists. Everything after this point is unsafe to retry
  // automatically, so record that fact before we go back on the wire.
  await options.onSigned?.(offer);

  let replay: Response;
  try {
    replay = await postJson(url, request.args, { [signed.headerName]: signed.headerValue }, timeoutMs);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error_code: "VENDOR_TIMEOUT", detail: `replay failed: ${detail}` };
  }

  const replayHeaders = headerBag(replay);
  const settlement = decodePaymentResponse(replayHeaders["payment-response"]);

  if (replay.status === 402) {
    return {
      ok: false,
      error_code: "PAYMENT_FAILED",
      detail: "vendor rejected the signed payment and re-issued a 402; signature may be stale"
    };
  }
  if (!replay.ok) {
    return {
      ok: false,
      error_code: "VENDOR_ERROR",
      detail: `paid replay returned HTTP ${replay.status}: ${JSON.stringify(await readBody(replay)).slice(0, 500)}`
    };
  }

  // The tx reference is whatever the settlement actually reported. If the
  // vendor settled asynchronously there is no hash yet, and we say so rather
  // than inventing one.
  const tx =
    typeof settlement?.transaction === "string" && settlement.transaction.length > 0
      ? settlement.transaction
      : `PENDING_SETTLEMENT:${signed.scheme}`;

  return {
    ok: true,
    result: await readBody(replay),
    receipt: {
      amount: { amount: String(offer.amountUnits), decimals: options.decimals, token: options.token },
      tx,
      payment_response: replayHeaders["payment-response"] ?? "vendor returned no PAYMENT-RESPONSE header",
      scheme: signed.scheme,
      network: offer.network,
      // The asset actually paid, as the vendor named it. `amount.token` is the
      // caller's label for the same money; this is the on-chain truth, and it
      // is what a reviewer should reconcile against.
      asset: offer.asset,
      // null means the vendor never declared its scale, so `amount.decimals`
      // above is the caller's assumption rather than a verified fact.
      declared_decimals: offer.declaredDecimals,
      pay_to: offer.payTo,
      settlement
    },
    latency_ms: Date.now() - started
  };
}
