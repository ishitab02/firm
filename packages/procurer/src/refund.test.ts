import { describe, expect, it } from "vitest";

import { refundMode } from "./refund.js";

/**
 * The four combinations of the two independent switches. The third case is the
 * one that matters: it was a real defect, found by review after G2 — real
 * payments on, real refunds off returned a `SIMULATED:refund:*` hash that the
 * worker persisted and reported as REFUNDED, for a buyer who had genuinely paid.
 */
describe("refund mode policy", () => {
  it("sends a real refund whenever real refunds are enabled", () => {
    expect(refundMode({ realPayments: true, realRefunds: true })).toBe("real");
  });

  it("simulates only when the payment was also simulated", () => {
    expect(refundMode({ realPayments: false, realRefunds: false })).toBe("simulated");
  });

  it("never simulates a refund against a real payment", () => {
    expect(refundMode({ realPayments: true, realRefunds: false })).toBe("requires_human");
  });

  // Odd but harmless: refunds are armed, payments are not. Honouring it beats
  // second-guessing an operator who explicitly turned real refunds on.
  it("honours real refunds even when payments are simulated", () => {
    expect(refundMode({ realPayments: false, realRefunds: true })).toBe("real");
  });

  it("has no configuration that fabricates a hash for real money", () => {
    for (const realPayments of [true, false]) {
      for (const realRefunds of [true, false]) {
        const mode = refundMode({ realPayments, realRefunds });
        if (realPayments) expect(mode).not.toBe("simulated");
      }
    }
  });
});
