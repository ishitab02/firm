# Live payment runbook (F1)

**STATUS: G1 EXECUTED 2026-07-21.** The first live payment has been fired by a
human (Poulav) and succeeded — tx
`0x493a34a5b33dc8c17760a81d4b028f298ccb9264d19dd1032e9549b182f26072`, X Layer,
0.000015 USD₮0 to OKLink #2023. See docs/status/F1.md for the full evidence and
the idempotency proof. The first live REFUND is still unfired and still blocked
(§4). Every command below remains prepared for a human to run. The first live payment and the first live refund are
human-triggered by rule (CLAUDE.md non-negotiables, PLAN gate G1).

Prepared: 2026-07-20. Owner: Poulav (F1).

---

## 0. What is actually implemented

| Piece | State |
|---|---|
| 402 detection (v2 `PAYMENT-REQUIRED` header, v1 body) | implemented, unit-tested |
| Offer selection (signable schemes, asset allow-list, cheapest wins) | implemented, unit-tested |
| Amount verified against `max_amount` and per-call cap **before signing** | implemented, test asserts call ordering |
| Reservation against per-task/daily caps **before the vendor is probed** | implemented, concurrency-tested against Postgres |
| Signing via `onchainos payment pay-local` (reads `EVM_PRIVATE_KEY`) | implemented, **not yet run against a real 402** |
| Paid replay + `PAYMENT-RESPONSE` capture | implemented, tested against a local fake vendor |
| Idempotency on `(task_id, subtask_id, vendor_endpoint)` in Postgres | implemented, concurrency-tested |
| Refund auto-approval up to the quoted price, `REQUIRES_HUMAN` beyond | implemented, tested |
| Real refund transfer | implemented behind `REAL_REFUNDS_ENABLED`, **blocked** — see §4 |

## 1. Verified buyer-flow shape

Recorded against `onchainos 4.2.6` installed locally, and the OKX Agent Payments
Protocol reference. This is what `packages/procurer` builds to:

1. Call the vendor tool unpaid. A gated vendor answers **HTTP 402**.
2. The challenge arrives either as a `PAYMENT-REQUIRED` response header holding
   base64 JSON `{x402Version, resource, accepts[]}` (v2), or as that same JSON in
   the response body (v1). Header wins when both are present.
3. The price is `accepts[i].amount` (v2) or `accepts[i].maxAmountRequired` (v1),
   always a base-unit integer string.
4. Sign with `onchainos payment pay-local --payload <base64> --selected-index <n>`.
   It reads the hex key from `EVM_PRIVATE_KEY`, signs locally, and returns
   `{authorization_header, header_name, scheme, wallet}`. `header_name` is
   `PAYMENT-SIGNATURE` for v2; for legacy v1 the CLI returns a raw
   `{signature, authorization}` proof and the caller assembles `X-PAYMENT`.
5. Replay the original request with that header. Expect 200 plus a
   `PAYMENT-RESPONSE` header holding base64 JSON
   `{status, transaction, amount, payer, chainId}`.
6. `scheme: "exact"` settles immediately, so `transaction` is final.
   `aggr_deferred` may report `pending` — but the procurer never selects it,
   because `pay-local` cannot sign it without a TEE-resident session key.

### Where this contradicts INTERFACES §5

INTERFACES §5 describes `/pay-and-call` returning `receipt.tx` as `"0x..."`.
That holds for `exact`, which is the only scheme the procurer will select. It
does **not** hold universally: a scheme that settles asynchronously has no hash
at response time. The procurer returns `PENDING_SETTLEMENT:<scheme>` in that
case rather than inventing a hash. No schema change proposed; flagging it so the
receipt consumer does not assume `0x`-prefixed.

## 2. Pre-flight, before any human fires anything

```bash
# 1. Caps are what you think they are, and nothing is mid-flight.
curl -s http://127.0.0.1:8787/caps | jq .
#    unconfirmed_signatures MUST be 0.

# 2. The procurer knows it is armed.
curl -s http://127.0.0.1:8787/health | jq .
#    expect real_payments_enabled: true, wallet_key_present: true

# 3. The wallet actually holds the asset, on the network the vendor wants.
onchainos wallet balance
```

