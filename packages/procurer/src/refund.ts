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

export type RefundMode = "real" | "simulated" | "requires_human";

/**
 * Which of the three things /refund may do, given the two independent switches.
 *
 * The only interesting cell is real payments + no real refunds. A simulated
 * refund tx is an honest artefact when the payment was also simulated — the
 * whole run is labelled SIMULATED and nobody is out any money. The moment real
 * payments are on, that same simulated tx becomes a fabricated hash handed back
 * for a buyer who genuinely paid, which the worker then persists and reports as
 * REFUNDED. It breaks the no-fabricated-tx rule and the delivery guarantee in
 * one step, so it fails closed and asks for a human instead.
 *
 * This is a reachable configuration, not a theoretical one: G1 and G2 both ran
 * under it, because the refund-wallet question (payer 0xc029… is not the
 * CLI-logged-in account) is still open.
 */
export function refundMode(switches: { realPayments: boolean; realRefunds: boolean }): RefundMode {
  if (switches.realRefunds) return "real";
  return switches.realPayments ? "requires_human" : "simulated";
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
