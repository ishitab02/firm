import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { okxCredentialsFromEnv, signOkxRequest, splitForSigning } from "./okx-auth.js";

const credentials = { apiKey: "key-1", secretKey: "s3cret", passphrase: "pass-1" };

afterEach(() => {
  delete process.env.OKX_API_KEY;
  delete process.env.OKX_SECRET_KEY;
  delete process.env.OKX_PASSPHRASE;
});

describe("okxCredentialsFromEnv", () => {
  // Null is a legitimate state, not an error: without credentials the gateway
  // cannot settle, so it fails closed and 402s rather than serving free work.
  it("returns null unless all three are present", () => {
    expect(okxCredentialsFromEnv()).toBe(null);

    process.env.OKX_API_KEY = "key-1";
    expect(okxCredentialsFromEnv()).toBe(null);

    process.env.OKX_SECRET_KEY = "s3cret";
    expect(okxCredentialsFromEnv()).toBe(null);

    process.env.OKX_PASSPHRASE = "pass-1";
    expect(okxCredentialsFromEnv()).toEqual(credentials);
  });
});

describe("splitForSigning", () => {
  // Signing over the full URL instead of the path is the most common way to
  // get OKX auth wrong, and it fails with the same opaque error as a bad key.
  it("returns the path and query, not the scheme or host", () => {
    expect(splitForSigning("https://web3.okx.com/api/v6/pay/x402/settle")).toEqual({
      origin: "https://web3.okx.com",
      requestPath: "/api/v6/pay/x402/settle"
    });
  });

  it("keeps the query string, which is part of what gets signed", () => {
    expect(splitForSigning("https://web3.okx.com/api/v6/pay/x402/settle/status?txHash=0xabc").requestPath).toBe(
      "/api/v6/pay/x402/settle/status?txHash=0xabc"
    );
  });
});

describe("signOkxRequest", () => {
  const timestamp = "2026-07-21T12:00:00.000Z";

  it("signs timestamp + METHOD + requestPath + body with HMAC-SHA256, base64", () => {
    const body = '{"paymentHeader":"abc"}';
    const headers = signOkxRequest(credentials, {
      method: "post",
      requestPath: "/api/v6/pay/x402/settle",
      body,
      timestamp
    });

    const expected = createHmac("sha256", "s3cret")
      .update(`${timestamp}POST/api/v6/pay/x402/settle${body}`)
      .digest("base64");

    expect(headers["OK-ACCESS-SIGN"]).toBe(expected);
    expect(headers["OK-ACCESS-KEY"]).toBe("key-1");
    expect(headers["OK-ACCESS-PASSPHRASE"]).toBe("pass-1");
    expect(headers["OK-ACCESS-TIMESTAMP"]).toBe(timestamp);
  });

  it("upper-cases the method, because the signature covers it verbatim", () => {
    const lower = signOkxRequest(credentials, { method: "post", requestPath: "/p", timestamp });
    const upper = signOkxRequest(credentials, { method: "POST", requestPath: "/p", timestamp });
    expect(lower["OK-ACCESS-SIGN"]).toBe(upper["OK-ACCESS-SIGN"]);
  });

  it("treats a missing body as the empty string", () => {
    const headers = signOkxRequest(credentials, { method: "GET", requestPath: "/p", timestamp });
    const expected = createHmac("sha256", "s3cret").update(`${timestamp}GET/p`).digest("base64");
    expect(headers["OK-ACCESS-SIGN"]).toBe(expected);
  });

  it("produces a different signature for a different body", () => {
    const a = signOkxRequest(credentials, { method: "POST", requestPath: "/p", body: "{}", timestamp });
    const b = signOkxRequest(credentials, { method: "POST", requestPath: "/p", body: '{"x":1}', timestamp });
    expect(a["OK-ACCESS-SIGN"]).not.toBe(b["OK-ACCESS-SIGN"]);
  });

  it("uses an ISO-8601 millisecond timestamp when none is supplied", () => {
    const headers = signOkxRequest(credentials, { method: "POST", requestPath: "/p" });
    expect(headers["OK-ACCESS-TIMESTAMP"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  // The secret authenticates us to OKX. It must never travel in a header, and
  // this is the cheap structural check that it does not.
  it("never puts the secret in the headers", () => {
    const headers = signOkxRequest(credentials, { method: "POST", requestPath: "/p", body: "{}", timestamp });
    expect(JSON.stringify(headers)).not.toContain("s3cret");
  });
});
