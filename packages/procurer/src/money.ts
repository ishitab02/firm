export type Money = {
  amount: string;
  decimals: number;
  token: string;
};

export function units(value: Money): number {
  if (!/^\d+$/.test(value.amount)) throw new Error("amount must be base-unit integer string");
  return Number(value.amount);
}
