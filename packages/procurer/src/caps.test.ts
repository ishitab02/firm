import { describe, expect, it } from "vitest";

import { assertAggregateCaps, assertPerCall, assertRefundCap, Caps } from "./caps.js";
import { units } from "./money.js";

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

/**
 * Above 2^53-1 a JS number stops being exact, and every cap comparison in this
 * package is a number. The signature covers the vendor's original string, not
 * our rounded copy, so a silent conversion means the caps approved an amount
 * nobody authorised. Unreachable at 6 decimals (9e9 USDT); 0.009 tokens at 18.
 */
describe("base-unit safety", () => {
  it("refuses an amount past the safe integer range instead of rounding it", () => {
    expect(() => units({ amount: "9007199254740993", decimals: 18, token: "WETH" })).toThrow(
      /safe integer range/
    );
  });

  it("still accepts the largest exactly-representable amount", () => {
    expect(units({ amount: "9007199254740991", decimals: 6, token: "USDT" })).toBe(9007199254740991);
  });

  it("leaves realistic amounts alone", () => {
    expect(units({ amount: "15", decimals: 6, token: "USDT" })).toBe(15);
    expect(units({ amount: "3000000", decimals: 6, token: "USDT" })).toBe(3000000);
  });
});
