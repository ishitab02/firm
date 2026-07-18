import pg from "pg";

const { Pool } = pg;

export function pool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgresql://firm:firm@127.0.0.1:5432/firm"
  });
}

export async function ensureTables() {
  const client = pool();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS procurer_calls (
        idempotency_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        subtask_id TEXT NOT NULL,
        vendor_endpoint TEXT NOT NULL,
        amount JSONB NOT NULL,
        response JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS procurer_refunds (
        task_id TEXT PRIMARY KEY,
        amount JSONB NOT NULL,
        to_address TEXT NOT NULL,
        response JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  } finally {
    await client.end();
  }
}
