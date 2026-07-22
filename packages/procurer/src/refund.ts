/**
 * Outbound refund transfer.
 *
 * REVISED 2026-07-22 by Poulav (option 3b): the OKX CLI is out of the money
 * path entirely, and refunds now send in-process from the same wallet that
 * pays vendors and receives customer payments.
 *
 *   payments out   EIP-3009 authorization, signed locally  -> 0xC029…50e0
 *   refunds out    ERC-20 transfer, signed locally         -> 0xC029…50e0
 *   money in       FIRM_PAYTO_ADDRESS                      -> 0xC029…50e0
 *
 * The previous design used `onchainos wallet send`, which signs through the
 * logged-in Agentic Wallet. That forced a two-wallet split — the CLI's account
 * cannot be set from a hex key — and, more seriously, could not run in
 * production at all: the CLI is a macOS-only binary whose login is browser-based,
 * so a container can neither execute nor authenticate it. The deployed procurer
 * could hold a funded key and still be unable to refund a customer, which is the
 * guarantee failing exactly where it is load-bearing.
 *
 * Signing locally removes both problems and collapses the three roles onto one
 * address, so the wallet that took the money is the wallet that gives it back.
 *
 * What it costs: a refund is now a transaction we broadcast, not an
 * authorization someone else redeems, so this wallet must hold native gas. That
 * is a new operational dependency and it is checked before sending rather than
 * discovered as a revert.
 *
 * Real refunds still require REAL_REFUNDS_ENABLED explicitly — REAL_PAYMENTS_ENABLED
 * alone does not turn them on.
 */

import { createWalletClient, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { publicClientFor, rpcUrlFor, TOKEN_ABI } from "./chain.js";
import { walletKeyFromEnv } from "./local-signer.js";

export type RefundResult =
  | { ok: true; tx: string; detail: string }
  | { ok: false; detail: string; pendingTx?: string };

export type RefundTransactionStatus =
  | { status: "settled"; detail: string }
  | { status: "reverted"; detail: string }
  | { status: "pending"; detail: string };

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
 */
export function refundMode(switches: { realPayments: boolean; realRefunds: boolean }): RefundMode {
  if (switches.realRefunds) return "real";
  return switches.realPayments ? "requires_human" : "simulated";
}

/** The account refunds must leave from. Unset is a hard failure, not a default. */
export function expectedRefundWallet(): string | null {
  const pinned = process.env.REFUND_FROM_ADDRESS;
  return pinned && pinned.length > 0 ? pinned : null;
}

export const UNPINNED_WALLET =
  "REFUND_FROM_ADDRESS is unset while real refunds are enabled. Refusing to refund from " +
  "whichever account the CLI happens to have selected — pin the wallet explicitly.";

/**
 * Why the refund must not proceed, or null when the signing key is the pinned account.
 *
 * The threat this guards changed with the move to local signing, and it is
 * worth being precise about. It is no longer "an external account we cannot
 * verify" — the key is ours and its address is deterministic. It is now "the
 * wrong key is deployed": a staging or personal key reaching production would
 * refund real customers from an unfunded or unintended wallet, and every log
 * line would look normal. Requiring the operator to state which wallet this
 * deployment spends from turns that into a startup-time mismatch instead.
 *
 * Address comparison is case-insensitive: the chain reports lowercase, EIP-55
 * checksummed values are what humans paste into env files, and a case
 * difference between two spellings of the same account is not a mismatch.
 */
export function refundWalletFailure(expected: string | null, actual: string | null): string | null {
  if (!expected) return UNPINNED_WALLET;
  if (!actual) {
    return (
      "could not derive an address from the signing key, so the refund wallet cannot be " +
      "verified. Refusing to send from an unverified account."
    );
  }
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    return (
      `refund wallet mismatch: REFUND_FROM_ADDRESS is ${expected} but the signing key is ` +
      `${actual}. Refusing to send a customer refund from an account this deployment does not claim.`
    );
  }
  return null;
}

/** Minimal chain descriptor. viem needs an id and an endpoint; nothing else is used here. */
export function chainFor(chainId: number): Chain {
  return {
    id: chainId,
    name: `eip155-${chainId}`,
    nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrlFor(chainId)] } }
  };
}

/**
 * Is there enough native balance to broadcast a token transfer?
 *
 * Pure, so the arithmetic is testable without a chain. Deliberately checked
 * before sending: an out-of-gas refund fails as an opaque RPC error at the
 * moment the guarantee is being invoked, which is the worst time to be
 * debugging an operational gap.
 */
export function gasShortfall(input: {
  balanceWei: bigint;
  gasPriceWei: bigint;
  gasLimit: bigint;
}): string | null {
  const needed = input.gasPriceWei * input.gasLimit;
  if (input.balanceWei >= needed) return null;
  return (
    `refund wallet holds ${input.balanceWei} wei of native gas but the transfer needs about ` +
    `${needed} wei (${input.gasLimit} gas at ${input.gasPriceWei} wei). Fund the wallet before ` +
    "arming real refunds."
  );
}

/** Gas a plain ERC-20 transfer is budgeted at, with headroom over the ~52k typical cost. */
export const REFUND_GAS_LIMIT = 100_000n;

export type RefundReadiness = {
  ready: boolean;
  detail: string;
  balanceWei?: string;
  requiredWei?: string;
};

