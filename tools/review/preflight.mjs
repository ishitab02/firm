#!/usr/bin/env node
/**
 * Is the Firm ready for a reviewer to buy from it, right now?
 *
 * Run this immediately before asking anyone to test the listing. Not the day
 * before — the two things most likely to break are the two that drift on their
 * own: native gas draining below the refund threshold (which takes the public
 * endpoint DOWN, because the gateway refuses to boot without it), and the one
 * vendor that can actually serve a market snapshot going offline.
 *
 *   node tools/review/preflight.mjs            # ready-to-review checks
 *   node tools/review/preflight.mjs --inbound  # who has paid us, and was it us?
 *
 * Read-only. It spends nothing and signs nothing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const GATEWAY = process.env.FIRM_GATEWAY_URL ?? "https://firm-gateway.fly.dev";
const RPC = process.env.X402_RPC_URL_196 ?? "https://rpc.xlayer.tech";
const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const FIRM = "0xc0296012cfbb0e6df5da7158b65dbc46dd9650e0";
/** Our own QA buyer. An inbound payment from anything else is a real customer. */
const QA_BUYER = "0x212e82dc1d13b991d5318d970963f5ddfd81a178";
const OKLINK = "https://www.oklink.com/api/v5/explorer/mcp/x402/get_token_price_history";
const OKLINK_UNITS = "15";

const BODY = { symbol: "ETH", timeframe: "4h", prompt: "market snapshot with support and resistance" };

const results = [];
const ok = (name, detail) => results.push({ level: "ok", name, detail });
const warn = (name, detail) => results.push({ level: "warn", name, detail });
const fail = (name, detail) => results.push({ level: "fail", name, detail });

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const json = await response.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

/** The procurer has no public address by design, so reach it over 6PN. */
async function procurer(path) {
  const script = `import httpx,json;print(json.dumps(httpx.get('http://firm-procurer.internal:8787${path}',timeout=15).json()))`;
  const { stdout } = await run("fly", ["ssh", "console", "-a", "firm-worker", "-C", `python -c "${script}"`], {
    timeout: 120_000
  });
  const line = stdout.split("\n").find((entry) => entry.trim().startsWith("{"));
  if (!line) throw new Error("no JSON in fly ssh output");
  return JSON.parse(line);
}

function decodeChallenge(headerValue) {
  return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
}

async function checkEndpoint() {
  try {
    const health = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(20_000) });
    const body = await health.json();
    if (body.ok && body.charging_mode === "enforce") ok("gateway /health", `charging_mode=${body.charging_mode}`);
    else fail("gateway /health", JSON.stringify(body));
  } catch (error) {
    fail("gateway /health", `unreachable: ${error.message}`);
    return;
  }

  // A reviewer's tooling probes GET before it ever POSTs. Both must price.
  for (const method of ["GET", "POST"]) {
    try {
      const response = await fetch(GATEWAY, {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(BODY) }
          : {}),
        signal: AbortSignal.timeout(25_000)
      });
      if (response.status !== 402) {
        fail(`${method} unpaid`, `HTTP ${response.status}, expected 402`);
        continue;
      }
      const header = response.headers.get("payment-required");
      if (!header) {
        fail(`${method} unpaid`, "402 with no PAYMENT-REQUIRED header");
        continue;
      }
      const challenge = decodeChallenge(header);
      const entry = challenge.accepts?.[0] ?? {};
      const problems = [];
      if (!challenge.resource?.url) problems.push("no top-level resource.url");
      if (entry.network !== "eip155:196") problems.push(`network ${entry.network}`);
      if (entry.asset?.toLowerCase() !== TOKEN) problems.push(`asset ${entry.asset}`);
      const input = entry.outputSchema?.input ?? {};
      if (input.method !== "POST") problems.push(`input.method ${input.method}`);
      const timeframes = input.body?.properties?.timeframe?.enum;
      if (!Array.isArray(timeframes)) problems.push("no timeframe enum");
      if (problems.length) fail(`${method} challenge`, problems.join("; "));
      else ok(`${method} unpaid`, `402, ${entry.amount} units, ${timeframes.join("/")}`);
    } catch (error) {
      fail(`${method} unpaid`, error.message);
    }
  }
}

async function checkProcurer() {
  let health;
  try {
    health = await procurer("/health");
  } catch (error) {
    fail("procurer /health", `unreachable over 6PN: ${error.message}`);
    return;
  }
  if (health.refund_ready !== true) {
    fail("refund readiness", health.refund_readiness_detail ?? "refund_ready is not true");
  } else {
    const balance = BigInt(health.refund_gas_balance_wei ?? "0");
    const required = BigInt(health.refund_gas_required_wei ?? "0");
    // One refund's worth of gas is the floor, not the target: the endpoint goes
    // DOWN when this fails, so it needs headroom for several plus price moves.
    const refunds = required > 0n ? balance / required : 0n;
    if (refunds < 5n) warn("refund gas", `only ~${refunds} refunds of headroom — top up 0xC029`);
    else ok("refund gas", `~${refunds} refunds of headroom`);
  }

  try {
    const caps = await procurer("/caps");
    const spent = Number(caps.spent_today ?? 0);
    const daily = Number(caps.dailyMax ?? 0);
    if (daily && spent / daily > 0.8) fail("daily cap", `${spent}/${daily} spent — a vendor call would be refused`);
    else ok("daily cap", `${spent}/${daily} spent today`);
  } catch (error) {
    warn("daily cap", `could not read /caps: ${error.message}`);
  }
}

