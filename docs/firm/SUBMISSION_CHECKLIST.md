# Firm Submission Checklist

**Restructured 2026-07-21 after the Codex judging pass.** The previous version
opened with "Do not submit until these are true" and then listed both services,
a live refund test, and golden evals. None of those affect *eligibility*, and
gating submission on them risked burning the review window — which has taken 5+
days and rejected this team twice — waiting on things a reviewer never sees.

The listing and the submission form are separate deadlines with separate
blockers. Confusing them is the most expensive mistake still available.

---

## A. Blocks the LISTING — submit the moment these are true

Everything here is already true. **The listing is submittable now.**

- [x] Public HTTPS endpoint, always on: `https://firm-gateway.fly.dev`
- [x] `onchainos agent x402-check` returns `valid: true` against that URL
- [x] The 402 challenge carries the right asset, network, payTo and decimals
      (USD₮0, `eip155:196`, 6)
- [x] `CHARGING_MODE=enforce` — an unpaid paid-tool call gets a 402 and writes
      nothing
- [x] The worker is deployed, so a paid job is actually worked rather than
      sitting at PENDING forever
- [x] `packages/procurer` completed the human-triggered real payment spike.
      tx `0x493a34a5b33dc8c17760a81d4b028f298ccb9264d19dd1032e9549b182f26072`
      on X Layer to OKLink #2023, with an idempotency re-fire proving no
      double-pay.
- [ ] **Submitted, with the service REGISTERED** — not merely the agent activated

**One service: Firm Express.** Not both. Projects cannot drive vendors that
require request parameters, so listing it makes the surface look less complete
rather than more. `service-list` returning `[]` is what sank Treasury twice;
one registered service that works beats two where one is thin.

Listing values, locked:

| field | value |
|---|---|
| type | API service (A2MCP) |
| endpoint | `https://firm-gateway.fly.dev` |
| service | Firm Express |
| job type | `market_snapshot` |
| price | 0.1 USDT |

Capture at submission time, because a rejection is far cheaper to appeal with
them in hand: Agent ID, submission ID, timestamp, the endpoint, and the
`x402-check` output verbatim.

## B. Blocks the SUBMISSION FORM — a separate deadline, do not conflate

- [ ] 90-second demo video
- [ ] Hackathon Google form (distinct from the OKX listing; both are due)
- [ ] X post with `#OKXAI`

## C. Blocks PUBLIC CLAIMS — neither the listing nor the form

These gate what may be *said*, not what may be submitted. Anything unmet here
means the claim comes out of the copy — not that the entry waits.

- [x] `data/vendor-index.json` generated from a real marketplace scan
- [x] Receipts disclose Treasury Copilot as intra-team books, never as external
      revenue
- [x] Provenance economics reconcile: `user_price = vendor_costs + books + margin`
- [ ] Any simulated demo segment is labelled `SIMULATED` on screen
- [ ] **The refund path has moved real money.** Until then the guarantee is
      described as implemented and tested, never as *proven in production*.
- [ ] **One inbound customer payment has settled.** Until then the wording is
      "two real third-party procurement transactions, zero customer revenue".
      Outbound spend is a cost and must never be presented as traction.
- [ ] "Darwinian" is not used publicly unless the whole loop is demonstrable:
      vendor ranks high -> paid result fails a validator -> score drops -> a
      later job ranks it lower. Otherwise say "adaptive fallback with
      accumulated performance evidence."

## D. Known limitations — disclose rather than fix

- Firm Projects cannot drive schema-bearing vendors
- The books line is SIMULATED until Treasury is listed
- The settle success path is unproven: auth and rejection are verified against
  OKX's live facilitator, but no valid authorization has completed
- Multi-subtask jobs work in code, never run against real vendors

---

## Current commands

Note the DB port: **5433**, not 5432. Another project holds 5432 locally and
answers `pg_isready` while being the wrong database.

```bash
# Vendor background check — free, ~1s, safe to run on camera
node tools/demo/background-check.js

# Full marketplace probe
pnpm -F @firm/procurer vet -- --index data/marketplace-scan.json --out data/health.json

# Validate the live endpoint against OKX's own checker
onchainos agent x402-check --endpoint https://firm-gateway.fly.dev \
  --body '{"tool":"express_run","args":{"job_type":"market_snapshot","params":{"symbol":"BTC"}}}'

# Local stack
docker compose up -d db
cd apps/firm && DATABASE_URL=postgresql://firm:firm@127.0.0.1:5433/firm uv run firm-worker migrate
```
