import { describe, expect, it } from "vitest";

import {
  assembleV1PaymentHeader,
  decodePaymentResponse,
  parseChallenge,
  selectOffer,
  X402Error
} from "./x402.js";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const exactEntry = (amount: string, extra: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: "eip155:196",
  asset: "0xAAAA",
  payTo: "0x0000000000000000000000000000000000000402",
  amount,
  ...extra
});

describe("parseChallenge", () => {
  it("reads a v2 challenge from the PAYMENT-REQUIRED header and keeps the payload verbatim", () => {
    const payload = { x402Version: 2, accepts: [exactEntry("100000")] };
    const header = b64(payload);
    const challenge = parseChallenge({ "payment-required": header }, { unrelated: true });

    expect(challenge.version).toBe(2);
    expect(challenge.payloadBase64).toBe(header);
    expect(challenge.accepts).toHaveLength(1);
  });

  it("reads a v1 challenge from the body and re-encodes it for the signer", () => {
    const body = { x402Version: 1, accepts: [{ ...exactEntry("0"), amount: undefined, maxAmountRequired: "90000" }] };
    const challenge = parseChallenge({}, body);

    expect(challenge.version).toBe(1);
    expect(JSON.parse(Buffer.from(challenge.payloadBase64, "base64").toString("utf8"))).toEqual(body);
  });

  it("prefers the header over the body when both are present", () => {
    const headerPayload = { x402Version: 2, accepts: [exactEntry("111")] };
    const challenge = parseChallenge(
      { "payment-required": b64(headerPayload) },
      { x402Version: 1, accepts: [exactEntry("999")] }
    );
    expect(selectOffer(challenge).amountUnits).toBe(111);
  });

  it("accepts base64url as well as base64", () => {
    const payload = { x402Version: 2, accepts: [exactEntry("100000")] };
    const urlSafe = b64(payload).replaceAll("+", "-").replaceAll("/", "_");
    expect(parseChallenge({ "payment-required": urlSafe }, {}).accepts).toHaveLength(1);
  });

  it("refuses a 402 shape it cannot sign rather than guessing", () => {
    // This is the mocks' legacy body shape: recognisable to a human, but it
    // carries no accepts[] so there is nothing the signer can act on.
    const legacy = { error: { code: "PAYMENT_REQUIRED", payment: { amount: { amount: "90000" } } } };
    expect(() => parseChallenge({}, legacy)).toThrow(X402Error);
  });
});

describe("selectOffer", () => {
  it("takes the cheapest signable entry", () => {
    const challenge = parseChallenge(
      { "payment-required": b64({ x402Version: 2, accepts: [exactEntry("300000"), exactEntry("100000")] }) },
      {}
    );
    const offer = selectOffer(challenge);
    expect(offer.amountUnits).toBe(100000);
    expect(offer.acceptsIndex).toBe(1);
  });

  it("breaks ties toward the lower accepts index", () => {
    const challenge = parseChallenge(
      { "payment-required": b64({ x402Version: 2, accepts: [exactEntry("100000"), exactEntry("100000")] }) },
      {}
    );
    expect(selectOffer(challenge).acceptsIndex).toBe(0);
  });

  it("skips aggr_deferred, which the local signer cannot produce", () => {
    const challenge = parseChallenge(
      {
        "payment-required": b64({
          x402Version: 2,
          accepts: [{ ...exactEntry("10"), scheme: "aggr_deferred" }, exactEntry("100000")]
        })
      },
      {}
    );
    const offer = selectOffer(challenge);
    expect(offer.scheme).toBe("exact");
    expect(offer.amountUnits).toBe(100000);
  });

  it("throws rather than paying when no entry is locally signable", () => {
    const challenge = parseChallenge(
      { "payment-required": b64({ x402Version: 2, accepts: [{ ...exactEntry("10"), scheme: "aggr_deferred" }] }) },
      {}
    );
    expect(() => selectOffer(challenge)).toThrow(/locally signable/);
  });

  it("honours the asset allow-list and refuses everything outside it", () => {
    const challenge = parseChallenge(
      {
        "payment-required": b64({
          x402Version: 2,
          accepts: [exactEntry("50000", { asset: "0xBBBB" }), exactEntry("100000", { asset: "0xAAAA" })]
        })
      },
      {}
    );
    const offer = selectOffer(challenge, { allowedAssets: ["0xaaaa"] });
    expect(offer.asset).toBe("0xAAAA");
    expect(() => selectOffer(challenge, { allowedAssets: ["0xCCCC"] })).toThrow(/asset-allowed/);
  });

  it("refuses an entry whose price is not a base-unit integer", () => {
    const challenge = parseChallenge(
      { "payment-required": b64({ x402Version: 2, accepts: [exactEntry("0.5")] }) },
      {}
    );
    expect(() => selectOffer(challenge)).toThrow(/base-unit integer price/);
  });

  it("refuses an empty accepts array", () => {
    const challenge = parseChallenge({ "payment-required": b64({ x402Version: 2, accepts: [] }) }, {});
    expect(() => selectOffer(challenge)).toThrow(/empty accepts/);
  });
});

describe("v1 header assembly and receipt decoding", () => {
  it("wraps the raw proof in the legacy X-PAYMENT envelope", () => {
    const challenge = parseChallenge({}, { x402Version: 1, accepts: [{ ...exactEntry("1"), maxAmountRequired: "1" }] });
    const offer = selectOffer(challenge);
    const header = assembleV1PaymentHeader(offer, { signature: "0xsig", authorization: { from: "0xme" } });

    expect(JSON.parse(Buffer.from(header, "base64").toString("utf8"))).toEqual({
      x402Version: 1,
      scheme: "exact",
      network: "eip155:196",
      payload: { signature: "0xsig", authorization: { from: "0xme" } }
    });
  });

  it("decodes a PAYMENT-RESPONSE header and tolerates a missing or corrupt one", () => {
    const settled = { status: "success", transaction: "0xabc", payer: "0xme" };
    expect(decodePaymentResponse(b64(settled))).toEqual(settled);
    expect(decodePaymentResponse(undefined)).toBeNull();
    expect(decodePaymentResponse("not base64 json")).toBeNull();
  });
});
