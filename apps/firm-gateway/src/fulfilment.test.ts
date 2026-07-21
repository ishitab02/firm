import { describe, expect, it } from "vitest";

import { fulfilmentFailure } from "./fulfilment.js";

const live = { realPayments: true, walletKeyPresent: true };

/**
 * The incoherent pairing: the gateway takes real money while the procurer
 * simulates vendor calls. Neither service can see it alone — the gateway knows
 * it is charging, the procurer knows it is simulating, only the pair is wrong.
 */
describe("fulfilment coherence", () => {
  it("refuses to charge real money while the procurer simulates", () => {
    const reason = fulfilmentFailure({ charging: true, mode: { realPayments: false, walletKeyPresent: false } });
    expect(reason).toMatch(/SIMULATION mode/);
  });

  it("refuses to charge when the procurer is unreachable", () => {
    // A gateway that takes money with no fulfilment backend produces the
    // "paid, then PENDING forever" outcome, which is indistinguishable from
    // having simply taken the money.
    expect(fulfilmentFailure({ charging: true, mode: null })).toMatch(/unreachable/);
  });

  it("refuses when real payments are on but no wallet key is loaded", () => {
    const reason = fulfilmentFailure({ charging: true, mode: { realPayments: true, walletKeyPresent: false } });
    expect(reason).toMatch(/no wallet key/);
  });

  it("allows the coherent live pairing", () => {
    expect(fulfilmentFailure({ charging: true, mode: live })).toBe(null);
  });

  // Bypass mode is the eval and local-development path. Nothing is charged, so
  // a simulating procurer is exactly right and must not block startup.
  it("does not constrain a gateway that is not charging", () => {
    expect(fulfilmentFailure({ charging: false, mode: null })).toBe(null);
    expect(fulfilmentFailure({ charging: false, mode: { realPayments: false, walletKeyPresent: false } })).toBe(null);
  });
});
