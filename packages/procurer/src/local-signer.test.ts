import { describe, expect, it } from "vitest";

import { nonceFor, paymentHeaderFor, validityWindow, walletKeyFromEnv } from "./local-signer.js";
import { X402Error, type SelectedOffer } from "./x402.js";

const WALLET = "0xC0296012Cfbb0e6DF5dA7158B65Dbc46DD9650e0";
const OTHER_WALLET = "0x212e82dc1d13b991d5318d970963f5ddfd81a178";

function offer(overrides: Partial<SelectedOffer> = {}): SelectedOffer {
  return {
    acceptsIndex: 0,
    entry: { scheme: "exact", network: "eip155:196", maxTimeoutSeconds: 300 },
    amountUnits: 15,
    scheme: "exact",
    network: "eip155:196",
    asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
    payTo: OTHER_WALLET,
    declaredDecimals: null,
    ...overrides
  };
}

/**
 * The nonce is derived, not random, so that re-signing the same subtask
 * reproduces the same authorization. EIP-3009 nonces are single-use on-chain,
 * which makes the token itself the enforcer of at-most-once payment — a bug in
 * our retry logic becomes a harmless duplicate instead of a double-spend.
 */
describe("nonce derivation", () => {
  it("is stable for the same payment", () => {
    expect(nonceFor("task-1:sub-1:https://vendor", WALLET)).toBe(nonceFor("task-1:sub-1:https://vendor", WALLET));
  });

  it("differs across subtasks", () => {
    expect(nonceFor("task-1:sub-1:https://vendor", WALLET)).not.toBe(nonceFor("task-1:sub-2:https://vendor", WALLET));
  });

  it("differs across vendors for the same subtask", () => {
    expect(nonceFor("task-1:sub-1:https://a", WALLET)).not.toBe(nonceFor("task-1:sub-1:https://b", WALLET));
  });

  // The token keys used-nonces per authorizer, so two wallets could otherwise
  // collide on a shared task id.
  it("differs across wallets", () => {
    expect(nonceFor("task-1:sub-1:https://vendor", WALLET)).not.toBe(
      nonceFor("task-1:sub-1:https://vendor", OTHER_WALLET)
    );
  });

  it("is a 32-byte hex value", () => {
    expect(nonceFor("seed", WALLET)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is case-insensitive in the wallet, since addresses have two spellings", () => {
    expect(nonceFor("seed", WALLET)).toBe(nonceFor("seed", WALLET.toLowerCase() as typeof WALLET));
  });
});

describe("validity window", () => {
  const now = 1_700_000_000_000;

  it("honours the vendor's requested timeout", () => {
    const w = validityWindow(offer({ entry: { maxTimeoutSeconds: 3600 } }), now);
    expect(Number(w.validBefore) - Math.floor(now / 1000)).toBe(3600 + 60);
  });

  // A vendor asking for 0 (or omitting it) must still get a usable window.
  it("applies a floor when the vendor asks for nothing usable", () => {
    for (const entry of [{ maxTimeoutSeconds: 0 }, {}, { maxTimeoutSeconds: -5 }]) {
      const w = validityWindow(offer({ entry }), now);
      expect(Number(w.validBefore)).toBeGreaterThan(Math.floor(now / 1000) + 600);
    }
  });

  // "0" matches the CLI output that G1 and G2 paid with. A backdated timestamp
  // was tried first; it is strictly more restrictive, and on a path whose whole
  // failure mode is a seller rejecting the authorization there is no reason to
  // be stricter than the implementation that demonstrably gets accepted.
  it("sets no lower time bound, matching the known-good producer", () => {
    expect(validityWindow(offer(), now).validAfter).toBe("0");
  });

  it("always produces a window that is open, not inverted", () => {
    for (const seconds of [0, 1, 300, 86_400]) {
      const w = validityWindow(offer({ entry: { maxTimeoutSeconds: seconds } }), now);
      expect(Number(w.validBefore)).toBeGreaterThan(Number(w.validAfter));
    }
  });
});

/**
 * These pin the shape observed from the OKX CLI — the producer whose headers
 * paid G1 and G2 — after G3 was rejected by OKLink #2023 for sending a body
 * assembled by analogy with v1. See scripts/diff-signers.ts.
 */
describe("payment header assembly", () => {
  const proof = {
    signature: "0xabc" as `0x${string}`,
    authorization: {
      from: WALLET as `0x${string}`,
      to: OTHER_WALLET as `0x${string}`,
      value: "15",
      validAfter: "0",
      validBefore: "2",
      nonce: "0xdead" as `0x${string}`
    }
  };

  const v1 = { version: 1, envelope: {} };
  const v2 = {
    version: 2,
    envelope: { resource: { url: "https://vendor.example/tool", mimeType: "application/json" } }
  };
  const decode = (value: string) => JSON.parse(Buffer.from(value, "base64").toString("utf8"));

  it("uses X-PAYMENT for v1", () => {
    const header = paymentHeaderFor(v1, offer(), proof);
    expect(header.headerName).toBe("X-PAYMENT");
    expect(decode(header.headerValue).x402Version).toBe(1);
  });

  it("uses PAYMENT-SIGNATURE for v2 and echoes the vendor's version", () => {
    const header = paymentHeaderFor(v2, offer(), proof);
    expect(header.headerName).toBe("PAYMENT-SIGNATURE");
    expect(decode(header.headerValue).x402Version).toBe(2);
  });

  // The two fields whose absence caused the G3 rejection.
  it("echoes the selected accepts entry as `accepted`", () => {
    const selected = offer();
    const decoded = decode(paymentHeaderFor(v2, selected, proof).headerValue);
    expect(decoded.accepted).toEqual(selected.entry);
    // Decomposing into flat scheme/network is what failed; it must not return.
    expect(decoded.scheme).toBeUndefined();
    expect(decoded.network).toBeUndefined();
  });

  it("echoes the challenge's resource", () => {
    const decoded = decode(paymentHeaderFor(v2, offer(), proof).headerValue);
    expect(decoded.resource).toEqual(v2.envelope.resource);
  });

  // A vendor that sends no resource must not receive a literal `undefined`.
  it("omits resource entirely when the challenge carried none", () => {
    const decoded = decode(paymentHeaderFor({ version: 2, envelope: {} }, offer(), proof).headerValue);
    expect("resource" in decoded).toBe(false);
  });

  // The signature covers the amount, so the header must carry exactly what was
  // signed and cap-checked — never a reformatted copy.
  it("carries the signed authorization verbatim in both versions", () => {
    for (const challenge of [v1, v2]) {
      const decoded = decode(paymentHeaderFor(challenge, offer(), proof).headerValue);
      expect(decoded.payload.authorization).toEqual(proof.authorization);
      expect(decoded.payload.signature).toBe(proof.signature);
    }
  });
});

describe("wallet key validation", () => {
  const original = process.env.FIRM_WALLET_KEY;
  const restore = () => {
    if (original === undefined) delete process.env.FIRM_WALLET_KEY;
    else process.env.FIRM_WALLET_KEY = original;
  };

  it("refuses to sign with no key at all", () => {
    delete process.env.FIRM_WALLET_KEY;
    try {
      expect(() => walletKeyFromEnv()).toThrow(X402Error);
    } finally {
      restore();
    }
  });

  it("accepts a key with or without the 0x prefix", () => {
    const bare = "1".repeat(64);
    process.env.FIRM_WALLET_KEY = bare;
    try {
      expect(walletKeyFromEnv()).toBe(`0x${bare}`);
      process.env.FIRM_WALLET_KEY = `0x${bare}`;
      expect(walletKeyFromEnv()).toBe(`0x${bare}`);
    } finally {
      restore();
    }
  });

  // A truncated or mistyped key would otherwise fail deep inside viem with a
  // message that reads like a signing bug rather than a config one.
  it("rejects anything that is not 32 bytes of hex", () => {
    for (const bad of ["0x123", "not-a-key", "0x" + "z".repeat(64), "1".repeat(63)]) {
      process.env.FIRM_WALLET_KEY = bad;
      expect(() => walletKeyFromEnv()).toThrow(X402Error);
    }
    restore();
  });
});
