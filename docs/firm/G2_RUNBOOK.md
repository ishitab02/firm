# G2 runbook — end-to-end with a live vendor

**Nothing here has been run against real money.** The chain below has been proven
end to end in simulation (`state: complete`, honest provenance). What remains is
one env var, and that is a human's to flip.

Prepared 2026-07-21 by F1. Gate G2 in docs/firm/PLAN.md.

---

## 0. Why this is NOT an express_run purchase

The obvious way to demo G2 would be to call `express_run` and watch the money
flow. **Do not.** We would be both buyer and seller — a scripted self-purchase,
which integrity rule 3 forbids in terms that leave no room ("no scripted
self-purchases, no routed volume. OKX audits for exactly this").

So G2 proves the *outbound* half: a real job, driven through the real graph,
paying a real third-party vendor, producing a real provenance receipt. The
inbound half gets proven by a genuine external buyer once listed — not by us.

The job is therefore inserted directly, and inbound charging stays in `bypass`,
which stamps `charging: "BYPASSED"` on every gateway response so no output from
this run can be mistaken for a paid one.

## 1. What is already proven (simulation, 2026-07-21)

Task `g2_dryrun_001`, worker → procurer → vendor → provenance:

| Step | Result |
|---|---|
| Job claimed from Postgres | ok |
| Sourcing against the real index | 1 candidate (OKLink #2023, score 93) |
| Buyer params reach the vendor call | `{chainIndex, address, height}` verbatim |
| Payment through the procurer | ok, capped, idempotent |
| Validation | passed: schema, non_empty_content, freshness, semantic_sanity |
| Provenance | vetted 1, hires 1, books disclosed, `guarantee_status: delivered` |
| Final state | `complete` |

Economics on that run, at a 0.1 USDT price: vendor 15 units, books 50,000 units,
margin retained 49,985. **The books call, not the vendor, is the cost driver** —
worth remembering when the Express price is set.

## 2. Controlled vendor index

`data/vendor-index.g2.json` contains ONE vendor: OKLink #2023.

This is deliberate and must not be used for the demo or the listing. Sourcing
ranks by effective score, and the 100-score vendors in the full index publish no
request schema (only 5 of 118 services document one, all of them OKLink's). A
live run against the full index would send a generic body to a vendor that
cannot parse it, earn a 400, **and pay for it** — then fire that vendor for
"failing", which would be a false accusation on camera.

For the demo, use `data/vendor-index.json` and accept that the fallback loop
fires on schema mismatch, or restrict the pool first. That is a product
decision, not a runbook one.

## 3. Pre-flight

```bash
# Postgres up on 5433 (5432 is taken by another project on this machine).
FIRM_DB_PORT=5433 docker compose up -d db
pg_isready -h 127.0.0.1 -p 5433

# Migrations current (adds firm_jobs.params).
cd apps/firm
DATABASE_URL=postgresql://firm:firm@127.0.0.1:5433/firm uv run firm-worker migrate
```

## 4. Arm the procurer (Terminal 1)

Identical to G1 except the caps, which are sized for one 15-unit call.

```bash
cd ~/Developer/firm/packages/procurer

set -a; . ../../.env; set +a
export FIRM_WALLET_KEY="$PRIVATE_KEY"
export DATABASE_URL=postgresql://firm:firm@127.0.0.1:5433/firm
export REAL_PAYMENTS_ENABLED=true
export X402_ALLOWED_ASSETS=0x779ded0c9e1022225f8e0630b35a9b54be713736
export PER_CALL_MAX=1000
export PER_TASK_MAX=1000
export DAILY_MAX=10000

echo "key length: ${#FIRM_WALLET_KEY}"   # expect 64
pnpm dev
```

Confirm before continuing:

```bash
curl -s http://127.0.0.1:8787/health | jq .
#   real_payments_enabled: true, wallet_key_present: true
curl -s http://127.0.0.1:8787/caps | jq .
#   unconfirmed_signatures: 0
#   spent_today counts REAL money only; simulated_today is reported separately
```

## 5. Insert the job (Terminal 2)

```bash
psql postgresql://firm:firm@127.0.0.1:5433/firm <<'SQL'
INSERT INTO firm_jobs (task_id, quote_id, state, goal, quote, params, progress, deliverable, provenance, refund)
VALUES (
  'g2_live_001', 'qg2_live_001', 'paid', 'Firm Express: market_snapshot',
  jsonb_build_object(
    'quote_id','qg2_live_001',
    'price', jsonb_build_object('amount','100000','decimals',6,'token','USDT'),
    'plan_summary', jsonb_build_array(jsonb_build_object('subtask','market_snapshot','capability','market_snapshot')),
    'valid_until', to_char(now() + interval '1 hour','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'quoted_at', to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'pricing_mode','QUOTED_AMOUNT', 'express', true,
    'constraints', jsonb_build_object('deadline_minutes',60,'min_vendor_score',60,'banned_categories',jsonb_build_array())
  ),
  jsonb_build_object('chainIndex','1','address','0x0000000000000000000000000000000000000000','height','21000000'),
  '[]'::jsonb, NULL, NULL, NULL
);
SQL
```

## 6. Run it — THIS SPENDS REAL MONEY

```bash
cd ~/Developer/firm/apps/firm
DATABASE_URL=postgresql://firm:firm@127.0.0.1:5433/firm \
PROCURER_URL=http://127.0.0.1:8787 \
VENDOR_INDEX_PATH=../../data/vendor-index.g2.json \
uv run firm-worker work-task g2_live_001
```

Expect `state: complete`. Cost: 15 base units = 0.000015 USDT.

## 7. Capture the evidence

```bash
# The provenance receipt — the artifact for the entry.
psql postgresql://firm:firm@127.0.0.1:5433/firm -t -A \
  -c "SELECT provenance FROM firm_jobs WHERE task_id='g2_live_001';" | jq .

# The real payment behind it.
psql postgresql://firm:firm@127.0.0.1:5433/firm \
  -c "SELECT state, mode, amount, response->'receipt'->>'tx' AS tx FROM procurer_calls WHERE task_id='g2_live_001';"

# Decode the settlement independently of our own code.
onchainos payment decode-receipt --header '<receipt.payment_response>'
```

The receipt's `hires[0].tx` must be a real `0x…` hash, not `SIMULATED:`. If it
says `PENDING_SETTLEMENT:`, the scheme settled asynchronously and the hash
appears later — that is honest, not a failure.

## 8. If it fails

- `CAP_EXCEEDED` — nothing signed. Safe. Check `/caps`; note `spent_today` is
  real-only now, so a stale simulated number is no longer the cause.
- `UNSUPPORTED_CHALLENGE` — the vendor's 402 is a shape we refuse to guess at.
  Capture it; do not loosen the parser.
- Vendor 400 — the params did not match its schema. Check `documented_example_args`
  in the index. The money is already spent at that point; that is the cost of a
  wrong body and exactly why params were plumbed through.
- `REQUIRES_HUMAN` — a signature exists with unconfirmed settlement. **Do not
  retry.** Check the chain first.

## 9. Still open after G2

- The refund wallet (LIVE_PAYMENT_RUNBOOK §4). G1 proved the payer
  `0xc0296012cfbb0e6df5da7158b65dbc46dd9650e0` is NOT the CLI-logged-in account,
  so refunds via `onchainos wallet send` would leave from a different wallet
  than the one that paid.
- The Express price and job-type lock (INTERFACES §1A says lock 2026-07-21).
- Whether the demo runs on the full index (real fallback, but fires vendors for
  schema mismatch) or a curated pool.
