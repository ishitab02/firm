import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeliverable,
  legacyX402Challenge,
  serviceFor,
  standardX402Challenge,
  validateDeliverable,
  vendors
} from "../src/fixtures.js";

test("good vendor returns a fresh schema-valid deliverable", () => {
  const deliverable = buildDeliverable("vendor_good", "market_snapshot", { subject: "ETH" });
  const validation = validateDeliverable(deliverable);

  assert.equal(validation.passed, true);
  assert.equal(deliverable.subject, "ETH");
});

test("flaky vendor trips schema and freshness validators specifically", () => {
  const deliverable = buildDeliverable("vendor_flaky", "market_snapshot", {
    failure_mode: "stale_schema"
  });
  const validation = validateDeliverable(deliverable);

  assert.equal(validation.passed, false);
  assert.deepEqual(
    validation.failures.map((failure) => failure.check),
    ["schema", "non_empty_content", "freshness"]
  );
});

test("both x402 challenge shapes expose the same amount", () => {
  const vendor = vendors.vendor_good;
  const service = serviceFor(vendor, "market_snapshot");
  const standard = standardX402Challenge(vendor, service);
  const legacy = legacyX402Challenge(vendor, service);

  assert.equal(standard.accepts[0].maxAmountRequired, service.price.amount);
  assert.equal(legacy.error.payment.amount.amount, service.price.amount);
});
