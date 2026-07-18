import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const databaseUrl = process.env.DATABASE_URL;
const gatewayPort = 8893;
const procurerPort = 8894;
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

function waitFor(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = spawnSync(
      "node",
      ["-e", `fetch('${url}/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));`],
      { encoding: "utf8" }
    );
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`${url} did not become ready`);
}

function postGateway(tool, args) {
  const result = spawnSync(
    "node",
    [
      "-e",
      `
      fetch(process.argv[1], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: process.argv[2], args: JSON.parse(process.argv[3]) })
      }).then(async (res) => console.log(JSON.stringify(await res.json())))
        .catch((error) => { console.error(error); process.exit(1); });
      `,
      gatewayUrl,
      tool,
      JSON.stringify(args)
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runWorker(taskId, vendorIndexPath) {
  const result = spawnSync("uv", ["run", "firm-worker", "work-task", taskId], {
    cwd: new URL("../../apps/firm", import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl ?? "",
      PROCURER_URL: `http://127.0.0.1:${procurerPort}`,
      VENDOR_INDEX_PATH: vendorIndexPath,
      UV_CACHE_DIR: "/tmp/firm-uv-cache"
    },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("gateway worker procurer local service path", { skip: !databaseUrl }, () => {
  const vendorIndexPath = `/tmp/firm-vendor-index-${Date.now()}.json`;
  fs.writeFileSync(
    vendorIndexPath,
    JSON.stringify([
      {
        agent_id: "local-procurer-good",
        name: "Local Procurer Sim Vendor",
        endpoint: "http://mock.vendor/local",
        services: [
          {
            tool: "launch_brief",
            capability: "token_launch",
            price: { amount: "300000", decimals: 6, token: "USDT" }
          }
        ],
        kya_base_score: 90,
        flags: [],
        last_verified_at: new Date().toISOString()
      }
    ])
  );

  const gateway = spawn("./node_modules/.bin/tsx", ["src/server.ts"], {
    cwd: new URL("../../apps/firm-gateway", import.meta.url),
    env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(gatewayPort), PRICING_MODE: "QUOTED_AMOUNT" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const procurer = spawn("./node_modules/.bin/tsx", ["src/server.ts"], {
    cwd: new URL("../../packages/procurer", import.meta.url),
    env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(procurerPort) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    waitFor(gatewayUrl);
    waitFor(`http://127.0.0.1:${procurerPort}`);
    const quote = postGateway("get_quote", {
      goal: "Prepare a launch briefing",
      budget_cap: { amount: "5000000", decimals: 6, token: "USDT" },
      constraints: { deadline_minutes: 60, min_vendor_score: 60, banned_categories: [] }
    });
    const execution = postGateway("execute", { quote_id: quote.quote_id });
    const worked = runWorker(execution.task_id, vendorIndexPath);
    assert.equal(worked.state, "complete");

    const result = postGateway("get_result", { task_id: execution.task_id });
    assert.equal(result.provenance.guarantee_status, "delivered");
    assert.match(result.provenance.hires[0].tx, /^SIMULATED:pay:/);
  } finally {
    gateway.kill("SIGTERM");
    procurer.kill("SIGTERM");
    fs.rmSync(vendorIndexPath, { force: true });
  }
});
