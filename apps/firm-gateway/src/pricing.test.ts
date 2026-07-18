import { describe, expect, it } from "vitest";

import { usdt } from "./money.js";
import { estimatePlan, quotePrice } from "./pricing.js";

describe("gateway pricing", () => {
  it("rounds deterministic quote to tier mode by default path", () => {
    expect(quotePrice([usdt(300_000)], "TIERS")).toEqual({
      amount: "1000000",
      decimals: 6,
      token: "USDT"
    });
  });

  it("keeps quoted amount mode exact", () => {
    expect(quotePrice([usdt(300_000), usdt(200_000)], "QUOTED_AMOUNT").amount).toBe("1000000");
  });

  it("plans mixed market launch goals into two subtasks", () => {
    expect(estimatePlan("market and launch briefing").map((item) => item.capability)).toEqual([
      "market_snapshot",
      "token_launch"
    ]);
  });
});