Set the caps to spike-sized values for the first run. Suggested for a first
probe (base units, 6 decimals — 0.20 / 0.20 / 0.50 USDT):

```bash
export PER_CALL_MAX=200000
export PER_TASK_MAX=200000
export DAILY_MAX=500000
```

## 3. The first live payment — DO NOT RUN WITHOUT A HUMAN GO

```bash
# Terminal 1 — arm the procurer.
cd packages/procurer
DATABASE_URL=postgresql://firm:firm@127.0.0.1:5432/firm \
REAL_PAYMENTS_ENABLED=true \
FIRM_WALLET_KEY='<funded key, from the operator’s password manager, never a file in this repo>' \
X402_ALLOWED_ASSETS='<the token contract the vendor charges in>' \
PER_CALL_MAX=200000 PER_TASK_MAX=200000 DAILY_MAX=500000 \
pnpm dev

# Terminal 2 — one call, one subtask, one vendor.
curl -s -X POST http://127.0.0.1:8787/pay-and-call \
  -H 'content-type: application/json' \
  -d '{
    "task_id": "spike_001",
    "subtask_id": "s0",
    "vendor_endpoint": "<REAL third-party ASP endpoint — OPEN, see §5>",
    "tool": "<the vendor’s tool name>",
    "args": {},
    "max_amount": {"amount": "200000", "decimals": 6, "token": "USDT"}
  }' | jq .
```

### Capture immediately afterwards

```bash
# The recorded receipt, straight from the idempotency table.
psql "$DATABASE_URL" -c \
  "SELECT idempotency_key, state, amount, response FROM procurer_calls WHERE task_id='spike_001';"

# Decode the raw settlement header the vendor returned.
onchainos payment decode-receipt --header '<receipt.payment_response>'
```

Then re-run the exact same curl. It must return the **recorded receipt** and must
not produce a second payment — that is the idempotency evidence for the entry.

### If it fails

- `CAP_EXCEEDED` — nothing was signed. Safe.
- `UNSUPPORTED_CHALLENGE` — the vendor's 402 is a shape we refuse to guess at.
  Capture the raw 402 and bring it back; do not loosen the parser to make it fit.
- `REQUIRES_HUMAN` on retry — a signature already exists for that key and its
  settlement is unconfirmed. **Do not retry.** Check the chain for the payer
  address first; the money may already be gone.

## 4. Refunds — implemented, but blocked on a decision

`POST /refund` enforces the full policy: auto-approve up to the task's quoted
price (read from `firm_jobs`, never from the request), `REQUIRES_HUMAN` above it,
daily refund cap, and idempotency per task. That is all live and tested.

The **transfer** is the blocker. The payment path signs with a local hex key
(`FIRM_WALLET_KEY` → `pay-local`), but the only outbound-transfer surface the CLI
exposes is `onchainos wallet send`, which signs through the logged-in TEE-backed
Agentic Wallet account. Those are not necessarily the same wallet.

A human has to pick:

- **(a)** Require that the logged-in Agentic Wallet account is the same funded
  account whose key is in `FIRM_WALLET_KEY`. No new code; a deployment
  constraint, and a footgun if anyone logs in as someone else.
- **(b)** Add a local ERC-20 transfer signer to the procurer. Costs a web3
  dependency and a verified RPC endpoint, and puts more key-handling code in the
  quarantine.

Until then `REAL_REFUNDS_ENABLED` stays off, separately from
`REAL_PAYMENTS_ENABLED`, so arming payments cannot accidentally arm refunds.

When (a) is chosen, the prepared first-refund command is:

```bash
REAL_REFUNDS_ENABLED=true \
REFUND_CHAIN='<chain>' \
REFUND_TOKEN_CONTRACT='<token contract>' \
curl -s -X POST http://127.0.0.1:8787/refund \
  -H 'content-type: application/json' \
  -d '{"task_id":"spike_001","to_address":"<user address>","amount":{"amount":"10000","decimals":6,"token":"USDT"}}'
```

## 5. Spike target candidates — real, from a real scan

