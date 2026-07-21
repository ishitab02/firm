import { describe, expect, it } from "vitest";

import { bearerFailure } from "./auth.js";

describe("procurer bearer auth", () => {
  it("allows everything when no token is configured, so loopback development is unchanged", () => {
    expect(bearerFailure(undefined, undefined)).toBe(null);
    expect(bearerFailure("Bearer anything", undefined)).toBe(null);
    expect(bearerFailure("garbage", "")).toBe(null);
  });

  it("accepts the configured token", () => {
    expect(bearerFailure("Bearer s3cret", "s3cret")).toBe(null);
  });

  // A wrong scheme is "missing", not "invalid": the bare token never reaches the
  // compare. Worth pinning, because a bare `Authorization: s3cret` would
  // otherwise look to a caller like a token problem rather than a format one.
  it("rejects anything that is not a well-formed bearer header", () => {
    expect(bearerFailure(undefined, "s3cret")).toBe("missing bearer token");
    expect(bearerFailure("s3cret", "s3cret")).toBe("missing bearer token");
    expect(bearerFailure("Basic s3cret", "s3cret")).toBe("missing bearer token");
  });

  it("rejects a well-formed header carrying the wrong token", () => {
    expect(bearerFailure("Bearer wrong!", "s3cret")).toBe("invalid token");
  });

  // A near-miss of a different length must not throw out of timingSafeEqual.
  it("rejects tokens of the wrong length without throwing", () => {
    expect(bearerFailure("Bearer s3", "s3cret")).toBe("invalid token");
    expect(bearerFailure("Bearer s3cretlonger", "s3cret")).toBe("invalid token");
    expect(bearerFailure("Bearer ", "s3cret")).toBe("invalid token");
  });

  it("reads a repeated header from its first value rather than ignoring it", () => {
    expect(bearerFailure(["Bearer s3cret", "Bearer other"], "s3cret")).toBe(null);
    expect(bearerFailure(["Bearer nope"], "s3cret")).toBe("invalid token");
  });
});
