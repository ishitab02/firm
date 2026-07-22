/**
 * Fulfilment coherence: never charge real money for simulated work.
 *
 * The gateway and the procurer have independent money switches, and one
 * combination is incoherent rather than merely unusual:
 *
 *   gateway  CHARGING_MODE=enforce + a live facilitator  -> takes REAL money
 *   procurer REAL_PAYMENTS_ENABLED=false                 -> SIMULATED vendors
 *   procurer REAL_REFUNDS_ENABLED=false                  -> guarantee cannot close
 *
 * In that state a buyer pays real USDT and receives a deliverable produced by a
 * simulated vendor call. Or, when every candidate fails, the worker reaches a
 * refund path that cannot return the customer's money automatically. The
 * provenance receipt does disclose simulated work — the tx reads
 * `SIMULATED:pay:…` and the books line says so — so nothing is hidden. But
 * disclosure is not a defence for selling simulated work; it just means the
 * customer can read what went wrong.
 *
 * Neither service can detect this alone. The gateway knows it is charging; the
 * procurer knows it is simulating; only the pair is wrong. So the gateway asks.
 *
 * This is a startup check on purpose. A per-request check would fail the buyer
 * who has already paid — the money has moved by then, and the only remaining
 * option is a refund we would rather not have needed. Refusing to boot means
 * the endpoint is honestly unavailable instead of quietly wrong, which is the
 * failure direction every other guard in this codebase picks.
 */

export type FulfilmentMode = {
  realPayments: boolean;
  realRefunds: boolean;
  walletKeyPresent: boolean;
  refundReady: boolean;
  refundReadinessDetail?: string;
};

/** Ask the procurer what it will actually do with a job. Null when unreachable. */
export async function readFulfilmentMode(
  procurerUrl: string,
  options: { timeoutMs?: number } = {}
): Promise<FulfilmentMode | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const response = await fetch(new URL("/health", procurerUrl).toString(), { signal: controller.signal });
    if (!response.ok) return null;
    const raw = (await response.json()) as Record<string, unknown>;
    return {
      realPayments: raw.real_payments_enabled === true,
      realRefunds: raw.real_refunds_enabled === true,
      walletKeyPresent: raw.wallet_key_present === true,
      refundReady: raw.refund_ready === true,
      refundReadinessDetail:
        typeof raw.refund_readiness_detail === "string" ? raw.refund_readiness_detail : undefined
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns null when the pairing is coherent, or the reason it is not.
 *
 * An unreachable procurer is treated as incoherent while charging: a gateway
 * that takes money with no reachable fulfilment backend produces exactly the
 * "paid, then PENDING forever" outcome that is indistinguishable from theft.
 */
export function fulfilmentFailure(input: {
  charging: boolean;
  mode: FulfilmentMode | null;
}): string | null {
  if (!input.charging) return null;

  if (input.mode === null) {
    return (
      "the procurer is unreachable, so a paid job could not be fulfilled. Refusing to charge " +
      "for work nothing can perform."
    );
  }

  if (!input.mode.realPayments) {
    return (
      "the procurer is in SIMULATION mode (REAL_PAYMENTS_ENABLED=false) while this gateway is " +
      "configured to take real payments. A buyer would pay real money for a simulated vendor " +
      "call. Enable real payments on the procurer, or set CHARGING_MODE=bypass."
    );
  }

  if (!input.mode.walletKeyPresent) {
    return (
      "the procurer has real payments enabled but no wallet key, so every vendor call will fail " +
      "and every paid job will refund. Refusing to charge for work that cannot start."
    );
  }

  if (!input.mode.realRefunds) {
    return (
      "the procurer has real vendor payments enabled but real refunds disabled. A customer could pay " +
      "for a failed job without receiving the advertised automatic refund. Enable and verify the refund " +
      "path before accepting paid work."
    );
  }

  if (!input.mode.refundReady) {
    return (
      "the procurer refund path is armed but not operationally ready: " +
      (input.mode.refundReadinessDetail ?? "live signer/gas readiness was not confirmed")
    );
  }

  return null;
}
