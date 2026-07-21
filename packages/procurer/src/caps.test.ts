import { describe, expect, it } from "vitest";

import { assertAggregateCaps, assertPerCall, assertRefundCap, Caps } from "./caps.js";

const caps: Caps = {
  perCallMax: 100,
  perTaskMax: 250,
  dailyMax: 500,
  dailyRefundMax: 200
};

describe("procurer caps", () => {
  it("rejects before payment when per-call cap would be exceeded", () => {
    expect(assertPerCall(101, caps)).toMatchObject({ ok: false, error_code: "CAP_EXCEEDED" });
  });

  it("admits a call exactly at the per-call cap", () => {
    expect(assertPerCall(100, caps)).toEqual({ ok: true });
  });

  it("rejects before payment when task aggregate would be exceeded", () => {
    expect(assertAggregateCaps(100, caps, 200, 0)).toMatchObject({
      ok: false,
      detail: "per-task cap would be exceeded before payment"
    });
  });

  it("admits a call that lands exactly on the per-task cap", () => {
    expect(assertAggregateCaps(50, caps, 200, 0)).toEqual({ ok: true });
  });

  it("rejects before payment when daily aggregate would be exceeded", () => {
    expect(assertAggregateCaps(100, caps, 0, 450)).toMatchObject({
      ok: false,
      detail: "daily cap would be exceeded before payment"
    });
  });

  it("rejects before refund when daily refund cap would be exceeded", () => {
    expect(assertRefundCap(100, caps, 150)).toMatchObject({
      ok: false,
      detail: "daily refund cap would be exceeded before refund"
    });
  });

  it("admits a refund that lands exactly on the daily refund cap", () => {
    expect(assertRefundCap(50, caps, 150)).toEqual({ ok: true });
  });
});
