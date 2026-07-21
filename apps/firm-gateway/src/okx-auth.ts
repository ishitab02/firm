/**
 * OKX API request signing, for the x402 facilitator.
 *
 * The facilitator at https://web3.okx.com/api/v6/pay/x402 is an authenticated
 * OKX API, not an open endpoint: every verify and settle call must carry an
 * HMAC signature over the request. Unsigned calls are rejected, which would
 * have looked to us like "the facilitator declined the payment".
 *
 * These are API credentials, NOT a wallet key. They authenticate us to OKX so
 * we can ask it to verify and settle a buyer's authorization; they cannot move
 * the Firm's own funds and they are not a signing key for any chain. The
 * gateway still holds no wallet material — that stays in packages/procurer.
 * The distinction matters because it is the reason this can live here at all.
 *
 * Credentials come from the environment and are never logged, never included in
 * an error message, and never written to the database.
 */

import { createHmac } from "node:crypto";

export type OkxCredentials = {
  apiKey: string;
  secretKey: string;
  passphrase: string;
};

/**
 * Read credentials, or null when they are not configured.
 *
 * Null is a legitimate state: with no credentials the gateway cannot settle,
 * so it fails closed and refuses paid calls rather than serving them free.
 */
export function okxCredentialsFromEnv(): OkxCredentials | null {
  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;
  if (!apiKey || !secretKey || !passphrase) return null;
  return { apiKey, secretKey, passphrase };
}

/**
 * Build the signed headers for one request.
 *
 * OKX signs `timestamp + method + requestPath + body`, HMAC-SHA256 with the
 * secret, base64-encoded. Three details are easy to get wrong and all of them
 * produce the same opaque auth failure:
 *
 *   - `requestPath` is the path AND query string, not the full URL. Including
 *     the scheme and host, or dropping the query, both break the signature.
 *   - `method` is upper-case.
 *   - the body must be the exact string that is sent. Serialising twice can
 *     reorder keys and invalidate the signature, so the caller passes the same
 *     string it will put on the wire.
 *
 * The timestamp is ISO 8601 with milliseconds, which is what `toISOString`
 * already produces.
 */
export function signOkxRequest(
  credentials: OkxCredentials,
  request: { method: string; requestPath: string; body?: string; timestamp?: string }
): Record<string, string> {
  const timestamp = request.timestamp ?? new Date().toISOString();
  const method = request.method.toUpperCase();
  const payload = `${timestamp}${method}${request.requestPath}${request.body ?? ""}`;
  const signature = createHmac("sha256", credentials.secretKey).update(payload).digest("base64");

  return {
    "OK-ACCESS-KEY": credentials.apiKey,
    "OK-ACCESS-SIGN": signature,
    "OK-ACCESS-PASSPHRASE": credentials.passphrase,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "content-type": "application/json"
  };
}

/**
 * Split an absolute URL into the origin and the `requestPath` OKX signs over.
 *
 * Signing over the full URL is the most common way to get this wrong, so the
 * split lives here rather than at each call site.
 */
export function splitForSigning(url: string): { origin: string; requestPath: string } {
  const parsed = new URL(url);
  return { origin: parsed.origin, requestPath: `${parsed.pathname}${parsed.search}` };
}
