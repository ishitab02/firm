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
  return Number(value.amount);
}
