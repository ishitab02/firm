import http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRequirements,
  ChargingNotConfigured,
  encodeRequirements,
  encodeSettlement,
  facilitatorUrlFor,
  decodePaymentHeader,
  unwrapFacilitatorResponse,
  paymentHeaderFrom,
  sellerConfigFromEnv,
  settlePayment,
  verifyPayment
} from "./charging.js";

const spec = {
  amount: "4800000",
  decimals: 6,
  asset: "0xAAAA",
  network: "eip155:196",
  payTo: "0xfirm",
  resource: "firm:execute:q_1",
  description: "The Firm"
};

const servers: http.Server[] = [];

/**
 * Records the path as well as the body, because verify and settle are distinct
 * operations against distinct routes and a fake that answers both identically
 * would hide the difference — which is exactly how "we never settle" survived
 * a green test suite.
 */
async function startFacilitator(status: number, body: unknown) {
  // Typed as a record so assertions can read specific fields — the request body
  // shape is the thing under test, not an opaque blob.
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push({ path: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  delete process.env.FIRM_PAYTO_ADDRESS;
  delete process.env.FIRM_CHARGE_ASSET;
  delete process.env.FIRM_CHARGE_NETWORK;
});

describe("seller configuration", () => {
  it("refuses to charge with an incomplete configuration rather than defaulting", () => {
    expect(() => sellerConfigFromEnv()).toThrow(ChargingNotConfigured);

    process.env.FIRM_PAYTO_ADDRESS = "0xfirm";
    expect(() => sellerConfigFromEnv()).toThrow(ChargingNotConfigured);

    process.env.FIRM_CHARGE_ASSET = "0xAAAA";
    process.env.FIRM_CHARGE_NETWORK = "eip155:196";
    expect(sellerConfigFromEnv()).toMatchObject({ payTo: "0xfirm", asset: "0xAAAA" });
  });
});

describe("facilitatorUrlFor", () => {
  // OKX's facilitator lives under a path prefix, and `new URL("/verify", base)`
  // drops it — a leading slash resets to the root. Every call would have gone
  // to https://web3.okx.com/verify, and the failure would have read as "the
  // facilitator rejected us" rather than "we called a URL that does not exist".
  it("preserves a path prefix on the base URL", () => {
    expect(facilitatorUrlFor("https://web3.okx.com/api/v6/pay/x402", "verify")).toBe(
      "https://web3.okx.com/api/v6/pay/x402/verify"
    );
    expect(facilitatorUrlFor("https://web3.okx.com/api/v6/pay/x402", "settle")).toBe(
      "https://web3.okx.com/api/v6/pay/x402/settle"
    );
  });

  it("tolerates a trailing slash and a leading slash on the route", () => {
    expect(facilitatorUrlFor("https://host/api/", "verify")).toBe("https://host/api/verify");
    expect(facilitatorUrlFor("https://host/api", "/verify")).toBe("https://host/api/verify");
  });

  it("still works for a bare host, which is what the local fake uses", () => {
    expect(facilitatorUrlFor("http://127.0.0.1:9999", "settle")).toBe("http://127.0.0.1:9999/settle");
  });
});

describe("buildRequirements", () => {
  it("charges exactly the quoted amount under both the v1 and v2 field names", () => {
    const requirements = buildRequirements(spec);
    const entry = requirements.accepts[0];

    expect(requirements.x402Version).toBe(2);
    expect(entry.amount).toBe("4800000");
    expect(entry.maxAmountRequired).toBe("4800000");
    expect(entry.payTo).toBe("0xfirm");
    expect(entry.scheme).toBe("exact");
  });

  it("round-trips through the PAYMENT-REQUIRED encoding", () => {
    const requirements = buildRequirements(spec);
    const decoded = JSON.parse(Buffer.from(encodeRequirements(requirements), "base64").toString("utf8"));
    expect(decoded).toEqual(requirements);
  });
});

/**
 * A realistic buyer header: base64 JSON, the shape a signed x402 v2 payment
 * actually arrives in. The suite used to pass literal strings like "h", which
 * could never decode — so it exercised the facilitator branches while never
 * once covering the encoding the gateway sends. That gap is exactly where the
 * `paymentHeader` vs `paymentPayload` bug lived.
 */
const PAYMENT_PAYLOAD = {
  x402Version: 2,
  scheme: "exact",
  network: "eip155:196",
  payload: {
    authorization: { from: "0xbuyer", to: "0xseller", value: "4800000", validAfter: "0", validBefore: "9", nonce: "0xab" },
    signature: "0xsig"
  }
};
const HEADER = Buffer.from(JSON.stringify(PAYMENT_PAYLOAD), "utf8").toString("base64");

describe("verifyPayment", () => {
  it("fails closed when there is no payment header", async () => {
    const result = await verifyPayment(undefined, buildRequirements(spec), { facilitatorUrl: "http://unused" });
    expect(result).toMatchObject({ ok: false, reason: /no payment header/ });
  });

  it("fails closed when no facilitator is configured, rather than assuming payment", async () => {
    const result = await verifyPayment(HEADER, buildRequirements(spec), {});
    expect(result).toMatchObject({ ok: false, reason: /not configured/ });
  });

  // Verification answers "is this signature valid for these requirements". It
  // does not broadcast anything, so a real facilitator has no transaction to
  // report here. The fixture used to return `transaction: "0xsettled"`, which
  // made this test look like proof that payment had settled when nothing in the
  // gateway had settled anything.
  it("accepts a payment the facilitator validates, and hits /verify to do it", async () => {
    const { url, seen } = await startFacilitator(200, { isValid: true, payer: "0xbuyer", amount: "4800000" });

    const requirements = buildRequirements(spec);
    const result = await verifyPayment(HEADER, requirements, { facilitatorUrl: url });

    expect(result).toMatchObject({ ok: true, payer: "0xbuyer" });
    expect(seen[0].path).toBe("/verify");
    // The decoded payload, not the base64 string. OKX's facilitator answers
    // 30001 "incorrect params" to the latter, which the gateway surfaced as a
    // generic rejection — indistinguishable from a buyer sending a bad signature.
    expect(seen[0].body).toMatchObject({
      x402Version: 2,
      paymentPayload: PAYMENT_PAYLOAD,
      paymentRequirements: requirements.accepts[0]
    });
    expect(seen[0].body.paymentHeader).toBeUndefined();
  });

  it("rejects when the facilitator says the payment is invalid", async () => {
    const { url } = await startFacilitator(200, { isValid: false, invalidReason: "insufficient_funds" });
    const result = await verifyPayment(HEADER, buildRequirements(spec), { facilitatorUrl: url });
    expect(result).toMatchObject({ ok: false, reason: "insufficient_funds" });
  });

  it("rejects when the facilitator itself errors", async () => {
    const { url } = await startFacilitator(500, { error: "boom" });
    const result = await verifyPayment(HEADER, buildRequirements(spec), { facilitatorUrl: url });
    expect(result).toMatchObject({ ok: false, reason: /HTTP 500/ });
  });

  it("rejects when the facilitator is unreachable", async () => {
    const result = await verifyPayment(HEADER, buildRequirements(spec), { facilitatorUrl: "http://127.0.0.1:1" });
    expect(result).toMatchObject({ ok: false, reason: /verification failed/ });
  });
});

/**
 * Settlement is the step that actually redeems the buyer's authorization. The
 * gateway used to stop after verification, which meant every paid call was
 * served for free while the response header claimed a successful payment.
 */
describe("settlePayment", () => {
  it("settles against /settle and returns the transaction", async () => {
    const { url, seen } = await startFacilitator(200, {
      success: true,
      transaction: "0xsettled",
      payer: "0xbuyer",
      amount: "4800000"
    });

    const requirements = buildRequirements(spec);
    const result = await settlePayment(HEADER, requirements, { facilitatorUrl: url });

    expect(result).toMatchObject({ ok: true, transaction: "0xsettled", payer: "0xbuyer" });
    expect(seen[0].path).toBe("/settle");
  });

  // "Settled, but we cannot tell you the transaction" is indistinguishable from
  // "not settled", and the PAYMENT-RESPONSE header would be asserting a payment
  // we have no evidence for.
  it("refuses to report success without a transaction reference", async () => {
    const { url } = await startFacilitator(200, { success: true, payer: "0xbuyer" });
    const result = await settlePayment(HEADER, buildRequirements(spec), { facilitatorUrl: url });
    expect(result).toMatchObject({ ok: false, reason: /without a transaction reference/ });
  });

  it("fails closed when the facilitator declines to settle", async () => {
    const { url } = await startFacilitator(200, { success: false, errorReason: "authorization_expired" });
    const result = await settlePayment(HEADER, buildRequirements(spec), { facilitatorUrl: url });
    expect(result).toMatchObject({ ok: false, reason: "authorization_expired" });
  });

  it("fails closed when no facilitator is configured, rather than assuming settlement", async () => {
    const result = await settlePayment(HEADER, buildRequirements(spec), {});
    expect(result).toMatchObject({ ok: false, reason: /not configured/ });
  });

  it("fails closed when the facilitator errors or is unreachable", async () => {
    const { url } = await startFacilitator(500, { error: "boom" });
    expect(await settlePayment(HEADER, buildRequirements(spec), { facilitatorUrl: url })).toMatchObject({
      ok: false,
      reason: /HTTP 500/
    });
    expect(await settlePayment(HEADER, buildRequirements(spec), { facilitatorUrl: "http://127.0.0.1:1" })).toMatchObject({
      ok: false,
      reason: /settlement failed/
    });
  });
});

describe("header handling", () => {
  it("reads both the v2 and the legacy v1 header names", () => {
    expect(paymentHeaderFrom({ "payment-signature": "v2" })).toBe("v2");
    expect(paymentHeaderFrom({ "x-payment": "v1" })).toBe("v1");
    expect(paymentHeaderFrom({})).toBeUndefined();
  });

  // Shape verified against the real thing: the PAYMENT-RESPONSE headers OKLink
  // #2023 returned for G1 and G2 decode to
  //   {"success":true,"transaction":"0x…","network":"eip155:196","payer":"0x…"}
  // so `success` is the field the marketplace actually uses. We emit `status`
  // too, since the x402 spec examples use that.
  it("encodes a settlement in the shape real marketplace ASPs emit", () => {
    const encoded = encodeSettlement({
      ok: true,
      transaction: "0xabc",
      payer: "0xbuyer",
      amount: "1",
      network: "eip155:196",
      raw: {}
    });
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual({
      success: true,
      status: "success",
      transaction: "0xabc",
      network: "eip155:196",
      payer: "0xbuyer",
      amount: "1"
    });
  });
});

/**
 * The bug this pins: OKX's facilitator takes a decoded `paymentPayload` object.
 * Sending the base64 header string under `paymentHeader` returns
 * `30001 incorrect params`, which the gateway reported as "facilitator rejected
 * the payment" — identical to a buyer submitting a bad signature. Every inbound
 * payment the Firm received failed this way and looked like the buyer's fault.
 *
 * Verified against the live facilitator with a real Agentic Wallet signature:
 * the same signature that returned 30001 under `paymentHeader` returned
 * `isValid: true` under `paymentPayload`. See scripts/probe-facilitator.ts.
 */
describe("facilitator request encoding", () => {
  it("decodes a base64 header into an object", () => {
    expect(decodePaymentHeader(HEADER)).toEqual(PAYMENT_PAYLOAD);
  });

  it("accepts base64url as well as base64", () => {
    const urlSafe = HEADER.replaceAll("+", "-").replaceAll("/", "_");
    expect(decodePaymentHeader(urlSafe)).toEqual(PAYMENT_PAYLOAD);
  });

  // Refuse rather than forward something the facilitator would reject anyway —
  // an undecodable header is a malformed request, not a payment dispute.
  it("returns null for anything that is not base64 JSON", () => {
    for (const bad of ["h", "payment-header", "", "!!!!", Buffer.from("[1,2]").toString("base64")]) {
      expect(decodePaymentHeader(bad)).toBeNull();
    }
  });

  it("refuses to call the facilitator at all with an undecodable header", async () => {
    const { url, seen } = await startFacilitator(200, { isValid: true });
    const result = await verifyPayment("not-base64-json", buildRequirements(spec), { facilitatorUrl: url });
    expect(result).toMatchObject({ ok: false, reason: /not decodable/ });
    expect(seen).toHaveLength(0);
  });

  it("sends the decoded payload to settle too, not just verify", async () => {
    const { url, seen } = await startFacilitator(200, { success: true, transaction: "0xtx" });
    await settlePayment(HEADER, buildRequirements(spec), { facilitatorUrl: url });
    expect(seen[0].path).toBe("/settle");
    expect(seen[0].body.paymentPayload).toEqual(PAYMENT_PAYLOAD);
    expect(seen[0].body.paymentHeader).toBeUndefined();
  });
});

/**
 * OKX wraps results in `{code, data, error_code, error_message, msg}`. Reading
 * `raw.isValid` instead of `raw.data.isValid` scored a VALID payment invalid and
 * rejected it — and because OKX errors carry none of `invalidReason`/`reason`/
 * `error`, every failure also read as the same generic string. A malformed
 * request and a buyer's bad signature were indistinguishable for as long as
 * that held.
 */
describe("facilitator response envelope", () => {
  const OKX_OK = { code: 0, data: { isValid: true, payer: "0xbuyer", invalidReason: null }, error_code: "0", msg: "" };
  const OKX_ERR = { code: 30001, data: {}, error_code: "30001", error_message: "incorrect params", msg: "incorrect params" };

  it("reads isValid out of the data envelope", () => {
    expect(unwrapFacilitatorResponse(OKX_OK).payload.isValid).toBe(true);
    expect(unwrapFacilitatorResponse(OKX_OK).errorText).toBeNull();
  });

  it("surfaces the OKX error message instead of swallowing it", () => {
    expect(unwrapFacilitatorResponse(OKX_ERR).errorText).toBe("incorrect params");
  });

  // The generic x402 spec returns these at the top level; both must work.
  it("still handles an unwrapped, spec-shaped response", () => {
    const flat = { isValid: true, payer: "0xbuyer" };
    expect(unwrapFacilitatorResponse(flat).payload.isValid).toBe(true);
  });

  it("accepts a wrapped valid payment end to end", async () => {
    const { url } = await startFacilitator(200, OKX_OK);
    const result = await verifyPayment(HEADER, buildRequirements(spec), { facilitatorUrl: url });
    expect(result).toMatchObject({ ok: true, payer: "0xbuyer" });
  });

  it("reports the real reason for a wrapped rejection", async () => {
    const { url } = await startFacilitator(200, OKX_ERR);
    const result = await verifyPayment(HEADER, buildRequirements(spec), { facilitatorUrl: url });
    expect(result).toMatchObject({ ok: false, reason: "incorrect params" });
  });

  it("settles from the wrapped envelope too", async () => {
    const { url } = await startFacilitator(200, {
      code: 0, error_code: "0", data: { success: true, transaction: "0xtx", network: "eip155:196" }
    });
    const result = await settlePayment(HEADER, buildRequirements(spec), { facilitatorUrl: url });
    expect(result).toMatchObject({ ok: true, transaction: "0xtx" });
  });
});
