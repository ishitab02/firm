import pg from "pg";

const { Pool } = pg;

export function pool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgresql://firm:firm@127.0.0.1:5432/firm"
  });
}

export async function ensureGatewayTables() {
  const client = pool();
  try {
    await client.query(`
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
    `);
  } finally {
    await client.end();
  }
}
