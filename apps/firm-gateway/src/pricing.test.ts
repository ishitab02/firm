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

  it("prices one estimate per supported Projects leg", () => {
    expect(estimatePlan("Compare BTC and ETH on 4h market trend").map((item) => item.subtask)).toEqual([
      "BTC 4h market snapshot",
      "ETH 4h market snapshot"
    ]);
  });

  it("does not fabricate a plan for an unsupported goal", () => {
    expect(estimatePlan("launch a token")).toEqual([]);
  });
});
