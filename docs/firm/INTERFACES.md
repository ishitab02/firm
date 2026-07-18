# FIRM INTERFACES — Frozen contracts

Status: DRAFT until end of July 19, then FROZEN.
Change protocol after freeze: written sign-off from BOTH humans, version bump, matching mocks/evals update in the same PR. Agents propose changes in docs/status/, never apply them.

Version: 0.1.0
Conventions: money amounts are strings in base units with a decimals field (USDT/USDG: 6). Timestamps ISO-8601 UTC. All tools served by apps/firm-gateway over MCP (streamable HTTP), charging via the seller-side payment adapter exactly as Treasury does.

---

## 1. Services and tools

One ASP (registered under Ishita's Agentic Wallet), two services.

### Service A: "Firm Express" (the repeatable cheap hero)

Fixed-price, single-vendor jobs with instant results. Placeholder price: 0.5 USDT per run.

**express_run** (paid, fixed price)
Request: `{ "job_type": "market_snapshot" | "<locked after vendor testing>", "params": { ... per job_type schema } }`
Response (target under 60s, synchronous):
```json
{
  "deliverable": { ... },
  "receipt": {
    "vendor": {"agent_id": "...", "name": "..."},
    "vendor_cost": {"amount": "100000", "decimals": 6, "token": "USDT"},
    "vendor_tx": "0x...",
    "validation": {"passed": true, "checks": ["schema", "freshness"]},
    "firm_margin": {"amount": "400000", "decimals": 6}
  }
}
```
If the vendor fails validation, Express retries the next candidate silently (max 2 retries). If all fail: automatic refund, response `{"error": {"code": "DELIVERY_FAILED_REFUNDED", "refund_tx": "0x..."}}`.
Job types v1: exactly 1 to 2 types, LOCKED on July 21 after vendor reliability testing. Do not add more.

### Service B: "Firm Projects" (the flagship)

**get_quote** (free)
Request: `{ "goal": "...", "budget_cap": {"amount": "5000000", "decimals": 6}, "constraints": {"deadline_minutes": 60, "min_vendor_score": 60, "banned_categories": []} }`
Response:
```json
{
  "quote_id": "q_...",
  "price": {"amount": "4800000", "decimals": 6, "token": "USDT"},
  "plan_summary": [{"subtask": "token launch", "capability": "launcher"}, ...],
  "valid_until": "2026-07-22T18:00:00Z",
  "guarantee": "full refund if not delivered"
}
```
Quote math (deterministic, documented): `price = vendor_estimate_total + retry_reserve + firm_fee`, where `retry_reserve = max(cost of one retry of the most expensive subtask, 30% of vendor_estimate_total)` and `firm_fee = 0.2 USDT` flat. If price would exceed budget_cap: return `{"error": {"code": "CANNOT_QUOTE_WITHIN_BUDGET", "minimum_viable": {...}}}`.

**execute** (paid: charges the quoted price)
Request: `{ "quote_id": "q_..." }` -> `{ "task_id": "t_...", "state": "planning" }`
PRICING MECHANICS OPEN QUESTION (owner: Poulav, due July 19): our 402 challenge amount is server-set per request, so charging the quoted amount is technically ours to control. Unverified: whether the OKX listing fee field must match every charge, and whether marketplace buyer skills honor variable amounts. FALLBACK if variable amounts are a problem: three fixed tiers S/M/L at 1 / 3 / 5 USDT; get_quote maps the estimate to the nearest tier at or above it. Both paths keep the same tool schemas.

**get_status** (free)
`{ "task_id": "t_..." }` -> `{ "state": "...", "progress": [{"subtask_id": "...", "state": "...", "note": "..."}] }`

**get_result** (free, only returns for a paid, completed task)
`{ "task_id": "t_..." }` -> `{ "deliverable": {...}, "provenance": <ProvenanceReceipt> }`

---

## 2. Job state machine

`quoted -> paid -> planning -> sourcing -> vetting -> procuring -> validating -> assembling -> booking -> complete`
Exception transitions: `validating -> procuring` (fallback: fire and re-hire, decrement candidates), `any -> refunding -> refunded` (candidates exhausted, or budget breach imminent), `any -> failed_refunded` (unrecoverable, refund issued).
Every transition is checkpointed in Postgres with a timestamp and note. A restarted worker resumes from the last checkpoint and MUST NOT re-execute a completed payment (idempotency key: task_id + subtask_id + vendor).

---

## 3. ProvenanceReceipt (attached to every Projects deliverable)

```json
{
  "task_id": "t_...",
  "goal": "...",
  "quote": {"price": {...}, "quoted_at": "..."},
  "vendors_vetted": 4,
  "vendors_rejected": [{"agent_id": "...", "reason": "trust score 41 below minimum 60"}],
  "vendors_fired": [{"agent_id": "...", "subtask": "...", "reason": "validation failed: stale data", "cost_absorbed": {...}}],
  "hires": [{"agent_id": "...", "subtask": "...", "cost": {...}, "tx": "0x...", "validation": {"passed": true, "checks": [...]}}],
  "economics": {
    "user_price": {...},
    "actual_vendor_costs": {...},
    "margin_retained_or_absorbed": {"amount": "...", "sign": "retained" | "absorbed"}
  },
  "books": {"by": "Treasury Copilot (our own product, intra-team payment, disclosed)", "cost": {...}, "tx": "0x...", "statement": "..."},
  "guarantee_status": "delivered" | "refunded",
  "generated_at": "..."
}
```
The economics block MUST be truthful in both directions: retained margin on clean runs, absorbed margin on failure runs. Never hide a firing.

---

## 4. Vendor index and Darwinian performance data

**data/vendor-index.json** (generated by script, Poulav's lane, regenerated at will):
```json
[{ "agent_id": "5164", "name": "HatchAI", "endpoint": "...", "services": [{"tool": "...", "price": {...}, "capability": "token_launch"}],
   "kya_base_score": 78, "flags": [], "last_verified_at": "..." }]
```
Base scores come from the KYA scoring engine (apps/kya). PRECONDITION: reconcile the known fixture-scoring bug (declared scores vs weighted sums) BEFORE generating the index; an untrustworthy trust score is worse than none.

**Postgres table vendor_performance** (the Darwinian layer, Ishita's lane):
`(agent_id, calls, successes, validation_failures, timeouts, last_failure_at, adjustment)`
`adjustment` in [-30, +10], applied to kya_base_score at sourcing time. Every procurement outcome updates this table. Firing decrements immediately.

Effective score = clamp(kya_base_score + adjustment, 0, 100). Sourcing ranks by effective score, filters by min_vendor_score and flags.

---

## 5. packages/procurer HTTP API (internal only, localhost)

**POST /pay-and-call** `{ "vendor_endpoint": "...", "tool": "...", "args": {...}, "max_amount": {...}, "task_id": "...", "subtask_id": "..." }`
-> `{ "ok": true, "result": {...}, "receipt": {"amount": {...}, "tx": "0x...", "payment_response": "..."}, "latency_ms": 1234 }`
-> or `{ "ok": false, "error_code": "VENDOR_TIMEOUT" | "PAYMENT_FAILED" | "CAP_EXCEEDED" | "VENDOR_ERROR", "detail": "..."}`
Enforces: per-call cap, per-task cap (sum across subtasks), daily wallet cap. Rejects any call that would breach BEFORE paying. Idempotent on (task_id, subtask_id, vendor_endpoint): a repeat request returns the recorded receipt, never a second payment.

**POST /refund** `{ "task_id": "...", "to_address": "0x...", "amount": {...} }` -> `{ "tx": "0x..." }`
Auto-approved up to the task's quoted price; anything beyond returns REQUIRES_HUMAN. Daily refund cap enforced.

**GET /health**, **GET /caps** (current caps + spend today).

The procurer is the ONLY component in The Firm allowed to hold a key or send transactions. Nothing else imports wallet code. Env: FIRM_WALLET_KEY (never in repo), PER_CALL_MAX, PER_TASK_MAX, DAILY_MAX, DAILY_REFUND_MAX.

---

## 6. Validation stack interface (Ishita's lane)

Per job_type / capability, a validator: `validate(deliverable, subtask_spec) -> {"passed": bool, "checks_run": [...], "failures": [{"check": "...", "detail": "..."}]}`
Minimum checks v1: schema conformance, non-empty content, URL liveness where applicable, freshness where timestamps exist, semantic sanity (cheap LLM rubric against the subtask's acceptance criteria). Validators are pure and unit-tested against the vendor fixtures in packages/mocks.

---

## 7. Golden evals (extend tests/, Ishita's Codex lane; gate for listing submission)

1. Quote honored: execute charges exactly the quoted amount; a run with one firing still delivers at the quoted price with margin shown as absorbed.
2. Fallback fires: given fixture vendors (good, flaky, dead), the flaky vendor's failure triggers firing, performance downgrade, and re-hire of the next candidate; user-visible output is unaffected.
3. Refund on total failure: all candidates exhausted -> state failed_refunded, refund receipt present, no partial charge retained.
4. Provenance completeness: every completed run's receipt contains vetted count, rejections with reasons, all payments with tx refs, truthful economics block, disclosed books line.
5. Budget safety: no sequence of vendor prices can cause total vendor spend to exceed the per-task cap; attempted breach halts before payment.