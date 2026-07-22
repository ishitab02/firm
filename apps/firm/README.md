# Firm Worker

`apps/firm` is the Python brain for Firm. It plans jobs, sources vendors, vets them, calls `packages/procurer` over HTTP, validates deliverables, performs fallback/refund transitions, assembles the final deliverable, and emits the `ProvenanceReceipt` defined in `docs/firm/INTERFACES.md`.

Hard boundaries:
- This app never imports wallet code and never signs or sends transactions.
- All vendor payments and refunds go through the procurer HTTP API.
- Treasury is live production and is only called through an explicit disclosed books step when humans enable that integration.
- Simulated receipts or tx references must be labeled `SIMULATED`.

Local setup:

```bash
cd apps/firm
uv sync
uv run pytest
uv run firm-worker migrate
uv run firm-worker work-once
uv run firm-worker run --poll-seconds 2
uv run firm-worker smoke-worker
uv run firm-worker smoke-refund
uv run firm-worker status <task_id>
uv run firm-worker result <task_id>
uv run firm-worker demo
```

Required environment:

```bash
PROCURER_URL=http://127.0.0.1:8787
VENDOR_INDEX_PATH=../../data/vendor-index.json
DATABASE_URL=postgresql://firm:firm@127.0.0.1:5432/firm
FIRM_PRICING_MODE=TIERS
ENABLE_TREASURY_BOOKS=false
TREASURY_BOOKS_URL=
```

`FIRM_PRICING_MODE` supports `QUOTED_AMOUNT` and `TIERS`. The dynamic-pricing question remains open until humans close it, so both paths are implemented.

Production products:

- **Firm Express**: one BTC or ETH snapshot at 1h, 2h, 4h, or 1d.
- **Firm Projects**: two to four BTC/ETH symbol/timeframe legs. Every leg buys
  and validates an OKLink #2023 historical price series independently; the
  worker assembles the bundle only when every leg passes and otherwise runs the
  full-refund path. The public paid endpoint is `POST /projects`: it returns the
  completed deliverable and provenance inline when the worker finishes within
  the request window, and always supplies a free recovery URL at
  `GET /projects/<task_id>`.