`tools/vendor-index/scan.js` now scans the live marketplace via
`onchainos agent search`. The 2026-07-20 scan found 218 agents, 95 of them with
a callable endpoint and 395 priced services. Full data in
`data/marketplace-scan.json` (raw) and `data/vendor-index.json` (processed).

The recommended spike target, and why:

| | |
|---|---|
| Agent | **#2023 Onchain Data Explorer** (OKLink's own x402 MCP surface) |
| Service | `Address Balance Snapshot` (service id 17305), maps to `market_snapshot` |
| Endpoint | `https://www.oklink.com/api/v5/explorer/mcp/x402/get_address_balance_history` |
| Price | `0.000015 USDT` = **15 base units**, 6 decimals |
| Track record | 1572 completed sales, feedback 92.86, security 4.86, no derived risk flags |
| Fee token | `0x779ded0c9e1022225f8e0630b35a9b54be713736` — USD₮0 (USDT), X Layer (chain 196), 6 decimals, **verified via `onchainos token info`**, not assumed |

At 15 base units the entire spike costs less than a fifty-thousandth of a cent,
which makes it the cheapest possible way to prove the whole path end to end.

The service documents its own parameters: POST only (GET returns 405), requires
`chainIndex`, `address`, `height`.

Runner-up, if a second vendor is wanted: **#5524 API2ASP Factory** at 0.01 USDT
(10000 base units), feedback 100, security 5, 12 sales.

### The prepared spike call

```bash
curl -s -X POST http://127.0.0.1:8787/pay-and-call \
  -H 'content-type: application/json' \
  -d '{
    "task_id": "spike_001",
    "subtask_id": "s0",
    "vendor_endpoint": "https://www.oklink.com/api/v5/explorer/mcp/x402/get_address_balance_history",
    "tool": "get_address_balance_history",
    "args": {"chainIndex": "1", "address": "0x0000000000000000000000000000000000000000", "height": "21000000"},
    "max_amount": {"amount": "15", "decimals": 6, "token": "USDT"}
  }' | jq .
```

with the procurer armed as in §3 and:

```bash
export X402_ALLOWED_ASSETS=0x779ded0c9e1022225f8e0630b35a9b54be713736
export PER_CALL_MAX=1000 PER_TASK_MAX=1000 DAILY_MAX=10000
```

Note the endpoint already carries a path, so `toolUrl` will use it verbatim
rather than appending `/tools/<tool>` — which is the behaviour the unit test
`toolUrl` pins.

**RUN 2026-07-21 and it succeeded.** Payer `0xc0296012cfbb0e6df5da7158b65dbc46dd9650e0`.

## 6. Still open, needs a human

1. **Go/no-go on the spike target above.** The "which ASP" question is now
   answered with real data; what remains is a human saying yes.
2. **`kya_base_score` is null, so the default index does NOT load in the worker.**
   Verified: all 58 entries fail `VendorIndexEntry` on
   `kya_base_score: Input should be a valid integer`. This is deliberate, not a
   bug — apps/kya is absent from this repo and INTERFACES §4 requires the
   fixture-scoring bug be reconciled before the index is trusted, so the
   generator will not pass the marketplace's `feedbackRate` off as a KYA score.

   Two ways out:
   - bring apps/kya in and score properly, or
   - `ALLOW_FEEDBACK_RATE_AS_BASE_SCORE=true`, which rounds `feedbackRate` into
     the field and stamps the substitution into the file's `provenance` block.

   Verified that the opt-in path produces a **fully worker-loadable index: 15
   vendors, 15/15 parse, 0 failures.** It drops to 15 because agents with no
   rating at all are skipped rather than scored as zero — no rating is not a bad
   rating, and inventing one would be inventing a reputation.

3. **Capability coverage.** Of 395 priced services the keyword rules map 211 to
   `market_snapshot` and only 4 to `token_launch`; 180 stay uncategorised and are
   dropped from the index (they remain in the raw scan). If Projects needs real
   `token_launch` vendors, that thin result is worth a look before the demo
   depends on it.
4. **The refund wallet decision** in §4.
5. **Pricing mechanics** (INTERFACES 1B) remains OPEN. The gateway still defaults
   to `TIERS`.
6. **X402_FACILITATOR_URL** for the gateway's inbound charging (F2 blocker).
