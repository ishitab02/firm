import pg from "pg";

import { assertAggregateCaps, assertPerCall, assertRefundCap, Caps } from "./caps.js";
import { units } from "./money.js";

const { Pool } = pg;

export type { Caps };

let shared: pg.Pool | null = null;

/**
 * One process-wide pool. The previous per-call `new Pool()` was safe for single
 * statements but not for transactions: `Pool.query()` checks out an arbitrary
 * idle connection per call, so BEGIN and COMMIT could land on different
 * sockets and the advisory lock would protect nothing.
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

/**
 * Run `body` on a single checked-out connection inside BEGIN/COMMIT. The
 * connection is always released, and any throw rolls back.
 */
export async function withTransaction<T>(body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A single advisory lock id serialises every spend decision across every
 * procurer process. Cap arithmetic and the reservation insert happen inside it,
 * which is what makes "no interleaving of calls can breach a cap" a property of
 * the system rather than of the test schedule.
 */
export const SPEND_LOCK_ID = 84020001;

/**
 * How long a `reserved` row may sit before another caller may reclaim it.
 * Must comfortably exceed the vendor timeout, or a slow-but-alive call could
 * have its reservation stolen while it is still working.
 */
export function reservationStaleAfterSeconds(): number {
  return Number(process.env.RESERVATION_STALE_AFTER_SECONDS ?? 900);
}

/**
 * `state` is the whole safety story for a call row:
 *   reserved — funds are claimed against the caps, nothing signed yet. Safe to
 *              release if the call fails.
 *   signed   — an authorization exists on the wire. Settlement is unknown and
 *              MUST NOT be retried automatically.
 *   settled  — the paid replay returned; `response` is the recorded receipt and
 *              a repeat request replays it instead of paying again.
 *   released — the call failed before signing; the reservation no longer counts
 *              toward any cap and the key may be retried.
 */
export async function ensureTables() {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS procurer_calls (
      idempotency_key TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      subtask_id TEXT NOT NULL,
      vendor_endpoint TEXT NOT NULL,
      amount JSONB NOT NULL,
      response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS procurer_refunds (
      task_id TEXT PRIMARY KEY,
      amount JSONB NOT NULL,
      to_address TEXT NOT NULL,
      response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Additive migration from the pre-reservation schema.
  await pool().query(`
    ALTER TABLE procurer_calls ALTER COLUMN response DROP NOT NULL;
    ALTER TABLE procurer_calls ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'settled';
    ALTER TABLE procurer_calls ADD COLUMN IF NOT EXISTS reserved_amount JSONB;
    ALTER TABLE procurer_calls ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    UPDATE procurer_calls SET reserved_amount = amount WHERE reserved_amount IS NULL;

    CREATE INDEX IF NOT EXISTS procurer_calls_task_idx ON procurer_calls(task_id);
    CREATE INDEX IF NOT EXISTS procurer_calls_created_idx ON procurer_calls(created_at);

    ALTER TABLE procurer_calls ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'real';
    -- Backfill from the recorded receipt rather than guessing: a SIMULATED tx
    -- was never a real payment and must not sit in the real ledger.
    UPDATE procurer_calls SET mode = 'simulated'
      WHERE mode = 'real' AND response->'receipt'->>'tx' LIKE 'SIMULATED:%';

    ALTER TABLE procurer_refunds ALTER COLUMN response DROP NOT NULL;
    ALTER TABLE procurer_refunds ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'settled';
    ALTER TABLE procurer_refunds ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS procurer_refunds_created_idx ON procurer_refunds(created_at);
  `);
}

/** Real money, or a simulated run. The two keep entirely separate ledgers. */
export type SpendMode = "real" | "simulated";

export type ReserveOutcome =
  | { kind: "replay"; response: unknown }
  | { kind: "in_flight" }
  | { kind: "needs_human"; detail: string }
  | { kind: "cap_exceeded"; detail: string }
  | { kind: "reserved" };

/**
 * Claim `ceilingUnits` against the caps for this idempotency key, atomically.
 *
 * Reserves at the *ceiling* (the caller's max_amount), not the vendor's price,
 * because the vendor's price is not known until after the 402 probe — and the
 * probe must not happen until the spend is already claimed. Over-reserving is
 * the safe direction: it can only reject a call that would have fit, never
 * admit one that would not.
 */
export async function reserveCall(
  request: {
    idempotencyKey: string;
    taskId: string;
    subtaskId: string;
    vendorEndpoint: string;
    ceiling: { amount: string; decimals: number; token: string };
  },
  caps: Caps,
  mode: SpendMode
): Promise<ReserveOutcome> {
  // Derived here, not passed in. This used to take a separate ceilingUnits
  // argument: cap arithmetic used the number, the row persisted the object, and
  // nothing enforced that they described the same amount. Production always
  // derived both from max_amount so they agreed, but a caller passing a ceiling
  // of 0 with units of 50,000 would pass every cap check and then reserve
  // nothing — silently under-claiming budget on money code. One source, no gap.
  const ceilingUnits = units(request.ceiling);
  return withTransaction<ReserveOutcome>(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [SPEND_LOCK_ID]);

    const existing = await client.query(
      `SELECT state, response, mode,
              EXTRACT(EPOCH FROM (now() - updated_at))::int AS age_seconds
       FROM procurer_calls WHERE idempotency_key = $1`,
      [request.idempotencyKey]
    );
    const row = existing.rows[0];
    if (row) {
      // Never replay across modes. A settled simulated receipt returned for a
      // real request would look exactly like a completed payment that never
      // happened — and vice versa would silently skip a real one.
      if (row.mode !== mode) {
        return {
          kind: "needs_human",
          detail: `this idempotency key already has a '${row.mode}' record and this is a '${mode}' request; refusing to mix simulated and real money on one key`
        };
      }
      if (row.state === "settled") return { kind: "replay", response: row.response };
      if (row.state === "signed") {
        return {
          kind: "needs_human",
          detail:
            "a payment authorization was already signed for this (task_id, subtask_id, vendor_endpoint) and its settlement is unconfirmed; refusing to sign a second one"
        };
      }
      if (row.state === "reserved") {
        // A procurer that died mid-call leaves its reservation behind, where it
        // blocks every retry and holds cap budget forever. Reclaim it once it is
        // older than any call could still plausibly be. `signed` rows are
        // deliberately never reclaimed, however old — that money may be gone.
        if (Number(row.age_seconds ?? 0) < reservationStaleAfterSeconds()) {
          return { kind: "in_flight" };
        }
      }
      // released, or a stale reservation -> re-reserve under the same key.
      await client.query("DELETE FROM procurer_calls WHERE idempotency_key = $1", [request.idempotencyKey]);
    }

    const perCall = assertPerCall(ceilingUnits, caps);
    if (!perCall.ok) return { kind: "cap_exceeded", detail: perCall.detail };

    // Reserved and signed/settled rows all count; released rows do not.
    const totals = await client.query(
      `SELECT
         COALESCE(SUM((reserved_amount->>'amount')::bigint) FILTER (WHERE task_id = $1), 0)::bigint AS task_spend,
         COALESCE(SUM((reserved_amount->>'amount')::bigint) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::bigint AS daily_spend
       FROM procurer_calls
       WHERE state <> 'released' AND mode = $2`,
      [request.taskId, mode]
    );
    const aggregate = assertAggregateCaps(
      ceilingUnits,
      caps,
      Number(totals.rows[0]?.task_spend ?? 0),
      Number(totals.rows[0]?.daily_spend ?? 0)
    );
    if (!aggregate.ok) return { kind: "cap_exceeded", detail: aggregate.detail };

    await client.query(
      `INSERT INTO procurer_calls
         (idempotency_key, task_id, subtask_id, vendor_endpoint, amount, reserved_amount, response, state, mode)
       VALUES ($1, $2, $3, $4, $5::jsonb, $5::jsonb, NULL, 'reserved', $6)`,
      [
        request.idempotencyKey,
        request.taskId,
        request.subtaskId,
        request.vendorEndpoint,
        JSON.stringify(request.ceiling),
        mode
      ]
    );
    return { kind: "reserved" };
  });
}

export async function markSigned(idempotencyKey: string) {
  await pool().query(
    "UPDATE procurer_calls SET state = 'signed', updated_at = now() WHERE idempotency_key = $1 AND state = 'reserved'",
    [idempotencyKey]
  );
}

export async function settleCall(idempotencyKey: string, actualAmount: unknown, response: unknown) {
  await pool().query(
    `UPDATE procurer_calls
     SET state = 'settled', amount = $2::jsonb, reserved_amount = $2::jsonb, response = $3::jsonb, updated_at = now()
     WHERE idempotency_key = $1`,
    [idempotencyKey, JSON.stringify(actualAmount), JSON.stringify(response)]
  );
}

/**
 * Release a reservation that never became a signature. Rows already marked
 * `signed` are deliberately left alone — releasing one would let a retry sign a
 * second authorization for money that may already be gone.
 */
export async function releaseCall(idempotencyKey: string, response: unknown) {
  await pool().query(
    `UPDATE procurer_calls
     SET state = 'released', reserved_amount = jsonb_set(reserved_amount, '{amount}', '"0"'),
         response = $2::jsonb, updated_at = now()
     WHERE idempotency_key = $1 AND state = 'reserved'`,
    [idempotencyKey, JSON.stringify(response)]
  );
}

/** Record the outcome of a call that failed after signing, without releasing it. */
export async function recordSignedFailure(idempotencyKey: string, response: unknown) {
  await pool().query(
    "UPDATE procurer_calls SET response = $2::jsonb, updated_at = now() WHERE idempotency_key = $1 AND state = 'signed'",
    [idempotencyKey, JSON.stringify(response)]
  );
}

/**
 * The task's quoted price, in base units, read from the job row the gateway
 * wrote. Read-only cross-lane access: this is the only authoritative source of
 * what the user was actually charged, and taking it from the refund request
 * itself would let the caller authorise its own refund.
 *
 * Returns null when there is no job row or no price on it — the caller must
 * treat that as "cannot auto-approve", never as "unlimited".
 */
export async function quotedPriceUnits(client: pg.PoolClient | pg.Pool, taskId: string): Promise<number | null> {
  try {
    const result = await client.query(`SELECT quote->'price'->>'amount' AS amount FROM firm_jobs WHERE task_id = $1`, [
      taskId
    ]);
    const raw = result.rows[0]?.amount;
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    // firm_jobs is owned by the worker lane and may not exist yet.
    return null;
  }
}

export type RefundOutcome =
  | { kind: "replay"; response: unknown }
  | { kind: "pending"; response: unknown }
  | { kind: "in_flight" }
  | { kind: "requires_human"; detail: string }
  | { kind: "cap_exceeded"; detail: string }
  | { kind: "reserved" };

/**
 * Claim a refund against the daily refund cap and the task's quoted price,
 * atomically, under the same lock the spend path uses.
 */
export async function reserveRefund(
  request: { taskId: string; toAddress: string; amount: { amount: string; decimals: number; token: string } },
  caps: Caps
): Promise<RefundOutcome> {
  // Derived, for the same reason as reserveCall above.
  const amountUnits = units(request.amount);
  return withTransaction<RefundOutcome>(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [SPEND_LOCK_ID]);

    const existing = await client.query("SELECT state, response FROM procurer_refunds WHERE task_id = $1", [
      request.taskId
    ]);
    const row = existing.rows[0];
    if (row) {
      if (row.state === "settled") return { kind: "replay", response: row.response };
      if (row.state === "pending_confirmation") return { kind: "pending", response: row.response };
      if (row.state !== "released") return { kind: "in_flight" };
      await client.query("DELETE FROM procurer_refunds WHERE task_id = $1", [request.taskId]);
    }

    const quoted = await quotedPriceUnits(client, request.taskId);
    if (quoted === null) {
      return {
        kind: "requires_human",
        detail: `no quoted price on record for ${request.taskId}; refusing to auto-approve a refund we cannot bound`
      };
    }
    if (amountUnits > quoted) {
      return {
        kind: "requires_human",
        detail: `refund of ${amountUnits} exceeds the task's quoted price of ${quoted}`
      };
    }

    const refunded = await client.query(
      `SELECT COALESCE(SUM((amount->>'amount')::bigint), 0)::bigint AS refunded
       FROM procurer_refunds
       WHERE created_at >= date_trunc('day', now()) AND state <> 'released'`
    );
    const refundCap = assertRefundCap(amountUnits, caps, Number(refunded.rows[0]?.refunded ?? 0));
    if (!refundCap.ok) return { kind: "cap_exceeded", detail: refundCap.detail };

    await client.query(
      `INSERT INTO procurer_refunds (task_id, amount, to_address, response, state)
       VALUES ($1, $2::jsonb, $3, NULL, 'reserved')`,
      [request.taskId, JSON.stringify(request.amount), request.toAddress]
    );
    return { kind: "reserved" };
  });
}