async function checkWorker() {
  try {
    const { stdout } = await run("fly", ["status", "-a", "firm-worker"], { timeout: 90_000 });
    const started = /worker\s+│[^│]*│[^│]*│[^│]*│\s*started/.test(stdout);
    const passing = stdout.includes("1 passing");
    if (started && passing) ok("worker", "started, loop_alive passing");
    else fail("worker", "not started or loop_alive not passing — paid jobs would sit at PENDING");
  } catch (error) {
    warn("worker", `could not read fly status: ${error.message}`);
  }
}

/**
 * The vendor Express resells analysis of. It is effectively a single point of
 * failure: CoinAnk is the only other market_snapshot vendor and does not
 * document its arguments, so a fallback call would very likely 400, be fired,
 * and end in a refund rather than a deliverable.
 */
async function checkVendor() {
  try {
    const response = await fetch(OKLINK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(25_000)
    });
    if (response.status !== 402) {
      fail("OKLink #2023", `HTTP ${response.status}, expected a 402 offer`);
      return;
    }
    const challenge = decodeChallenge(response.headers.get("payment-required"));
    const exact = (challenge.accepts ?? []).find((entry) => entry.scheme === "exact");
    if (!exact) fail("OKLink #2023", "no `exact` offer in the challenge");
    else if (exact.amount !== OKLINK_UNITS) {
      warn("OKLink #2023", `price moved: ${exact.amount} units, expected ${OKLINK_UNITS} — receipts and listing copy say 15`);
    } else ok("OKLink #2023", `live, ${exact.amount} units`);
  } catch (error) {
    fail("OKLink #2023", `unreachable: ${error.message} — a purchase would refund, not deliver`);
  }
}

/** Inbound USDT to the Firm, with anything that is not our QA wallet called out. */
async function inbound() {
  const latest = Number(await rpc("eth_blockNumber", []));
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const topic = `0x${"0".repeat(24)}${FIRM.slice(2)}`;
  const found = [];
  // X Layer caps eth_getLogs at 100 blocks, so walk it in chunks.
  const chunks = Number(process.env.PREFLIGHT_CHUNKS ?? 40);
  for (let i = 0; i < chunks; i += 1) {
    const to = latest - i * 100;
    const from = to - 99;
    try {
      const logs = await rpc("eth_getLogs", [
        {
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
          address: TOKEN,
          topics: [TRANSFER, null, topic]
        }
      ]);
      for (const log of logs) found.push(log);
    } catch {
      /* a chunk failing is not worth aborting the scan */
    }
  }
  if (!found.length) {
    console.log(`no inbound USDT to the Firm in the last ${chunks * 100} blocks`);
    return;
  }
  console.log(`inbound USDT to ${FIRM}, last ${chunks * 100} blocks:\n`);
  for (const log of found.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber))) {
    const payer = `0x${log.topics[1].slice(-40)}`;
    const units = BigInt(log.data).toString();
    const external = payer.toLowerCase() !== QA_BUYER.toLowerCase();
    const tag = external ? "  *** EXTERNAL BUYER ***" : "  (our QA wallet)";
    console.log(`  block ${Number(log.blockNumber)}  ${units.padStart(8)} units  from ${payer}${tag}`);
    if (external) console.log(`      tx ${log.transactionHash}`);
  }
  const externals = found.filter((log) => `0x${log.topics[1].slice(-40)}`.toLowerCase() !== QA_BUYER.toLowerCase());
  console.log(
    externals.length
      ? `\n${externals.length} payment(s) from outside our own wallet. Capture these: tx, receipt, job record.`
      : "\nEvery inbound payment is our own QA wallet. No external purchase yet."
  );
}

async function main() {
  if (process.argv.includes("--inbound")) {
    await inbound();
    return;
  }
  await Promise.all([checkEndpoint(), checkVendor()]);
  await checkProcurer();
  await checkWorker();

  console.log("");
  for (const entry of results) {
    const mark = entry.level === "ok" ? "PASS" : entry.level === "warn" ? "WARN" : "FAIL";
    console.log(`  ${mark}  ${entry.name.padEnd(18)} ${entry.detail}`);
  }
  const failed = results.filter((entry) => entry.level === "fail");
  const warned = results.filter((entry) => entry.level === "warn");
  console.log("");
  if (failed.length) {
    console.log(`NOT READY — ${failed.length} failing. Do not ask anyone to test yet.`);
    process.exitCode = 1;
  } else if (warned.length) {
    console.log(`READY, with ${warned.length} warning(s). Read them before you send the message.`);
  } else {
    console.log("READY — a reviewer can buy right now.");
  }
}

await main();
