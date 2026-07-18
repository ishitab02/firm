import { Money, units, usdt } from "./money.js";

export type PricingMode = "QUOTED_AMOUNT" | "TIERS";

const FIRM_FEE = 200_000;
const TIERS = [1_000_000, 3_000_000, 5_000_000];

export function estimatePlan(goal: string): Array<{ subtask: string; capability: string; max_amount: null }> {
  const text = goal.toLowerCase();
  if (text.includes("market") && text.includes("launch")) {
    return [
      { subtask: "market snapshot", capability: "market_snapshot", max_amount: null },
      { subtask: "launch brief", capability: "token_launch", max_amount: null }
    ];
  }
  if (text.includes("market")) {
    return [{ subtask: "market snapshot", capability: "market_snapshot", max_amount: null }];
  }
  return [{ subtask: "launch brief", capability: "token_launch", max_amount: null }];
}

export function quotePrice(vendorEstimates: Money[], mode: PricingMode): Money {
  const total = vendorEstimates.reduce((sum, price) => sum + units(price), 0);
  const mostExpensiveRetry = Math.max(...vendorEstimates.map(units));
  const retryReserve = Math.max(mostExpensiveRetry, Math.floor(total * 0.3));
  const quoted = total + retryReserve + FIRM_FEE;
  if (mode === "TIERS") {
    return usdt(TIERS.find((tier) => quoted <= tier) ?? TIERS[TIERS.length - 1]);
  }
  return usdt(quoted);
}