/**
 * Live operational readiness for the refund guarantee.
 *
 * Environment booleans only say the code path is armed. They do not prove the
 * pinned signer has enough native gas, which is how production advertised
 * refunds as available while every transfer deterministically failed.
 */
export async function refundReadiness(): Promise<RefundReadiness> {
  if (!realRefundsEnabled()) return { ready: false, detail: "REAL_REFUNDS_ENABLED is not true" };
  const chainIdRaw = process.env.REFUND_CHAIN;
  if (!chainIdRaw || !process.env.REFUND_TOKEN_CONTRACT) {
    return { ready: false, detail: "REFUND_CHAIN and REFUND_TOKEN_CONTRACT must be configured" };
  }
  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { ready: false, detail: `REFUND_CHAIN must be a numeric chain id, got ${JSON.stringify(chainIdRaw)}` };
  }

  let account;
  try {
    account = privateKeyToAccount(walletKeyFromEnv());
  } catch (error) {
    return { ready: false, detail: error instanceof Error ? error.message : String(error) };
  }
  const walletFailure = refundWalletFailure(expectedRefundWallet(), account.address);
  if (walletFailure) return { ready: false, detail: walletFailure };

  try {
    const publicClient = publicClientFor(chainId);
    const [balanceWei, gasPriceWei] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.getGasPrice()
    ]);
    const requiredWei = gasPriceWei * REFUND_GAS_LIMIT;
    const shortfall = gasShortfall({ balanceWei, gasPriceWei, gasLimit: REFUND_GAS_LIMIT });
    return {
      ready: shortfall === null,
      detail: shortfall ?? "refund signer, network, token, and native gas are ready",
      balanceWei: balanceWei.toString(),
      requiredWei: requiredWei.toString()
    };
  } catch (error) {
    return {
      ready: false,
      detail: `could not read refund wallet gas balance: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export async function executeRefund(request: {
  toAddress: string;
  amountUnits: number;
}): Promise<RefundResult> {
  const chainIdRaw = process.env.REFUND_CHAIN;
  const contract = process.env.REFUND_TOKEN_CONTRACT;
  if (!chainIdRaw || !contract) {
    return {
      ok: false,
      detail: "REFUND_CHAIN and REFUND_TOKEN_CONTRACT are unset; refusing to guess the refund asset or network"
    };
  }
  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { ok: false, detail: `REFUND_CHAIN must be a numeric chain id, got ${JSON.stringify(chainIdRaw)}` };
  }

  let account;
  try {
    account = privateKeyToAccount(walletKeyFromEnv());
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  // Verify the wallet BEFORE building the transfer. A refund that leaves the
  // wrong account cannot be recalled. The unset case returns early rather than
  // going through refundWalletFailure so `expected` narrows to a string.
  const expected = expectedRefundWallet();
  if (expected === null) return { ok: false, detail: UNPINNED_WALLET };
  const walletFailure = refundWalletFailure(expected, account.address);
  if (walletFailure) return { ok: false, detail: walletFailure };

  const publicClient = publicClientFor(chainId);
  const chain = chainFor(chainId);

  try {
    const [balanceWei, gasPriceWei] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.getGasPrice()
    ]);
    const shortfall = gasShortfall({ balanceWei, gasPriceWei, gasLimit: REFUND_GAS_LIMIT });
    if (shortfall) return { ok: false, detail: shortfall };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `could not read refund wallet gas balance: ${detail}` };
  }

  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrlFor(chainId)) });

  let hash: Hex;
  try {
    hash = await walletClient.writeContract({
      address: contract as Address,
      abi: TOKEN_ABI,
      functionName: "transfer",
      args: [request.toAddress as Address, BigInt(request.amountUnits)],
      gas: REFUND_GAS_LIMIT
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `refund transfer failed to broadcast: ${detail}` };
  }

  // A broadcast hash is not a completed refund. A reverted transfer — wrong
  // token, insufficient balance, a blocked recipient — still produces a hash,
  // and returning it here would report a refund that never happened and mark
  // the job REFUNDED. Wait for the receipt and insist on success.
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: Number(process.env.REFUND_TIMEOUT_MS ?? 60_000)
    });
    if (receipt.status !== "success") {
      return { ok: false, detail: `refund transfer ${hash} reverted on chain ${chainId}` };
    }
    return { ok: true, tx: hash, detail: `refund settled in block ${receipt.blockNumber}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The transaction may still confirm. Report the hash so a human can check
    // rather than silently retrying and sending the refund twice.
    return {
      ok: false,
      pendingTx: hash,
      detail: `refund ${hash} broadcast but not confirmed within the timeout: ${detail}`
    };
  }
}

/** Reconcile a previously broadcast refund without ever sending a second one. */
export async function refundTransactionStatus(hash: Hex): Promise<RefundTransactionStatus> {
  const chainId = Number(process.env.REFUND_CHAIN);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { status: "pending", detail: "cannot reconcile: REFUND_CHAIN is not configured" };
  }
  try {
    const receipt = await publicClientFor(chainId).getTransactionReceipt({ hash });
    if (receipt.status === "success") {
      return { status: "settled", detail: `refund settled in block ${receipt.blockNumber}` };
    }
    return { status: "reverted", detail: `refund ${hash} reverted on chain ${chainId}` };
  } catch (error) {
    return {
      status: "pending",
      detail: `refund ${hash} is not yet confirmed or the receipt RPC is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
}