export async function settleRefund(taskId: string, response: unknown) {
  await pool().query(
    "UPDATE procurer_refunds SET state = 'settled', response = $2::jsonb, updated_at = now() WHERE task_id = $1",
    [taskId, JSON.stringify(response)]
  );
}

export async function markRefundPending(taskId: string, response: unknown) {
  await pool().query(
    `UPDATE procurer_refunds
     SET state = 'pending_confirmation', response = $2::jsonb, updated_at = now()
     WHERE task_id = $1 AND state IN ('reserved', 'pending_confirmation')`,
    [taskId, JSON.stringify(response)]
  );
}

export async function releaseRefund(taskId: string, response: unknown) {
  await pool().query(
    `UPDATE procurer_refunds
     SET state = 'released', amount = jsonb_set(amount, '{amount}', '"0"'),
         response = $2::jsonb, updated_at = now()
     WHERE task_id = $1 AND state IN ('reserved', 'pending_confirmation')`,
    [taskId, JSON.stringify(response)]
  );
}

export async function spendSnapshot() {
  const result = await pool().query(
    `SELECT
       COALESCE(SUM((reserved_amount->>'amount')::bigint) FILTER (WHERE created_at >= date_trunc('day', now()) AND mode = 'real'), 0)::bigint AS spent_today,
       COALESCE(SUM((reserved_amount->>'amount')::bigint) FILTER (WHERE created_at >= date_trunc('day', now()) AND mode = 'simulated'), 0)::bigint AS simulated_today,
       COUNT(*) FILTER (WHERE state = 'signed' AND mode = 'real')::int AS unconfirmed_signatures
     FROM procurer_calls
     WHERE state <> 'released'`
  );
  const refunds = await pool().query(
    `SELECT COALESCE(SUM((amount->>'amount')::bigint), 0)::bigint AS refunded_today
     FROM procurer_refunds WHERE created_at >= date_trunc('day', now()) AND state <> 'released'`
  );
  return {
    spent_today: Number(result.rows[0]?.spent_today ?? 0),
    // Reported separately and never mixed into spent_today: simulated runs must
    // not read as real money, and must not consume a real daily budget.
    simulated_today: Number(result.rows[0]?.simulated_today ?? 0),
    unconfirmed_signatures: Number(result.rows[0]?.unconfirmed_signatures ?? 0),
    refunded_today: Number(refunds.rows[0]?.refunded_today ?? 0)
  };
}
