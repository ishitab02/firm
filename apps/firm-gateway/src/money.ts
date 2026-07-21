export type Money = {
  amount: string;
  decimals: number;
  token: string;
};

export function usdt(amount: number): Money {
  return { amount: String(amount), decimals: 6, token: "USDT" };
}

export function units(value: Money): number {
  if (!/^\d+$/.test(value.amount)) {
    throw new Error("money amount must be a base-unit integer string");
  }
  // Past 2^53-1, Number() stops being exact and the quote arithmetic silently
  // operates on a value nobody authorised. Unreachable at 6 decimals; 0.009
  // tokens at 18. Refuse rather than round.
  const parsed = Number(value.amount);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`money amount ${value.amount} exceeds the safe integer range`);
  }
  return parsed;
}
