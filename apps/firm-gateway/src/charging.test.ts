import http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRequirements,
  ChargingNotConfigured,
  encodeRequirements,
  encodeSettlement,
  facilitatorUrlFor,
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
  const seen: Array<{ path: string; body: unknown }> = [];
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

describe("verifyPayment", () => {
  it("fails closed when there is no payment header", async () => {
    const result = await verifyPayment(undefined, buildRequirements(spec), { facilitatorUrl: "http://unused" });
    expect(result).toMatchObject({ ok: false, reason: /no payment header/ });
  });

  it("fails closed when no facilitator is configured, rather than assuming payment", async () => {
    const result = await verifyPayment("some-header", buildRequirements(spec), {});
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
    const result = await verifyPayment("payment-header", requirements, { facilitatorUrl: url });

    expect(result).toMatchObject({ ok: true, payer: "0xbuyer" });
    expect(seen[0].path).toBe("/verify");
    expect(seen[0].body).toMatchObject({
      paymentHeader: "payment-header",
      paymentRequirements: requirements.accepts[0]
    });
  });

  it("rejects when the facilitator says the payment is invalid", async () => {
    const { url } = await startFacilitator(200, { isValid: false, invalidReason: "insufficient_funds" });
    const result = await verifyPayment("h", buildRequirements(spec), { facilitatorUrl: url });
    expect(result).toMatchObject({ ok: false, reason: "insufficient_funds" });
  });

  it("rejects when the facilitator itself errors", async () => {
    const { url } = await startFacilitator(500, { error: "boom" });
    const result = await verifyPayment("h", buildRequirements(spec), { facilitatorUrl: url });
    expect(result).toMatchObject({ ok: false, reason: /HTTP 500/ });
  });

  it("rejects when the facilitator is unreachable", async () => {
    const result = await verifyPayment("h", buildRequirements(spec), { facilitatorUrl: "http://127.0.0.1:1" });
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
    const result = await settlePayment("payment-header", requirements, { facilitatorUrl: url });

    expect(result).toMatchObject({ ok: true, transaction: "0xsettled", payer: "0xbuyer" });
    expect(seen[0].path).toBe("/settle");
  });

  // "Settled, but we cannot tell you the transaction" is indistinguishable from
  // "not settled", and the PAYMENT-RESPONSE header would be asserting a payment
  // we have no evidence for.
  it("refuses to report success without a transaction reference", async () => {
    const { url } = await startFacilitator(200, { success: true, payer: "0xbuyer" });
    const result = await settlePayment("h", buildRequirements(spec), { facilitatorUrl: url });
    expect(result).toMatchObject({ ok: false, reason: /without a transaction reference/ });
  });

  it("fails closed when the facilitator declines to settle", async () => {
    const { url } = await startFacilitator(200, { success: false, errorReason: "authorization_expired" });
    const result = await settlePayment("h", buildRequirements(spec), { facilitatorUrl: url });
    expect(result).toMatchObject({ ok: false, reason: "authorization_expired" });
  });

  it("fails closed when no facilitator is configured, rather than assuming settlement", async () => {
    const result = await settlePayment("h", buildRequirements(spec), {});
    expect(result).toMatchObject({ ok: false, reason: /not configured/ });
  });

  it("fails closed when the facilitator errors or is unreachable", async () => {
    const { url } = await startFacilitator(500, { error: "boom" });
    expect(await settlePayment("h", buildRequirements(spec), { facilitatorUrl: url })).toMatchObject({
      ok: false,
      reason: /HTTP 500/
    });
    expect(await settlePayment("h", buildRequirements(spec), { facilitatorUrl: "http://127.0.0.1:1" })).toMatchObject({
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
