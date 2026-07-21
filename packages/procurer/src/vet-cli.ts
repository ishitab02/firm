/**
 * Vendor background check, as a command.
 *
 * Runs the same free 402 probe the procurer's /vet endpoint runs, against a
 * vendor index, and prints what each candidate would ACTUALLY charge versus
 * what it advertises. Nothing here signs anything and nothing here spends
 * anything — see the module comment in vet.ts.
 *
 *   pnpm -F @firm/procurer vet -- --capability market_snapshot --limit 10
 *   pnpm -F @firm/procurer vet -- --index data/vendor-index.demo.json --out report.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { MoneyLike, VetRequest, VetResult, vetVendors } from "./vet.js";

/** Repo root, so the defaults work regardless of which directory pnpm ran us in. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type IndexService = {
  tool: string;
  capability: string;
  price: MoneyLike;
  documented_example_args?: { args?: Record<string, unknown> } | null;
};
type IndexEntry = { agent_id: string; name: string; endpoint: string; services: IndexService[] };

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

/**
 * Accepts either a generated vendor index or a raw marketplace scan.
 *
 * The scan is the wider population: 218 agents, of which only those with an
 * A2MCP service carry an HTTP endpoint at all. A2A services are agent-to-agent
 * and have nothing to probe — which is itself the reason the Firm listing went
 * out as A2MCP: an A2A listing cannot be checked before you submit it.
 */
function loadIndex(path: string): IndexEntry[] {
  const payload = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(payload)) return payload;
  if (payload.vendors) return payload.vendors;

  return (payload.agents ?? [])
    .map((agent: Record<string, any>) => {
      const callable = (agent.services ?? []).filter((service: Record<string, any>) => service.endpoint);
      if (callable.length === 0) return null;
      return {
        agent_id: String(agent.agentId),
        name: String(agent.name ?? "").trim() || `#${agent.agentId}`,
        // One probe per agent, not per service: 95 agents rather than 395 calls
        // against endpoints we do not own.
        endpoint: callable[0].endpoint,
        services: [
          {
            tool: callable[0].serviceName ?? "service",
            capability: "market_snapshot",
            price: {
              amount: String(Math.round((callable[0].feeAmount ?? 0) * 1e6)),
              decimals: 6,
              token: "USDT"
            }
          }
        ]
      };
    })
    .filter(Boolean) as IndexEntry[];
}

function pad(value: unknown, width: number): string {
  const text = String(value ?? "");
  return (text.length > width ? `${text.slice(0, width - 1)}…` : text).padEnd(width);
}

const VERDICT_MARK: Record<string, string> = {
  X402_OK: "ok  ",
  NO_CHARGE: "free",
  PRICE_MISMATCH: "WARN",
  OVER_BUDGET: "STOP",
  UNSUPPORTED_CHALLENGE: "n/a ",
  HTTP_ERROR: "DEAD",
  UNREACHABLE: "DEAD"
};

async function main(): Promise<void> {
  const indexPath = path.resolve(REPO_ROOT, flag("index", "data/vendor-index.json")!);
  const capability = flag("capability");
  const limit = Number(flag("limit", "0"));
  const ceiling = flag("max-amount", "50000")!;
  const outPath = flag("out");

  const entries = loadIndex(indexPath);
  const requests: Array<VetRequest & { agentId: string; name: string }> = [];

  for (const entry of entries) {
    const service = entry.services.find((candidate) => !capability || candidate.capability === capability);
    if (!service) continue;
    requests.push({
      agentId: entry.agent_id,
      name: entry.name,
      vendorEndpoint: entry.endpoint,
      tool: service.tool,
      args: service.documented_example_args?.args ?? {},
      listedAmount: service.price,
      maxAmount: { amount: ceiling, decimals: 6, token: "USDT" }
    });
    if (limit > 0 && requests.length >= limit) break;
  }

  if (requests.length === 0) {
    console.error(`no candidates in ${indexPath}${capability ? ` for capability '${capability}'` : ""}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Vetting ${requests.length} vendors from ${indexPath} — unpaid probes, zero cost.\n`);
  const started = Date.now();
  const results = await vetVendors(requests, {
    timeoutMs: Number(flag("timeout", "12000")),
    concurrency: Number(flag("concurrency", "5")),
    attempts: Number(flag("attempts", "2"))
  });

  console.log(
    `      ${pad("agent", 7)}${pad("name", 30)}${pad("verdict", 23)}${pad("listed", 10)}${pad("live", 12)}ratio`
  );
  results.forEach((result, index) => {
    const request = requests[index];
    console.log(
      `${VERDICT_MARK[result.verdict] ?? "?   "}  ` +
        pad(request.agentId, 7) +
        pad(request.name, 30) +
        pad(result.verdict, 23) +
        pad(request.listedAmount?.amount, 10) +
        pad(result.live_amount?.amount ?? "-", 12) +
        (result.price_ratio !== null ? `${result.price_ratio}x` : "-") +
        (result.attempts > 1 ? `  (${result.attempts} attempts)` : "")
    );
  });

  const hireable = results.filter((result) => result.hireable);
  const mispriced = results.filter((result) => result.price_ratio !== null && result.price_ratio > 1);
  const dead = results.filter((result) => result.verdict === "UNREACHABLE" || result.verdict === "HTTP_ERROR");

  console.log(
    `\n${hireable.length}/${results.length} hireable · ${dead.length} dead or misrouted · ` +
      `${mispriced.length} charging above their listing · ${Date.now() - started}ms · 0 paid`
  );

  if (outPath) {
    const report = {
      generated_at: new Date().toISOString(),
      index: path.relative(REPO_ROOT, indexPath),
      capability: capability ?? null,
      method: {
        probe: "one unpaid POST per agent; read whatever the endpoint answers",
        cost: "none — no payment was signed or sent for any probe",
        attempts: `up to ${flag("attempts", "2")}, retried only on network-level failure`,
        timeout_ms: Number(flag("timeout", "12000")),
        population: "the FIRST endpoint-bearing service per agent, not every service",
        what_it_proves: "endpoint liveness, x402 conformance, and the price actually demanded",
        what_it_does_not_prove:
          "that a paid response is correct or useful; that an agent's OTHER services share this verdict"
      },
      summary: {
        probed: results.length,
        hireable: hireable.length,
        dead_or_misrouted: dead.length,
        above_listing: mispriced.length,
        served_free: results.filter((result) => result.verdict === "NO_CHARGE").length
      },
      results: results.map((result: VetResult, index) => ({
        agent_id: requests[index].agentId,
        name: requests[index].name,
        ...result
      }))
    };
    const resolved = path.resolve(REPO_ROOT, outPath);
    writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${path.relative(REPO_ROOT, resolved)}`);
  }
}

await main();
