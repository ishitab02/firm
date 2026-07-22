import assert from "node:assert/strict";
import test from "node:test";

import { toBaseUnits, documentedExampleArgs, inferCapability } from "./generate.js";

// The marketplace reports fees as decimals ("0.000015"), but every amount that
// reaches a cap check or a payment has to be an exact base-unit integer. A
// float round-trip here would mis-price a real payment, so this conversion is
// string arithmetic and is tested as such.

test("converts whole and fractional fees exactly", () => {
  assert.equal(toBaseUnits(0.000015, 6), "15");
  assert.equal(toBaseUnits(0.01, 6), "10000");
  assert.equal(toBaseUnits(0.3, 6), "300000");
  assert.equal(toBaseUnits(0.5, 6), "500000");
  assert.equal(toBaseUnits(3, 6), "3000000");
  assert.equal(toBaseUnits(0, 6), "0");
});

test("does not lose precision the way a float multiply would", () => {
  // 0.29 * 1e6 is 289999.99999999994 in IEEE-754.
  assert.equal(toBaseUnits(0.29, 6), "290000");
  // 1.005 * 1e6 is 1004999.9999999999.
  assert.equal(toBaseUnits(1.005, 6), "1005000");
});

test("refuses a fee with more precision than the token can represent", () => {
  // Rounding here would silently change someone's price.
  assert.equal(toBaseUnits(0.0000001, 6), null);
  assert.equal(toBaseUnits(1.9999999, 6), null);
});

test("refuses anything that is not a plain decimal number", () => {
  assert.equal(toBaseUnits("abc", 6), null);
  assert.equal(toBaseUnits("1e-6", 6), null);
  assert.equal(toBaseUnits("-1", 6), null);
  assert.equal(toBaseUnits("", 6), null);
});

test("handles a zero-decimal token", () => {
  assert.equal(toBaseUnits(5, 0), "5");
  assert.equal(toBaseUnits(0.5, 0), null);
});

test("documentedExampleArgs copies a published literal and refuses to guess", () => {
  // The real OKLink description, verbatim from the 2026-07-21 scan.
  const oklink = {
    serviceDescription:
      'Address balance at a block — POST.\nPOST only (GET=405). Requires chainIndex, address, height. ' +
      'Returns the balance at that block height.\ne.g. POST {"chainIndex":"1","address":"0x...","height":"21000000"}'
  };
  const found = documentedExampleArgs(oklink);
  assert.deepEqual(found.args, { chainIndex: "1", address: "0x...", height: "21000000" });
  assert.equal(found.source, "verbatim_json_literal_in_vendor_service_description");

  // Prose that describes parameters but publishes no literal: unknown, not empty.
  assert.equal(
    documentedExampleArgs({ serviceDescription: "Send a chainIndex and an address to get a balance." }),
    null
  );
  // Looks like JSON, is not.
  assert.equal(documentedExampleArgs({ serviceDescription: 'e.g. {"chainIndex": }' }), null);
  // A nested body is recorded faithfully. The hazard was never nesting itself,
  // it was a brace-excluding regex silently returning the INNER object — a
  // plausible-looking wrong answer. Depth counting makes that impossible.
  assert.deepEqual(
    documentedExampleArgs({ serviceDescription: 'e.g. {"filter":{"a":1},"b":2}' }).args,
    { filter: { a: 1 }, b: 2 }
  );
  // Braces inside a string value must not end the span early.
  assert.deepEqual(
    documentedExampleArgs({ serviceDescription: 'e.g. {"note":"use {curly}","b":2}' }).args,
    { note: "use {curly}", b: 2 }
  );
  // A truncated example is refused rather than repaired.
  assert.equal(documentedExampleArgs({ serviceDescription: 'e.g. {"a":1' }), null);
  // An array value is legitimate and sendable.
  assert.deepEqual(
    documentedExampleArgs({ serviceDescription: 'e.g. {"chainIndex":"1","tokenAddresses":["0x..."]}' }).args,
    { chainIndex: "1", tokenAddresses: ["0x..."] }
  );
  // No description at all.
  assert.equal(documentedExampleArgs({}), null);
});

test("market snapshot inference requires the actual technical-analysis contract", () => {
  assert.equal(
    inferCapability({
      serviceName: "Crypto technical snapshot",
      serviceDescription: "BTC or ETH spot price action and candle trend with support and resistance by symbol."
    }),
    "market_snapshot"
  );
  assert.equal(
    inferCapability({
      serviceName: "US ETH ETF",
      serviceDescription: "Ethereum ETF fund holdings, issuer NAV and daily flows market data."
    }),
    null
  );
  assert.equal(
    inferCapability({ serviceName: "Market news report", serviceDescription: "Research, sentiment and news analysis." }),
    null
  );
  assert.equal(
    inferCapability({ serviceName: "Prediction market chart", serviceDescription: "Candlestick price history for an event." }),
    null
  );
  assert.equal(
    inferCapability({ serviceName: "US stock bars", serviceDescription: "Historical OHLC bars by symbol." }),
    null
  );
  assert.equal(
    inferCapability({ serviceName: "Kline Lists", serviceDescription: "Kline market data for crypto analysis." }),
    "market_snapshot"
  );
});

test("token launch inference does not turn deployment or audit prose into a launch service", () => {
  assert.equal(
    inferCapability({ serviceName: "Token launch studio", serviceDescription: "Create a token with tokenomics." }),
    "token_launch"
  );
  assert.equal(
    inferCapability({ serviceName: "Contract audit", serviceDescription: "Audit a contract before deployment." }),
    null
  );
});
