import http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRequirements,
  ChargingNotConfigured,
  encodeRequirements,
  encodeSettlement,
  paymentHeaderFrom,
  sellerConfigFromEnv,
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

async function startFacilitator(status: number, body: unknown) {
  const seen: unknown[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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

  it("accepts a payment the facilitator validates and carries the tx through", async () => {
    const { url, seen } = await startFacilitator(200, {
      isValid: true,
      payer: "0xbuyer",
      transaction: "0xsettled",
      amount: "4800000"
    });

    const requirements = buildRequirements(spec);
    const result = await verifyPayment("payment-header", requirements, { facilitatorUrl: url });

    expect(result).toMatchObject({ ok: true, payer: "0xbuyer", transaction: "0xsettled" });
    expect(seen[0]).toMatchObject({ paymentHeader: "payment-header", paymentRequirements: requirements.accepts[0] });
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

describe("header handling", () => {
  it("reads both the v2 and the legacy v1 header names", () => {
    expect(paymentHeaderFrom({ "payment-signature": "v2" })).toBe("v2");
    expect(paymentHeaderFrom({ "x-payment": "v1" })).toBe("v1");
    expect(paymentHeaderFrom({})).toBeUndefined();
  });

  it("encodes a settlement the buyer can decode", () => {
    const encoded = encodeSettlement({ ok: true, transaction: "0xabc", payer: "0xbuyer", amount: "1", raw: {} });
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual({
      status: "success",
      transaction: "0xabc",
      payer: "0xbuyer",
      amount: "1"
    });
  });
});
