import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const databaseUrl = process.env.DATABASE_URL;

function runWorkerSmoke(command) {
  const result = spawnSync("uv", ["run", "firm-worker", command], {
    cwd: new URL("../../apps/firm", import.meta.url),
    env: { ...process.env, DATABASE_URL: databaseUrl ?? "", UV_CACHE_DIR: "/tmp/firm-uv-cache" },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("live worker smoke delivers with fallback and absorbed margin", { skip: !databaseUrl }, () => {
  const result = runWorkerSmoke("smoke-worker");

  assert.equal(result.claimed, true);
  assert.equal(result.state, "complete");
  assert.equal(result.result_ready, true);
  assert.equal(result.guarantee_status, "delivered");
  assert.equal(result.vendors_fired.length, 1);
});

test("live worker smoke refunds when candidates are exhausted", { skip: !databaseUrl }, () => {
  const result = runWorkerSmoke("smoke-refund");

  assert.equal(result.claimed, true);
  assert.equal(result.state, "failed_refunded");
  assert.equal(result.guarantee_status, "refunded");
  assert.equal(result.result_ready, false);
  assert.ok(result.refund.tx.startsWith("SIMULATED:refund:"));
});
