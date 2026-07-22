import { describe, expect, it } from "vitest";

import { parseChallenge, payloadForOffer, selectOffer } from "./x402.js";

/**
 * The real 402 OKLink's Onchain Data Explorer (#2023) returned on 2026-07-21.
 * Kept verbatim so the shape we build against is the shape a live vendor sends,
 * not one we imagined.
 */
const OKLINK_CHALLENGE = {
  x402Version: 2,
  resource: {
    url: "https://www.oklink.com/api/v5/explorer/mcp/x402/get_address_balance_history",
    mimeType: "application/json"
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:196",
      amount: "15",
      payTo: "0xa7e37604ebab94408159e405033a455f820fd987",
      maxTimeoutSeconds: 86400,
      asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      extra: { name: "USD₮0", transferMethod: "eip3009", version: "1", symbol: "USDT" }
    },
    {
      scheme: "aggr_deferred",
      network: "eip155:196",
      amount: "15",
      payTo: "0xa7e37604ebab94408159e405033a455f820fd987",
      maxTimeoutSeconds: 86400,
      asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      extra: { name: "USD₮0", transferMethod: "eip3009", version: "1", symbol: "USDT" }
    }
  ]
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
const decode = (payload: string) => JSON.parse(Buffer.from(payload, "base64").toString("utf8"));

describe("the live OKLink challenge", () => {
  const challenge = parseChallenge({ "payment-required": b64(OKLINK_CHALLENGE) }, {});

  it("selects exact and refuses aggr_deferred, which pay-local cannot sign", () => {
    const offer = selectOffer(challenge, { allowedAssets: ["0x779ded0c9e1022225f8e0630b35a9b54be713736"] });
    expect(offer.scheme).toBe("exact");
    expect(offer.acceptsIndex).toBe(0);
    expect(offer.amountUnits).toBe(15);
  });

  it("records null decimals, because this vendor declares none", () => {
    // extra carries name/transferMethod/version/symbol but no decimals. Null is
    // the honest answer; assuming 6 would be inventing a verified fact.
    expect(selectOffer(challenge).declaredDecimals).toBeNull();
  });

  it("narrows the signer payload to exactly the offer that passed the caps", () => {
    const offer = selectOffer(challenge);
    const sent = decode(payloadForOffer(challenge, offer));

    expect(sent.accepts).toHaveLength(1);
    expect(sent.accepts[0].scheme).toBe("exact");
    expect(sent.accepts[0].amount).toBe("15");
    // The envelope survives narrowing; the vendor's resource must still be there.
    expect(sent.resource.url).toBe(OKLINK_CHALLENGE.resource.url);
    expect(sent.x402Version).toBe(2);
  });
});

describe("payloadForOffer", () => {
  it("cannot hand the CLI a cheaper entry than the one verified", () => {
    // Two exact entries at different prices. Our selector verifies the cheap
    // one; the CLI's own rule would take the first. Narrowing makes that
    // divergence impossible rather than merely unlikely.
    const twoExact = {
      x402Version: 2,
      accepts: [
        { scheme: "exact", network: "eip155:196", amount: "900000", asset: "0xA", payTo: "0xp" },
        { scheme: "exact", network: "eip155:196", amount: "15", asset: "0xA", payTo: "0xp" }
      ]
    };
    const challenge = parseChallenge({ "payment-required": b64(twoExact) }, {});
    const offer = selectOffer(challenge);
    expect(offer.amountUnits).toBe(15);

    const sent = decode(payloadForOffer(challenge, offer));
    expect(sent.accepts).toHaveLength(1);
    expect(sent.accepts[0].amount).toBe("15");
  });

  it("narrows a v1 body challenge too", () => {
    const v1 = {
      x402Version: 1,
      accepts: [
        { scheme: "exact", network: "eip155:196", maxAmountRequired: "90000", asset: "0xA", payTo: "0xp" }
      ]
    };
    const challenge = parseChallenge({}, v1);
    const sent = decode(payloadForOffer(challenge, selectOffer(challenge)));
    expect(sent.x402Version).toBe(1);
    expect(sent.accepts).toHaveLength(1);
  });
});
