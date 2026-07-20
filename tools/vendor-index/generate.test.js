import assert from "node:assert/strict";
import test from "node:test";

import { toBaseUnits } from "./generate.js";

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
