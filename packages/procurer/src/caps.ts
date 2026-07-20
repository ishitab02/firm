/**
 * Cap arithmetic. Pure, base-unit integers only — the callers convert Money to
 * base units at the boundary so there is exactly one place where a cap decision
 * is made, and it has no I/O in it.
 */

export type Caps = {
  perCallMax: number;
  perTaskMax: number;
  dailyMax: number;
  dailyRefundMax: number;
};

export type CapVerdict = { ok: true } | { ok: false; error_code: "CAP_EXCEEDED"; detail: string };

const reject = (detail: string): CapVerdict => ({ ok: false, error_code: "CAP_EXCEEDED", detail });

export function capsFromEnv(): Caps {
  return {
    perCallMax: Number(process.env.PER_CALL_MAX ?? 1_000_000),
    perTaskMax: Number(process.env.PER_TASK_MAX ?? 5_000_000),
    dailyMax: Number(process.env.DAILY_MAX ?? 20_000_000),
    dailyRefundMax: Number(process.env.DAILY_REFUND_MAX ?? 5_000_000)
  };
}

export function assertPerCall(requestedUnits: number, caps: Caps): CapVerdict {
  if (requestedUnits > caps.perCallMax) return reject("per-call cap would be exceeded before payment");
  return { ok: true };
}

export function assertAggregateCaps(
  requestedUnits: number,
  caps: Caps,
  spentForTask: number,
  spentToday: number
): CapVerdict {
  if (spentForTask + requestedUnits > caps.perTaskMax) {
    return reject("per-task cap would be exceeded before payment");
  }
  if (spentToday + requestedUnits > caps.dailyMax) {
    return reject("daily cap would be exceeded before payment");
  }
  return { ok: true };
}

export function assertRefundCap(requestedUnits: number, caps: Caps, refundedToday: number): CapVerdict {
  if (refundedToday + requestedUnits > caps.dailyRefundMax) {
    return reject("daily refund cap would be exceeded before refund");
  }
  return { ok: true };
}
