import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const databaseUrl = process.env.DATABASE_URL;
const port = 8892;
const baseUrl = `http://127.0.0.1:${port}`;

function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync(
      "node",
      ["-e", `fetch('${baseUrl}/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));`],
      { encoding: "utf8" }
    );
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error("procurer did not become ready");
}

function post(path, body) {
  const result = spawnSync(
    "node",
    [
      "-e",
      `
      fetch(process.argv[1], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: process.argv[2]
      }).then(async (res) => console.log(JSON.stringify(await res.json())))
        .catch((error) => { console.error(error); process.exit(1); });
      `,
      `${baseUrl}${path}`,
      JSON.stringify(body)
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("procurer persists idempotent calls and rejects cap breaches before payment", { skip: !databaseUrl }, () => {
  const proc = spawn("./node_modules/.bin/tsx", ["src/server.ts"], {
    cwd: new URL("../../packages/procurer", import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      PER_CALL_MAX: "500000",
      PER_TASK_MAX: "650000",
      DAILY_MAX: "5000000",
      DAILY_REFUND_MAX: "1000000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    waitForHealth();
    const request = {
      vendor_endpoint: "http://mock.vendor/idempotent",
      tool: "launch_brief",
      args: { goal: "launch" },
      max_amount: { amount: "300000", decimals: 6, token: "USDT" },
      task_id: `t_proc_${Date.now()}`,
      subtask_id: "launch brief"
    };
    const first = post("/pay-and-call", request);
    const second = post("/pay-and-call", request);
    assert.equal(first.ok, true);
    assert.equal(second.receipt.tx, first.receipt.tx);

    const breach = post("/pay-and-call", {
      ...request,
      vendor_endpoint: "http://mock.vendor/too-expensive",
      max_amount: { amount: "600000", decimals: 6, token: "USDT" }
    });
    assert.equal(breach.ok, false);
    assert.equal(breach.error_code, "CAP_EXCEEDED");
  } finally {
    proc.kill("SIGTERM");
  }
});
