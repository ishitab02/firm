/**
 * Bearer-token check for the procurer's spending routes.
 *
 * The procurer is the only component that can move the Firm's money, and its
 * HTTP surface has no other gate: anything that can POST /pay-and-call can
 * spend up to the caps. That is acceptable on loopback and not acceptable
 * anywhere else, which is why server.ts refuses a non-loopback bind without a
 * token configured.
 *
 * No token configured means no check, so local development and the existing
 * test suites are unchanged.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time compare so a caller cannot recover the token by measuring how
 * long a rejection takes. Length is compared first and leaks only the length,
 * which timingSafeEqual cannot hide anyway — it throws on a length mismatch.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Returns null when the request may proceed, or the reason it may not. */
export function bearerFailure(header: string | string[] | undefined, expected: string | undefined): string | null {
  if (!expected) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) {
    return "missing bearer token";
  }
  return tokenMatches(value.slice("Bearer ".length), expected) ? null : "invalid token";
}
