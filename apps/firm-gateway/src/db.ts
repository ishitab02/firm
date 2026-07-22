import pg from "pg";

const { Pool } = pg;

let shared: pg.Pool | null = null;

/**
 * One process-wide connection pool. The previous `new Pool()` per query opened
 * and tore down a whole pool for every statement — wasteful, and under load a
 * way to exhaust Postgres connections. Callers use `pool().query(...)` and never
 * `.end()` it; the pool lives for the process.
 */
export function pool(): pg.Pool {
  if (!shared) {
    shared = new Pool({
      connectionString: process.env.DATABASE_URL ?? "postgresql://firm:firm@127.0.0.1:5432/firm",
      max: Number(process.env.PGPOOL_MAX ?? 10)
    });
  }
  return shared;
}

export async function closePool() {
  if (shared) {
    const closing = shared;
    shared = null;
    await closing.end();
  }
}

export async function ensureGatewayTables() {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS firm_quotes (
      quote_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      quote JSONB NOT NULL,
      budget_cap JSONB NOT NULL,
      constraints JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      valid_until TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS firm_quotes_valid_until_idx
      ON firm_quotes(valid_until);

    ALTER TABLE firm_jobs
      ADD COLUMN IF NOT EXISTS attempts JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);
}
