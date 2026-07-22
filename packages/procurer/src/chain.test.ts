import { describe, expect, it } from "vitest";

import { chainIdFromNetwork, domainSeparatorFor, matchDomain, rpcUrlFor, type VerifiedDomain } from "./chain.js";
import { X402Error } from "./x402.js";

const USDT0 = "0x779ded0c9e1022225f8e0630b35a9b54be713736";

/**
 * Read from the live contract on 2026-07-22 with `DOMAIN_SEPARATOR()`. Kept as a
 * fixture so the trap below is guarded offline and forever, not just on the day
 * someone happens to run a probe.
 */
const USDT0_DOMAIN_SEPARATOR = "0xd591d9baf744328d9400b923cb02c9474d367d591ca1ab24d8c4068be527599d";

describe("chainIdFromNetwork", () => {
  it("reads a CAIP-2 network", () => {
    expect(chainIdFromNetwork("eip155:196")).toBe(196);
    expect(chainIdFromNetwork("EIP155:1")).toBe(1);
  });

  it("accepts a bare chain id", () => {
    expect(chainIdFromNetwork("196")).toBe(196);
  });

  // The chain id is part of the signed domain. Defaulting here would produce a
  // signature valid on a chain nobody chose, so an unparseable network refuses.
  it("refuses anything it cannot parse rather than defaulting", () => {
    for (const bad of ["solana:mainnet", "", "xlayer", "eip155:", "eip155:abc"]) {
      expect(() => chainIdFromNetwork(bad)).toThrow(X402Error);
    }
  });
});

describe("rpcUrlFor", () => {
  it("prefers a chain-specific endpoint over the generic one", () => {
    process.env.X402_RPC_URL = "https://generic.example";
    process.env.X402_RPC_URL_196 = "https://specific.example";
    try {
      expect(rpcUrlFor(196)).toBe("https://specific.example");
      expect(rpcUrlFor(1)).toBe("https://generic.example");
    } finally {
      delete process.env.X402_RPC_URL;
      delete process.env.X402_RPC_URL_196;
    }
  });

  it("refuses an unconfigured chain instead of guessing an endpoint", () => {
    expect(() => rpcUrlFor(999999)).toThrow(X402Error);
  });
});

/**
 * The trap this whole module exists for.
 *
 * USD₮0's name uses U+20AE (₮), not an ASCII T. "USDT0" renders near-identically
 * in most fonts and is the obvious guess. A signature built on the wrong domain
 * is well-formed and accepted by the vendor — it simply never redeems, so the
 * money silently does not move and the failure surfaces far from its cause.
 */
describe("EIP-712 domain verification", () => {
  const correct: VerifiedDomain = {
    name: "USD₮0",
    version: "1",
    chainId: 196,
    verifyingContract: USDT0
  };

  it("reproduces the live token's DOMAIN_SEPARATOR", () => {
    expect(domainSeparatorFor(correct).toLowerCase()).toBe(USDT0_DOMAIN_SEPARATOR);
  });

  it("does NOT match the ASCII lookalike name", () => {
    const ascii = { ...correct, name: "USDT0" };
    expect(domainSeparatorFor(ascii).toLowerCase()).not.toBe(USDT0_DOMAIN_SEPARATOR);
  });

  it("does not match on the wrong version or chain", () => {
    expect(domainSeparatorFor({ ...correct, version: "2" }).toLowerCase()).not.toBe(USDT0_DOMAIN_SEPARATOR);
    expect(domainSeparatorFor({ ...correct, chainId: 1 }).toLowerCase()).not.toBe(USDT0_DOMAIN_SEPARATOR);
  });

  it("picks the matching candidate out of a list", () => {
    const candidates: VerifiedDomain[] = [
      { ...correct, name: "USDT0" },
      { ...correct, version: "2" },
      correct
    ];
    expect(matchDomain(candidates, USDT0_DOMAIN_SEPARATOR)).toEqual(correct);
  });

  // Fail closed. Returning the first candidate when nothing matches is precisely
  // how an unredeemable signature would get produced.
  it("returns null rather than a best guess when nothing matches", () => {
    const candidates: VerifiedDomain[] = [
      { ...correct, name: "USDT0" },
      { ...correct, version: "9" }
    ];
    expect(matchDomain(candidates, USDT0_DOMAIN_SEPARATOR)).toBeNull();
  });

  it("never matches an empty candidate list", () => {
    expect(matchDomain([], USDT0_DOMAIN_SEPARATOR)).toBeNull();
  });
});
