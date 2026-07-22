import { describe, expect, it } from "vitest";

import { gasShortfall, REFUND_GAS_LIMIT, refundMode, refundWalletFailure } from "./refund.js";

/** The wallet this deployment claims, and one it must never spend from. */
const FIRM_WALLET = "0xc0296012cfbb0e6df5da7158b65dbc46dd9650e0";
const OTHER_WALLET = "0x212e82dc1d13b991d5318d970963f5ddfd81a178";

/**
 * The four combinations of the two independent switches. The third case is the
 * one that matters: it was a real defect, found by review after G2 — real
 * payments on, real refunds off returned a `SIMULATED:refund:*` hash that the
 * worker persisted and reported as REFUNDED, for a buyer who had genuinely paid.
 */
describe("refund mode policy", () => {
  it("sends a real refund whenever real refunds are enabled", () => {
    expect(refundMode({ realPayments: true, realRefunds: true })).toBe("real");
  });

  it("simulates only when the payment was also simulated", () => {
    expect(refundMode({ realPayments: false, realRefunds: false })).toBe("simulated");
  });

  it("never simulates a refund against a real payment", () => {
    expect(refundMode({ realPayments: true, realRefunds: false })).toBe("requires_human");
  });

  // Odd but harmless: refunds are armed, payments are not. Honouring it beats
  // second-guessing an operator who explicitly turned real refunds on.
  it("honours real refunds even when payments are simulated", () => {
    expect(refundMode({ realPayments: false, realRefunds: true })).toBe("real");
  });

  it("has no configuration that fabricates a hash for real money", () => {
    for (const realPayments of [true, false]) {
      for (const realRefunds of [true, false]) {
        const mode = refundMode({ realPayments, realRefunds });
        if (realPayments) expect(mode).not.toBe("simulated");
      }
    }
  });
});

/**
 * With local signing the refund wallet is derived from FIRM_WALLET_KEY, so the
 * old threat — an external account we could not verify — is gone. What replaces
 * it is the wrong key being deployed: a staging or personal key reaching
 * production would refund real customers from an unintended wallet and every
 * log line would look normal. The pin makes the operator state which wallet this
 * deployment spends from, and the derived address has to agree.
 */
describe("refund wallet pinning", () => {
  it("allows the send when the signing key is the pinned account", () => {
    expect(refundWalletFailure(FIRM_WALLET, FIRM_WALLET)).toBeNull();
  });

  it("refuses when the deployed key is a different account", () => {
    const failure = refundWalletFailure(FIRM_WALLET, OTHER_WALLET);
    expect(failure).toContain("mismatch");
    expect(failure).toContain(OTHER_WALLET);
  });

  // Fail-closed. Unset means nobody stated which wallet is authorised to refund.
  it("refuses when no wallet is pinned at all", () => {
    expect(refundWalletFailure(null, FIRM_WALLET)).toContain("REFUND_FROM_ADDRESS is unset");
  });

  it("refuses when no address could be derived from the key", () => {
    expect(refundWalletFailure(FIRM_WALLET, null)).toContain("cannot be verified");
  });

  // The chain reports lowercase; humans paste EIP-55 checksummed values into env
  // files. Same account, so this must not be treated as a mismatch.
  it("treats checksummed and lowercase spellings as the same account", () => {
    // EIP-55 form of FIRM_WALLET, as `cast wallet address` prints it.
    const checksummed = "0xC0296012Cfbb0e6DF5dA7158B65Dbc46DD9650e0";
    expect(refundWalletFailure(checksummed, FIRM_WALLET)).toBeNull();
    expect(refundWalletFailure(FIRM_WALLET, checksummed)).toBeNull();
  });

  it("never returns null when the two accounts genuinely differ", () => {
    for (const [a, b] of [
      [FIRM_WALLET, OTHER_WALLET],
      [OTHER_WALLET, FIRM_WALLET],
      [FIRM_WALLET, "0x0000000000000000000000000000000000000000"]
    ]) {
      expect(refundWalletFailure(a, b)).not.toBeNull();
    }
  });
});

/**
 * Signing locally made refunds a transaction we broadcast rather than an
 * authorization someone else redeems, which means this wallet now needs native
 * gas. Checked before sending, because an out-of-gas failure would otherwise
 * surface as an opaque RPC error at the exact moment the refund guarantee is
 * being invoked.
 */
describe("refund gas preflight", () => {
  const gasPriceWei = 20_000_001n;

  it("passes when the wallet can cover the transfer", () => {
    const needed = gasPriceWei * REFUND_GAS_LIMIT;
    expect(gasShortfall({ balanceWei: needed, gasPriceWei, gasLimit: REFUND_GAS_LIMIT })).toBeNull();
    expect(gasShortfall({ balanceWei: needed * 10n, gasPriceWei, gasLimit: REFUND_GAS_LIMIT })).toBeNull();
  });

  it("reports a shortfall one wei short of the requirement", () => {
    const needed = gasPriceWei * REFUND_GAS_LIMIT;
    const failure = gasShortfall({ balanceWei: needed - 1n, gasPriceWei, gasLimit: REFUND_GAS_LIMIT });
    expect(failure).toContain("Fund the wallet");
  });

  it("refuses an empty wallet", () => {
    expect(gasShortfall({ balanceWei: 0n, gasPriceWei, gasLimit: REFUND_GAS_LIMIT })).not.toBeNull();
  });

  // The observed balance and price on X Layer at the time this path was built.
  // Enough for a handful of refunds, which is worth knowing rather than assuming.
  it("accepts the real wallet balance observed on X Layer", () => {
    expect(gasShortfall({ balanceWei: 6_000_000_300_000n, gasPriceWei, gasLimit: REFUND_GAS_LIMIT })).toBeNull();
  });

  it("scales with gas price, so a price spike is caught rather than ignored", () => {
    const balanceWei = 6_000_000_300_000n;
    expect(gasShortfall({ balanceWei, gasPriceWei: gasPriceWei * 1000n, gasLimit: REFUND_GAS_LIMIT })).not.toBeNull();
  });
});
