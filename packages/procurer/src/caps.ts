import { Money, units } from "./money.js";

export type Caps = {
  perCallMax: number;
  perTaskMax: number;
  dailyMax: number;
  dailyRefundMax: number;
};

export function capsFromEnv(): Caps {
  return {
    perCallMax: Number(process.env.PER_CALL_MAX ?? 1_000_000),
    perTaskMax: Number(process.env.PER_TASK_MAX ?? 5_000_000),
    dailyMax: Number(process.env.DAILY_MAX ?? 20_000_000),
    dailyRefundMax: Number(process.env.DAILY_REFUND_MAX ?? 5_000_000)
  };
}

export function assertPerCall(amount: Money, caps: Caps) {
  if (units(amount) > caps.perCallMax) {
    return { ok: false as const, error_code: "CAP_EXCEEDED", detail: "per-call cap would be exceeded before payment" };
  }
  return { ok: true as const };
}

export function assertAggregateCaps(
  amount: Money,
  caps: Caps,
  spentForTask: number,
  spentToday: number
) {
  const requested = units(amount);
  if (spentForTask + requested > caps.perTaskMax) {
    return { ok: false as const, error_code: "CAP_EXCEEDED", detail: "per-task cap would be exceeded before payment" };
  }
  if (spentToday + requested > caps.dailyMax) {
    return { ok: false as const, error_code: "CAP_EXCEEDED", detail: "daily cap would be exceeded before payment" };
  }
  return { ok: true as const };
}

export function assertRefundCap(amount: Money, caps: Caps, refundedToday: number) {
  const requested = units(amount);
  if (refundedToday + requested > caps.dailyRefundMax) {
    return { ok: false as const, error_code: "CAP_EXCEEDED", detail: "daily refund cap would be exceeded before refund" };
  }
  return { ok: true as const };
}
