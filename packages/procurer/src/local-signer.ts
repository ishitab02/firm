/**
 * In-process EIP-3009 signing — the replacement for `onchainos payment pay-local`.
 *
 * An x402 `exact` payment is not a transfer. It is a signed authorization the
 * *vendor* redeems, which is why gas for the payment leg is paid by the seller's
 * relayer and why this module never broadcasts anything. We produce a signature;
 * the money moves when someone else spends it.
 *
 * Three properties this is built around:
 *
 * 1. **The domain is proven, not assumed** — see chain.ts. A wrong domain
 *    yields a signature that is accepted everywhere and redeemable nowhere.
 *
 * 2. **The nonce is derived from the idempotency key, not random.** This is the
 *    interesting one. With a random nonce, signing the same subtask twice
 *    produces two independently redeemable authorizations — the database
 *    prevents that today, but the safety would live entirely in our bookkeeping.
 *    Deriving the nonce from `task:subtask:endpoint` means a re-sign reproduces
 *    the *same* authorization, and EIP-3009 nonces are single-use on-chain. So
 *    the token itself enforces at-most-once payment. A bug in our retry logic
 *    becomes a harmless duplicate rather than a double-spend.
 *
 * 3. **Nothing here checks caps.** Caps are enforced before this is reached, in
 *    vendor.ts, against a reservation. A signer that also checked would imply
 *    the earlier check was optional.
 */

import { keccak256, parseSignature, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { chainIdFromNetwork, verifiedDomain } from "./chain.js";
import { assembleV1PaymentHeader, X402Error, type SelectedOffer, type Signer } from "./x402.js";

/** The canonical EIP-3009 struct. Verified against USD₮0's own typehash. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
} as const;

export type Authorization = {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
};

/**
 * A nonce that is stable for a given payment and unpredictable across payments.
 *
 * The seed is the idempotency key; the wallet is mixed in so two deployments
 * sharing a task id cannot collide on the token's nonce map, which is keyed per
 * authorizer.
 */
export function nonceFor(seed: string, wallet: Address): Hex {
  return keccak256(toHex(`x402-nonce:${wallet.toLowerCase()}:${seed}`));
}

/**
 * How long the authorization stays redeemable.
 *
 * Bounded on purpose. An authorization with no expiry is a standing claim on the
 * wallet that survives the job it was signed for — if the vendor never redeems
 * it, it should become worthless rather than sit there indefinitely. The vendor
 * advertises how long it needs via `maxTimeoutSeconds`; we honour that plus a
 * margin for clock skew, with a floor so a vendor asking for 0 still gets a
 * usable window.
 */
export function validityWindow(
  offer: SelectedOffer,
  now: number
): { validAfter: string; validBefore: string } {
  const requested = Number(offer.entry.maxTimeoutSeconds);
  const seconds = Number.isFinite(requested) && requested > 0 ? requested : 0;
  const floor = Number(process.env.X402_MIN_VALIDITY_SECONDS ?? 600);
  const skew = Number(process.env.X402_CLOCK_SKEW_SECONDS ?? 60);
  const lifetime = Math.max(seconds, floor) + skew;
  return {
    // "0" — no lower time bound, matching the OKX CLI's known-good output. A
    // backdated timestamp was tried first and is strictly more restrictive; on
    // a path whose whole failure mode is a seller rejecting our authorization,
    // there is no reason to be more restrictive than the implementation that
    // demonstrably gets accepted. validBefore still bounds the exposure.
    validAfter: "0",
    validBefore: String(Math.floor(now / 1000) + lifetime)
  };
}

export function walletKeyFromEnv(): Hex {
  const key = process.env.FIRM_WALLET_KEY;
  if (!key) {
    throw new X402Error(
      "PAYMENT_FAILED",
      "FIRM_WALLET_KEY is not set; refusing to attempt a real payment without a funded wallet"
    );
  }
  const normalised = key.startsWith("0x") ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalised)) {
    throw new X402Error("PAYMENT_FAILED", "FIRM_WALLET_KEY is not a 32-byte hex private key");
  }
  return normalised as Hex;
}

