/**
 * The one place in The Firm that touches a key.
 *
 * Signing is delegated to the OKX buyer CLI (`onchainos payment pay-local`),
 * which reads the hex key from the `EVM_PRIVATE_KEY` environment variable. We
 * pass FIRM_WALLET_KEY into the child process env only — never a file, never an
 * argv entry (argv is world-readable in `ps`), never a log line.
 *
 * The CLI signs; it does not settle. Settlement happens when the vendor or its
 * facilitator redeems the authorization, which is why the replay response is
 * what we record as the receipt.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { assembleV1PaymentHeader, SelectedOffer, X402Challenge, X402Error } from "./x402.js";

const execFileAsync = promisify(execFile);

export type SignedPayment = {
  headerName: string;
  headerValue: string;
  scheme: string;
  wallet?: string;
};

export type Signer = (challenge: X402Challenge, offer: SelectedOffer) => Promise<SignedPayment>;

/**
 * The CLI has shipped its result both bare and wrapped in a `{data: …}`
 * envelope depending on subcommand. Unwrap defensively rather than pinning a
 * shape we have not observed on this exact version.
 * TODO(unverified): confirm the exact pay-local envelope against a real 402
 * during the human-triggered payment spike, then tighten this.
 */
function unwrap(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const data = parsed.data;
  if (typeof data === "object" && data !== null) return data as Record<string, unknown>;
  return parsed;
}

export function walletKeyFromEnv(): string {
  const key = process.env.FIRM_WALLET_KEY;
  if (!key) {
    throw new X402Error(
      "PAYMENT_FAILED",
      "FIRM_WALLET_KEY is not set; refusing to attempt a real payment without a funded wallet"
    );
  }
  return key;
}

export function realSigner(): Signer {
  const binary = process.env.OKX_CLI_BIN ?? "onchainos";

  return async (challenge, offer) => {
    const key = walletKeyFromEnv();
    let stdout: string;
    try {
      const result = await execFileAsync(
        binary,
        ["payment", "pay-local", "--payload", challenge.payloadBase64, "--selected-index", String(offer.acceptsIndex)],
        {
          // The key lives in the child env and nowhere else.
          env: { ...process.env, EVM_PRIVATE_KEY: key },
          timeout: Number(process.env.SIGNER_TIMEOUT_MS ?? 30_000),
          maxBuffer: 4 * 1024 * 1024
        }
      );
      stdout = result.stdout;
    } catch (error) {
      // execFile surfaces the CLI's stderr on failure. Never echo the env.
      const detail = error instanceof Error ? error.message : String(error);
      throw new X402Error("PAYMENT_FAILED", `signer failed: ${detail}`);
    }

    const data = unwrap(stdout);

    const headerValue = data.authorization_header;
    if (typeof headerValue === "string" && headerValue.length > 0) {
      return {
        headerName: typeof data.header_name === "string" ? data.header_name : "PAYMENT-SIGNATURE",
        headerValue,
        scheme: typeof data.scheme === "string" ? data.scheme : offer.scheme,
        wallet: typeof data.wallet === "string" ? data.wallet : undefined
      };
    }

    // Legacy x402 v1: the CLI returns the raw proof and we assemble X-PAYMENT.
    if (data.signature !== undefined && data.authorization !== undefined) {
      return {
        headerName: "X-PAYMENT",
        headerValue: assembleV1PaymentHeader(offer, {
          signature: data.signature,
          authorization: data.authorization
        }),
        scheme: offer.scheme,
        wallet: typeof data.wallet === "string" ? data.wallet : undefined
      };
    }

    throw new X402Error(
      "PAYMENT_FAILED",
      "signer returned neither an authorization_header nor a {signature, authorization} proof"
    );
  };
}
