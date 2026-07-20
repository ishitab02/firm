/**
 * Outbound refund transfer.
 *
 * BLOCKER, recorded in docs/status/F1.md and unresolved as of 2026-07-20:
 * the buyer payment path signs with a local hex key (FIRM_WALLET_KEY, via
 * `onchainos payment pay-local`), but the only outbound-transfer surface the
 * CLI exposes is `onchainos wallet send`, which signs through the logged-in
 * TEE-backed Agentic Wallet account. Those are not necessarily the same wallet.
 *
 * Consequences a human has to choose between:
 *   (a) keep this path, and require that the logged-in Agentic Wallet account
 *       is the same funded account whose key is in FIRM_WALLET_KEY, or
 *   (b) add a local ERC-20 transfer signer to the procurer, which means a new
 *       web3 dependency plus a verified RPC endpoint.
 * Until that is closed, real refunds require REAL_REFUNDS_ENABLED to be set
 * explicitly — REAL_PAYMENTS_ENABLED alone does not turn them on.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RefundResult = { ok: true; tx: string; detail: string } | { ok: false; detail: string };

export function realRefundsEnabled(): boolean {
  return process.env.REAL_REFUNDS_ENABLED === "true";
}

export async function executeRefund(request: {
  toAddress: string;
  amountUnits: number;
}): Promise<RefundResult> {
  const binary = process.env.OKX_CLI_BIN ?? "onchainos";
  // TODO(unverified): REFUND_CHAIN and REFUND_TOKEN_CONTRACT are not guessed
  // here. Nothing moves until a human supplies the chain and the token contract
  // the Firm actually refunds in.
  const chain = process.env.REFUND_CHAIN;
  const contract = process.env.REFUND_TOKEN_CONTRACT;
  if (!chain || !contract) {
    return {
      ok: false,
      detail: "REFUND_CHAIN and REFUND_TOKEN_CONTRACT are unset; refusing to guess the refund asset or network"
    };
  }

  const args = [
    "wallet",
    "send",
    "--recipient",
    request.toAddress,
    "--amt",
    String(request.amountUnits),
    "--chain",
    chain,
    "--contract-token",
    contract,
    "--force"
  ];

  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: Number(process.env.REFUND_TIMEOUT_MS ?? 60_000),
      maxBuffer: 4 * 1024 * 1024
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const data = (typeof parsed.data === "object" && parsed.data !== null ? parsed.data : parsed) as Record<
      string,
      unknown
    >;
    const tx = data.txHash ?? data.transaction ?? data.tx_hash ?? data.orderId;
    if (typeof tx !== "string" || tx.length === 0) {
      return { ok: false, detail: `refund transfer returned no transaction reference: ${stdout.slice(0, 300)}` };
    }
    return { ok: true, tx, detail: "refund broadcast via Agentic Wallet transfer" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `refund transfer failed: ${detail}` };
  }
}
