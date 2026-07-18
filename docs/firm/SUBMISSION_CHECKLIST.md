# Firm Submission Checklist

Do not submit until these are true.

- Pricing mode is decided or explicitly set to `TIERS`.
- Ishita Agentic Wallet and ASP registration path are confirmed.
- One ASP lists both services: Firm Express and Firm Projects.
- `apps/firm-gateway` serves all five tools: `express_run`, `get_quote`, `execute`, `get_status`, `get_result`.
- `packages/procurer` has completed the human-triggered real payment spike.
- F3 worker has a live Postgres queue smoke passing.
- F4 golden evals pass against the worker.
- `data/vendor-index.json` is generated from a real marketplace scan, not invented data.
- Demo clearly labels any simulated segment as `SIMULATED`.
- Receipts disclose Treasury Copilot as intra-team books and never count that as external revenue.
- Refund path has been tested with a small human-approved live amount before public claims.

Current commands:

```bash
cd apps/firm
DATABASE_URL=postgresql://firm:firm@127.0.0.1:5432/firm uv run firm-worker smoke-worker
DATABASE_URL=postgresql://firm:firm@127.0.0.1:5432/firm uv run firm-worker smoke-refund

cd ../..
DATABASE_URL=postgresql://firm:firm@127.0.0.1:5432/firm node --test --test-concurrency=1 tests/firm-evals/worker-live.test.js tests/firm-evals/gateway-worker-live.test.js tests/firm-evals/procurer-live.test.js tests/firm-evals/gateway-procurer-live.test.js

PORT=8790 DATABASE_URL=postgresql://firm:firm@127.0.0.1:5432/firm PRICING_MODE=QUOTED_AMOUNT ./apps/firm-gateway/node_modules/.bin/tsx apps/firm-gateway/src/server.ts
DATABASE_URL=postgresql://firm:firm@127.0.0.1:5432/firm node tools/demo/scenario.js --gateway-url=http://127.0.0.1:8790
```
