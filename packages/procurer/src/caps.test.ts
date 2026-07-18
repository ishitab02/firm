import { describe, expect, it } from "vitest";

import { assertAggregateCaps, assertPerCall, assertRefundCap, Caps } from "./caps.js";

const caps: Caps = {
  perCallMax: 100,
  perTaskMax: 250,
  dailyMax: 500,
  dailyRefundMax: 200
};

const money = (amount: number) => ({ amount: String(amount), decimals: 6, token: "USDT" });

describe("procurer caps", () => {
  it("rejects before payment when per-call cap would be exceeded", () => {
    expect(assertPerCall(money(101), caps)).toMatchObject({ ok: false, error_code: "CAP_EXCEEDED" });
  });

  it("rejects before payment when task aggregate would be exceeded", () => {
    expect(assertAggregateCaps(money(100), caps, 200, 0)).toMatchObject({
      ok: false,
      detail: "per-task cap would be exceeded before payment"
    });
  });

  it("rejects before payment when daily aggregate would be exceeded", () => {
    expect(assertAggregateCaps(money(100), caps, 0, 450)).toMatchObject({
      ok: false,
      detail: "daily cap would be exceeded before payment"
    });
  });

  it("rejects before refund when daily refund cap would be exceeded", () => {
    expect(assertRefundCap(money(100), caps, 150)).toMatchObject({
      ok: false,
      detail: "daily refund cap would be exceeded before refund"
    });
  });
});
