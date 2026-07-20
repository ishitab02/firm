import assert from "node:assert/strict";
import test from "node:test";

import { buildReport } from "./generate.js";

const scan = {
  scanned_at: "2026-07-20T00:00:00Z",
  source: "test",
  agents: [
    { agentId: 1, name: "A", onlineStatus: 1, feedbackRate: 90, soldCount: 5, securityRate: 5, categoryName: ["Finance"] },
    { agentId: 2, name: "B", onlineStatus: 0, feedbackRate: 80, soldCount: 0, categoryName: ["Data", "Finance"] },
    { agentId: 3, name: "C", onlineStatus: 1, soldCount: null, categoryName: [] }
  ]
};

test("aggregates only what the scan contains", () => {
  const report = buildReport(scan, { vendors: [{ agent_id: "1" }] });
  assert.equal(report.marketplace.agents_scanned, 3);
  assert.equal(report.marketplace.agents_online, 2);
  assert.equal(report.marketplace.agents_with_a_rating, 2);
  assert.equal(report.marketplace.agents_without_a_rating, 1);
  assert.equal(report.marketplace.agents_with_completed_sales, 1);
  assert.equal(report.marketplace.total_completed_sales_across_marketplace, 5);
  assert.equal(report.marketplace.mean_feedback_rate_among_rated, 85);
  assert.equal(report.marketplace.category_breakdown.Finance, 2);
  assert.equal(report.firm_usable.count, 1);
});

test("a missing rating is never counted as a zero", () => {
  const report = buildReport(scan, null);
  // Only the two rated agents feed the mean; the unrated one is excluded, not 0.
  assert.equal(report.marketplace.mean_feedback_rate_among_rated, 85);
  assert.equal(report.firm_usable.count, 0);
});