/**
 * Build the x402 payment header for an offer.
 *
 * The v2 shape is VERIFIED, not inferred. It was first assembled by analogy
 * with v1 — carrying `scheme` and `network` as flat fields — and OKLink #2023
 * rejected it with a fresh 402 during G3. `scripts/diff-signers.ts` signed the
 * same live challenge with this code and with the OKX CLI, whose output is
 * known-good because it is what paid G1 and G2. Two whole fields were missing:
 *
 *   accepted   the SELECTED accepts entry, echoed in full (asset, extra,
 *              maxTimeoutSeconds, payTo, …), not decomposed into flat fields
 *   resource   echoed from the challenge envelope
 *
 * Sending `accepted` verbatim also means the seller sees exactly the offer we
 * priced and cap-checked, which is the same reason payloadForOffer narrows the
 * challenge to one entry before signing.
 *
 * v1 assembly is unchanged and untouched by this: it is the shape recorded in
 * x402.ts, and no v1 vendor was involved in the G3 failure.
 */
export function paymentHeaderFor(
  challenge: { version: number; envelope: Record<string, unknown> },
  offer: SelectedOffer,
  proof: { signature: Hex; authorization: Authorization }
): { headerName: string; headerValue: string } {
  if (challenge.version >= 2) {
    const payload = {
      x402Version: challenge.version,
      accepted: offer.entry,
      payload: { authorization: proof.authorization, signature: proof.signature },
      // Present on every challenge observed so far, but echoed conditionally so
      // a vendor that omits it does not get a literal `undefined` back.
      ...(challenge.envelope.resource === undefined ? {} : { resource: challenge.envelope.resource })
    };
    return {
      headerName: "PAYMENT-SIGNATURE",
      headerValue: Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
    };
  }
  return { headerName: "X-PAYMENT", headerValue: assembleV1PaymentHeader(offer, proof) };
}

/**
 * A signer bound to one payment.
 *
 * `nonceSeed` is the caller's idempotency key. It is required: defaulting to a
 * random value would silently give up the at-most-once property in property 2
 * above, and the failure would only ever show up as a double payment.
 */
export function localSigner(options: { nonceSeed: string }): Signer {
  return async (challenge, offer) => {
    if (!options.nonceSeed) {
      throw new X402Error("PAYMENT_FAILED", "refusing to sign without an idempotency seed for the nonce");
    }

    const account = privateKeyToAccount(walletKeyFromEnv());
    const chainId = chainIdFromNetwork(offer.network);
    const extra = (offer.entry.extra ?? {}) as Record<string, unknown>;
    const domain = await verifiedDomain(chainId, offer.asset as Address, {
      name: extra.name,
      version: extra.version
    });

    if (!offer.payTo) {
      throw new X402Error("UNSUPPORTED_CHALLENGE", "accepts entry carried no payTo address");
    }

    const window = validityWindow(offer, Date.now());
    const authorization: Authorization = {
      // Lowercased to match the CLI's output byte for byte. EIP-712 encodes the
      // 20 address bytes, so casing cannot change the signature — but it can
      // change a seller's string comparison, and matching known-good removes
      // one more variable from an interop path that has already bitten us.
      from: account.address.toLowerCase() as Address,
      to: offer.payTo as Address,
      // The vendor's own base-unit string, not a reparsed number. The signature
      // must cover exactly what was asked for and cap-checked.
      value: String(offer.amountUnits),
      ...window,
      nonce: nonceFor(options.nonceSeed, account.address)
    };

    let signature: Hex;
    try {
      signature = await account.signTypedData({
        domain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: authorization.from,
          to: authorization.to,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce
        }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new X402Error("PAYMENT_FAILED", `local signing failed: ${detail}`);
    }

    // Fail loudly on a malformed signature rather than shipping it: a vendor
    // would surface this as a generic rejection much further downstream.
    try {
      parseSignature(signature);
    } catch {
      throw new X402Error("PAYMENT_FAILED", "signer produced a signature that is not 65 bytes r/s/v");
    }

    const header = paymentHeaderFor(challenge, offer, { signature, authorization });
    return { ...header, scheme: offer.scheme, wallet: account.address };
  };
}
