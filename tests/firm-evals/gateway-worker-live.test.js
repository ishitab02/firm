import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const databaseUrl = process.env.DATABASE_URL;
const gatewayPort = 8891;
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

function post(tool, args) {
  const result = spawnSync(
    "node",
    [
      "-e",
      `
      const body = JSON.stringify({ tool: process.argv[1], args: JSON.parse(process.argv[2]) });
      fetch(process.argv[3], { method: 'POST', headers: { 'content-type': 'application/json' }, body })
        .then(async (res) => { console.log(JSON.stringify(await res.json())); })
        .catch((error) => { console.error(error); process.exit(1); });
      `,
      tool,
      JSON.stringify(args),
      gatewayUrl
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function postProject(args) {
  const result = spawnSync(
    "node",
    [
      "-e",
      `
      fetch(process.argv[2] + '/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: process.argv[1]
      }).then(async (res) => {
        console.log(JSON.stringify({ status: res.status, body: await res.json() }));
      }).catch((error) => { console.error(error); process.exit(1); });
      `,
      JSON.stringify(args),
      gatewayUrl
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function getProject(taskId) {
  const result = spawnSync(
    "node",
    [
      "-e",
      `fetch(process.argv[1] + '/projects/' + process.argv[2])
        .then(async (res) => console.log(JSON.stringify({ status: res.status, body: await res.json() })))
        .catch((error) => { console.error(error); process.exit(1); });`,
      gatewayUrl,
      taskId
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function waitForGateway() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync(
      "node",
      ["-e", `fetch('${gatewayUrl}/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));`],
      { encoding: "utf8" }
    );
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error("gateway did not become ready");
}

function runWorkerTaskDemo(taskId) {
  const result = spawnSync("uv", ["run", "firm-worker", "work-task-demo", taskId], {
    cwd: new URL("../../apps/firm", import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl ?? "",
      UV_CACHE_DIR: "/tmp/firm-uv-cache"
    },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("direct Projects gateway worker result path", { skip: !databaseUrl }, async () => {
  const gateway = spawn("./node_modules/.bin/tsx", ["src/server.ts"], {
    cwd: new URL("../../apps/firm-gateway", import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(gatewayPort),
      PRICING_MODE: "QUOTED_AMOUNT",
      PROJECTS_TIMEOUT_MS: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    waitForGateway();
    const started = postProject({
      goal: "Compare BTC and ETH on 4h: price action, market trend, support and resistance",
      budget_cap: { amount: "5000000", decimals: 6, token: "USDT" },
      constraints: { deadline_minutes: 60, min_vendor_score: 60, banned_categories: [] }
    });
    assert.equal(started.status, 200);
    assert.match(started.body.quote_id, /^q_/);
    const executed = started.body;
    assert.match(executed.task_id, /^t_/);
    assert.equal(executed.result_url, `/projects/${executed.task_id}`);
    assert.equal(executed.charging, "BYPASSED");

    const worked = runWorkerTaskDemo(executed.task_id);
    assert.equal(worked.claimed, true);
    assert.equal(worked.task_id, executed.task_id);
    assert.equal(worked.state, "complete");

    const status = post("get_status", { task_id: executed.task_id });
    assert.equal(status.state, "complete");

    const result = post("get_result", { task_id: executed.task_id });
    assert.equal(result.provenance.guarantee_status, "delivered");
    assert.equal(result.provenance.economics.margin_retained_or_absorbed.sign, "retained");
    assert.deepEqual(
      result.deliverable.result.subtasks.map((subtask) => subtask.result.symbol),
      ["BTC", "ETH"]
    );
    assert.deepEqual(result.provenance.hires.map((hire) => hire.agent_id), ["2023", "2023"]);

    const publicResult = getProject(executed.task_id);
    assert.equal(publicResult.status, 200);
    assert.equal(publicResult.body.task_id, executed.task_id);
    assert.deepEqual(
      publicResult.body.deliverable.result.subtasks.map((subtask) => subtask.result.symbol),
      ["BTC", "ETH"]
    );
  } finally {
    gateway.kill("SIGTERM");
  }
});
