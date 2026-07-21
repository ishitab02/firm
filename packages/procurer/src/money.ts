export type Money = {
  amount: string;
  decimals: number;
  token: string;
};

export function units(value: Money): number {
  if (!/^\d+$/.test(value.amount)) throw new Error("amount must be base-unit integer string");
  // Past 2^53-1, Number() stops being exact and every cap comparison downstream
  // silently operates on a value that is not the amount anyone authorised.
  // Unreachable at 6 decimals; 0.009 tokens at 18. Refuse rather than round.
  const parsed = Number(value.amount);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`amount ${value.amount} exceeds the safe integer range for base-unit money math`);
  }
  return parsed;
}
