#!/usr/bin/env node
/**
 * Seed vendor_performance from the real reliability scan data/marketplace-health-2026-07-21.json
 *
 * Usage:
 *   node tools/demo/seed-performance.js [--sql-only]
 *   DATABASE_URL=postgresql://... node tools/demo/seed-performance.js
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HEALTH_PATH = path.join(REPO_ROOT, "data/marketplace-health-2026-07-21.json");

function loadHealthData() {
  const data = JSON.parse(readFileSync(HEALTH_PATH, "utf8"));
  return data;
}

export function buildPerformanceRecords(healthData) {
  const generatedAt = healthData.generated_at || new Date().toISOString();
  const records = [];

  for (const item of healthData.results) {
    const agentId = String(item.agent_id);
    const attempts = item.attempts || 1;
    let successes = 0;
    let validationFailures = 0;
    let timeouts = 0;
    let lastFailureAt = null;
    let adjustment = 0;

    if (item.hireable && (item.verdict === "X402_OK" || item.verdict === "NO_CHARGE")) {
      successes = 1;
      adjustment = 1;
    } else {
      lastFailureAt = generatedAt;
      if (item.verdict === "HTTP_ERROR" || item.verdict === "UNREACHABLE") {
        timeouts = attempts;
        adjustment = -10;
      } else if (item.verdict === "OVER_BUDGET" || item.verdict === "PRICE_MISMATCH") {
        validationFailures = 1;
        adjustment = -10;
      } else {
        timeouts = 1;
        adjustment = -5;
      }
    }

    records.push({
      agent_id: agentId,
      calls: attempts,
      successes,
      validation_failures: validationFailures,
      timeouts,
      last_failure_at: lastFailureAt,
      adjustment: Math.max(-30, Math.min(10, adjustment))
    });
  }

  return records;
}

export function generateSql(records) {
  const statements = [
    "-- Seed vendor_performance from empirical reliability scan (data/marketplace-health-2026-07-21.json)"
  ];
  for (const r of records) {
    const lastFail = r.last_failure_at ? `'${r.last_failure_at}'::timestamptz` : "NULL";
    statements.push(
      `INSERT INTO vendor_performance (agent_id, calls, successes, validation_failures, timeouts, last_failure_at, adjustment) VALUES ('${r.agent_id}', ${r.calls}, ${r.successes}, ${r.validation_failures}, ${r.timeouts}, ${lastFail}, ${r.adjustment}) ON CONFLICT (agent_id) DO UPDATE SET calls = EXCLUDED.calls, successes = EXCLUDED.successes, validation_failures = EXCLUDED.validation_failures, timeouts = EXCLUDED.timeouts, last_failure_at = EXCLUDED.last_failure_at, adjustment = EXCLUDED.adjustment;`
    );
  }
  return statements.join("\n");
}

async function main() {
  const healthData = loadHealthData();
  const records = buildPerformanceRecords(healthData);

  const positive = records.filter((r) => r.adjustment > 0).length;
  const penalized = records.filter((r) => r.adjustment < 0).length;

  console.log(`Loaded ${records.length} probed agent outcomes from data/marketplace-health-2026-07-21.json`);
  console.log(`  Positive signal (+1): ${positive} agents`);
  console.log(`  Penalized signal (-10): ${penalized} agents`);

  if (process.argv.includes("--sql-only")) {
    console.log("\n" + generateSql(records));
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log("\nDATABASE_URL is not set. Run with --sql-only to view SQL statements or pass DATABASE_URL to execute.");
    return;
  }

  console.log(`\nConnecting to database to seed vendor_performance...`);
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();

  try {
    let count = 0;
    for (const r of records) {
      await client.query(
        `INSERT INTO vendor_performance (
          agent_id, calls, successes, validation_failures, timeouts, last_failure_at, adjustment
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (agent_id) DO UPDATE SET
          calls = EXCLUDED.calls,
          successes = EXCLUDED.successes,
          validation_failures = EXCLUDED.validation_failures,
          timeouts = EXCLUDED.timeouts,
          last_failure_at = EXCLUDED.last_failure_at,
          adjustment = EXCLUDED.adjustment;`,
        [r.agent_id, r.calls, r.successes, r.validation_failures, r.timeouts, r.last_failure_at, r.adjustment]
      );
      count += 1;
    }
    console.log(`Successfully seeded ${count} vendor_performance records into Postgres.`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("Error seeding vendor performance:", err);
    process.exit(1);
  });
}
