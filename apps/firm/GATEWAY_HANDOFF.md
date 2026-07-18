# Gateway Handoff Contract

This is the F3 worker-side contract F2 should use when inserting and reading Firm Project jobs.

## Insert Shape

After `execute` is paid, `apps/firm-gateway` inserts one row into `firm_jobs`.

```sql
INSERT INTO firm_jobs (
  task_id,
  quote_id,
  state,
  goal,
  quote,
  progress,
  deliverable,
  provenance,
  refund
) VALUES (
  $1,
  $2,
  'paid',
  $3,
  $4::jsonb,
  '[]'::jsonb,
  NULL,
  NULL,
  NULL
);
```

Required fields:
- `task_id`: gateway-generated `t_...` id.
- `quote_id`: original quote id.
- `state`: `paid` for normal execution. The worker also claims `planning` for local recovery/testing.
- `goal`: original user goal.
- `quote`: JSON matching the `Quote` model in `apps/firm/src/firm/models.py`.

`quote` minimum:

```json
{
  "quote_id": "q_...",
  "price": {"amount": "600000", "decimals": 6, "token": "USDT"},
  "plan_summary": [{"subtask": "launch brief", "capability": "token_launch", "max_amount": null}],
  "valid_until": "2026-07-22T18:00:00Z",
  "guarantee": "full refund if not delivered",
  "quoted_at": "2026-07-18T12:00:00Z",
  "pricing_mode": "QUOTED_AMOUNT"
}
```

## Claim Semantics

The worker claims with:

```sql
SELECT ... FOR UPDATE SKIP LOCKED
```

Only one worker can claim a job. Claimed rows are moved to `planning` before graph execution.

## Read Semantics

`get_status` reads:

```json
{
  "state": "complete",
  "progress": [
    {"subtask_id": "task", "state": "planning", "note": "...", "timestamp": "..."}
  ]
}
```

`get_result` returns only after `state = complete` and both `deliverable` and `provenance` are present:

```json
{
  "deliverable": {},
  "provenance": {}
}
```

For non-complete or unknown tasks, gateway should return a not-ready/not-found error per its MCP tool conventions.

## Local Verification

```bash
cd /home/ishitaaaaw/firm/apps/firm
DATABASE_URL=postgresql://firm:firm@127.0.0.1:5432/firm uv run firm-worker migrate
DATABASE_URL=postgresql://firm:firm@127.0.0.1:5432/firm uv run firm-worker smoke-worker
DATABASE_URL=postgresql://firm:firm@127.0.0.1:5432/firm uv run firm-worker smoke-refund
```
