# The Firm: code map and submission review

Audit target: branch `f1/x402-live-money`, commit
`883f2692c006287d5617dafbeabec9fc6092858f`, reviewed 2026-07-21.

Snapshot note: the worktree was clean when the audit began. While this document
was being written, another process added an uncommitted procurer `/vet` endpoint
(`packages/procurer/src/vet.ts` plus `server.ts` wiring). Those concurrent edits
are preserved but excluded from this commit-pinned review. They do not change the
money, refund, worker, validation or deployment findings below, and the worker does
not yet call that endpoint.

Evidence convention:

- **Verified** means the statement follows from executable code or was reproduced in this review.
- **Recorded evidence** means a status file reports a run; it is not silently promoted to a source-code fact.
- **Inference** names the check needed to close the uncertainty.

The highest-risk conclusion is simple: the outbound payment spike is real, but the
inbound seller path and refund guarantee are not production-safe yet. The gateway
verifies an x402 authorization and releases the paid tool without ever asking the
facilitator to settle it (`apps/firm-gateway/src/charging.ts:93-130`,
`apps/firm-gateway/src/server.ts:416-429`). Separately, when outbound payments are
real but `REAL_REFUNDS_ENABLED` remains false, `/refund` returns a `SIMULATED:` tx
and the worker records the job as refunded (`packages/procurer/src/server.ts:212-215`,
`apps/firm/src/firm/graph.py:281-291`). Those two paths invalidate the current
commercial promise until fixed.

## 1. Map

### 1.1 The product in one paragraph

The buyer supplies a goal, budget and trust constraints. Firm Projects returns a
free fixed quote and, after the buyer pays, asynchronously hires marketplace
vendors, validates their responses, tries replacements, and returns an assembled
deliverable plus a cost/provenance receipt. Firm Express skips quoting: it charges
a fixed price for one `market_snapshot` request and waits up to 60 seconds for the
same worker pipeline. The intended premium buys sourcing, vetting, validation,
fallback and a full-refund guarantee, rather than merely reselling one API response
(`README.md:3-15`). In the current code, planning is keyword-based, vendor calls are
mostly generic, validation is a deterministic shape/content floor, and Treasury
bookkeeping is simulated; those limits matter to what the buyer actually receives.

### 1.2 Request lifecycle

#### Firm Express

1. **HTTP/MCP dispatch.** `server.ts` accepts a POST, parses it with `readJson`, and
   `mcpDispatch` maps either MCP `tools/call` or the legacy `{tool,args}` shape to
   `express_run` (`apps/firm-gateway/src/server.ts:434-470`,
   `apps/firm-gateway/src/mcp.ts:83-108`).
2. **Pre-charge eligibility.** `chargeGate` validates `job_type`, checks
   `EXPRESS_ENABLED` and the job-type allow-list, and either rejects for free,
   bypasses with an explicit marker, or constructs the fixed-price challenge
   (`apps/firm-gateway/src/server.ts:315-363`).
3. **Inbound payment gate.** `sellerCharge` builds a v2 `exact` challenge and calls
   `verifyPayment`; a missing/unverified credential gets HTTP 402
   (`apps/firm-gateway/src/server.ts:389-429`). **Important:** this calls only
   `/verify`, not `/settle` (`apps/firm-gateway/src/charging.ts:93-130`). The
   gateway later fabricates a `PAYMENT-RESPONSE`-shaped header from verification
   fields (`apps/firm-gateway/src/server.ts:484-485`).
4. **Job creation.** `toolCall("express_run")` creates a synthetic quote and writes
   a `paid` `firm_jobs` row, including the buyer params verbatim
   (`apps/firm-gateway/src/server.ts:205-243`).
5. **Synchronous wait.** The gateway does not run the graph. It polls `firm_jobs`
   for at most `EXPRESS_TIMEOUT_MS`; success is reshaped into the Express receipt,
   failure into `DELIVERY_FAILED_REFUNDED`, and timeout into the non-contractual
   `EXPRESS_PENDING` response (`apps/firm-gateway/src/server.ts:245-275`). A
   separate `firm-worker` must already be running.
6. **Queue claim.** `run_loop` calls `run_one`; `claim_next_task` atomically changes
   the oldest `paid` or stale in-progress row to `planning` using `FOR UPDATE SKIP
   LOCKED` (`apps/firm/src/firm/worker.py:57-71`,
   `apps/firm/src/firm/storage.py:167-217`).
7. **Graph execution.** `run_task` invokes the compiled LangGraph from its entry
   point every time (`apps/firm/src/firm/worker.py:33-54`). Nodes run in this order:
   `planning_node` -> `sourcing_node` -> `vetting_node` -> `procuring_node` ->
   `validating_node` -> `assembling_node` -> `booking_node`, or `refunding_node` ->
   `booking_node` on exhaustion (`apps/firm/src/firm/graph.py:359-387`).
8. **Source and vet.** `sourcing_node` loads per-capability candidates, applies the
   quote's score/flag constraints, ranks by effective score, and records rejections;
   `vetting_node` only records the state transition (`apps/firm/src/firm/graph.py:49-97`).
9. **Procure and fallback.** `_procure_subtask` checks documented parameter keys,
   then calls the localhost procurer with the service's indexed price as
   `max_amount` (`apps/firm/src/firm/graph.py:127-182`). Non-success moves to the
   next candidate. Success is validated; a validation failure records a hire, a
   firing and a -10 performance adjustment before moving to the next candidate
   (`apps/firm/src/firm/graph.py:183-230`). There is no Express-specific maximum
   of two retries.
10. **Outbound payment.** `HttpProcurer.pay_and_call` POSTs to `/pay-and-call`
    (`apps/firm/src/firm/procurer.py:15-24`). The procurer reserves the indexed
    ceiling under a global Postgres advisory lock before contacting the vendor
    (`packages/procurer/src/server.ts:88-111`, `packages/procurer/src/db.ts:147-240`).
    It probes the vendor, parses/selects an x402 offer, checks scale and caps,
    invokes `onchainos payment pay-local`, marks the row signed, replays the call,
    and stores the result/receipt (`packages/procurer/src/vendor.ts:94-245`,
    `packages/procurer/src/signer.ts:55-112`).
11. **Validate and assemble.** `validate` rejects conventional vendor error fields,
    empty/short content, stale `generated_at`, and malformed cited URLs
    (`apps/firm/src/firm/validation.py:90-169`). The worker wraps accepted output in
    a Firm result (`apps/firm/src/firm/graph.py:242-252`).
12. **Receipt.** `booking_node` calls `build_provenance`, persists the receipt, and
    sets `complete` (`apps/firm/src/firm/graph.py:255-269`). There is no Treasury
    network call: `ENABLE_TREASURY_BOOKS` only changes a hard-coded cost and tx
    string (`apps/firm/src/firm/graph.py:295-349`).

#### Firm Projects

The worker half is identical; only the front half differs.

1. `get_quote` validates the request, derives one or two subtasks from keywords,
   assigns hard-coded estimates (0.1 USDT for market, 0.3 for launch), applies the
   frozen reserve/fee formula, and persists `firm_quotes`
   (`apps/firm-gateway/src/server.ts:116-148`,
   `apps/firm-gateway/src/pricing.ts:8-30`).
2. `execute` loads the unexpired quote *before* charging so the exact amount is
   known. After verification, it inserts a `paid` job and returns
   `{task_id,state:"planning"}` (`apps/firm-gateway/src/server.ts:151-178`,
   `apps/firm-gateway/src/server.ts:288-302`).
3. `get_status` reads `state/progress`; `get_result` returns only completed output,
   or a structured refund audit for `failed_refunded`
   (`apps/firm-gateway/src/server.ts:181-203`).

Why the flows diverge: Express has a fixed listing price and params in its frozen
request schema, so it can issue a truthful 402 with no prior state. Projects must
first persist a quote to know the charge. Projects `execute` accepts only
`quote_id`, so it cannot carry a schema-bearing vendor request; that limitation is
recorded in the handoff (`docs/firm/HANDOFF_ISHITA.md:196-200`).

### 1.3 Money path

#### Inbound: buyer -> The Firm

- **Decision:** Express amount comes from `EXPRESS_PRICE_UNITS`; Projects amount
  comes from the persisted quote (`apps/firm-gateway/src/server.ts:356-381`).
- **Recipient/asset/network:** environment-only; missing values fail closed
  (`apps/firm-gateway/src/charging.ts:44-53`).
- **Ordering:** eligibility/quote lookup -> challenge -> facilitator verify -> job
  insert -> result. Unpaid calls do not write a job.
- **Verified weakness:** there is no facilitator settle call, no inbound-payment
  ledger and no idempotency record. Official OKX documentation separates
  [verification and settlement](https://web3.okx.com/onchainos/dev-docs/payments/api-http)
  and exposes a distinct
  [settle operation](https://web3.okx.com/onchain-os/dev-docs/payments/payment-settlement).
  The current code cannot prove the buyer was charged.
- **What would move money incorrectly:** with the current code, the more immediate
  failure is *no inbound money moves*. If settlement is added without durable
  idempotency, replaying one credential or crashing between settlement and job
  insertion can instead create duplicate delivery or a paid-without-job case.

#### Outbound: The Firm -> vendor

- **Decision:** the worker authorizes at most the indexed service price
  (`apps/firm/src/firm/graph.py:173-180`). The procurer reserves that ceiling
  against per-call, per-task and daily caps while holding one cross-process
  advisory lock (`packages/procurer/src/db.ts:165-239`).
- **Ordering:** reserve ceiling -> unpaid probe -> parse/select exact offer -> check
  declared decimal scale -> check actual amount against ceiling/per-call cap ->
  sign -> persist `signed` -> paid replay -> settle the DB row
  (`packages/procurer/src/vendor.ts:116-200`,
  `packages/procurer/src/server.ts:134-181`). This is the strongest part of the
  system.
- **Idempotency:** `(task_id, subtask_id, vendor_endpoint)` maps to one row. Settled
  calls replay the stored response; signed-but-uncertain calls require a human;
  pre-sign failures release the reservation (`packages/procurer/src/db.ts:168-204`).
- **What would move money incorrectly:** live mode currently permits an unset asset
  allow-list (`packages/procurer/src/server.ts:42-47`), and missing vendor decimals
  are treated as unknown rather than rejected (`packages/procurer/src/vendor.ts:157-176`).
  A challenge can therefore select an unintended token/network or compare units on
  an unverified scale. The `.env.example` itself warns that live mode will pay any
  named asset when the allow-list is empty (`packages/procurer/.env.example:26-32`).

#### Refund: The Firm -> buyer

- `reserveRefund` reads the authoritative quoted price from `firm_jobs`, rejects a
  larger amount, and serializes the daily refund cap
  (`packages/procurer/src/db.ts:291-363`).
- The worker targets the facilitator-reported payer, falling back to
  `DEFAULT_REFUND_ADDRESS` if payer is absent (`apps/firm/src/firm/graph.py:272-290`).
- Real refund execution uses the CLI-logged-in Agentic Wallet, not necessarily the
  local key that paid vendors (`packages/procurer/src/refund.ts:1-16`). The two
  wallets are recorded as different in the live run (`docs/status/F1.md:471-479`).
- With real refunds disabled, the path returns and persists a simulated tx while
  still reaching `failed_refunded`. That is not a safe production fallback.

### 1.4 State, persistence and crash behavior

The declared states exist in the Pydantic enum (`apps/firm/src/firm/models.py:68-81`).
The actual observed path is:

`paid -> planning -> sourcing -> vetting -> procuring -> validating -> assembling -> booking -> complete`

On exhaustion it is:

`... -> procuring -> refunding -> refunded -> refunding -> failed_refunded`

The second `refunding` is produced by `booking_node` after `refunding_node` already
persisted `refunded` (`apps/firm/src/firm/graph.py:255-291`). This differs from the
frozen state machine (`docs/firm/INTERFACES.md:65-69`). Fallback validation happens
inside `procuring`, so the specified `validating -> procuring` transition is never
observed (`apps/firm/src/firm/graph.py:183-214`). `quoted` and `paid` are not written
to `firm_job_checkpoints`; the gateway inserts the paid row with empty progress
(`apps/firm-gateway/src/server.ts:172-176`).

Each `transition` atomically updates the task snapshot and appends a checkpoint
(`apps/firm/src/firm/storage.py:238-290`). LangGraph itself has no persistent
checkpointer: `graph.compile()` receives none (`apps/firm/src/firm/graph.py:359-387`).
A reclaimed task always invokes the graph again from `planning`, with empty
in-memory `rejected/fired/hires` arrays (`apps/firm/src/firm/worker.py:33-53`).

| Crash point | Current restart behavior | Retry classification |
|---|---|---|
| Before any vendor call | stale job is reclaimed and the graph restarts | Safe for money; progress duplicates |
| Vendor reservation, before signature | same key is `in_flight`; after 900s it is reclaimed | Safe only if the original call is truly dead |
| After signature, before confirmed replay | row remains `signed`; same key returns `REQUIRES_HUMAN` | Correctly not auto-retried, but worker treats it like a vendor timeout and tries another vendor |
| After settled vendor call, before worker checkpoint | stored response replays | No second payment; validation/performance side effects run again |
| After a firing/performance update | whole graph restarts | Can apply another -10/+1 update for the same procurement outcome |
| During a chain of pre-sign 60s timeouts | no task checkpoint is written for each non-ok result | After 300s another worker can reclaim the still-running task and procure concurrently |
| Refund reserved, before transfer | refund row has no stale reclamation | Stuck `REFUND_IN_FLIGHT` indefinitely |
| Refund broadcast, before DB settlement | same stuck state, transfer fate ambiguous | Not safely retryable; no `signed/unknown` refund state exists |
| Settled refund, before worker checkpoint | response replays | Money-safe |
| Assembly/booking | graph restarts; vendor payments replay | Money-safe, but duplicate progress/performance remains possible |

The code distinguishes vendor-call retry safety well with
`reserved/signed/settled/released` (`packages/procurer/src/db.ts:72-82`). Refunds
have only `reserved/settled/released` and cannot distinguish “never sent” from
“broadcast, result unknown” (`packages/procurer/src/db.ts:316-380`).

### 1.5 Postgres data model

There are six application tables.

| Table | Schema owner | Writers | Readers | Multiple data writers? |
|---|---|---|---|---|
| `firm_quotes` | worker migration and gateway startup DDL (`apps/firm/migrations/003_firm_quotes.sql:1-12`, `apps/firm-gateway/src/db.ts:31-45`) | gateway | gateway | No, but two schema owners |
| `firm_jobs` | worker migration (`apps/firm/migrations/001_init.sql:1-13`) | gateway creates jobs; worker upserts snapshots | gateway, worker, procurer refund policy | **Yes** |
| `firm_job_checkpoints` | worker migration (`apps/firm/migrations/001_init.sql:15-22`) | worker | worker/operator via DB | No |
| `vendor_performance` | worker migration (`apps/firm/migrations/001_init.sql:24-31`) | worker | worker | No |
| `procurer_calls` | procurer runtime DDL (`packages/procurer/src/db.ts:83-125`) | procurer | procurer/operator | No |
| `procurer_refunds` | procurer runtime DDL (`packages/procurer/src/db.ts:95-125`) | procurer | procurer/operator | No |

`firm_jobs` is intentionally shared: the gateway writes the initial queue row and
the worker owns every later state snapshot. The procurer only reads its quote when
authorizing refunds (`packages/procurer/src/db.ts:282-303`).

### 1.6 Trust, selection, hiring, firing

1. `scan.js` queries the live marketplace, paginates and deduplicates raw agent
   records (`tools/vendor-index/scan.js:58-117`).
2. `generate.js` resolves token decimals, converts fees exactly, infers one of two
   capabilities by keywords, derives flags, and emits usable services
   (`tools/vendor-index/generate.js:39-71`,
   `tools/vendor-index/generate.js:240-329`).
3. Current `data/vendor-index.json` contains 15 vendors and 118 services: 117 map
   to `market_snapshot`, one to `token_launch`; only five publish JSON example
   args. The sole `token_launch` entry is Argus's “Multi-Agent Contract Audit,”
   classified by the word `tokenomics`, not a token-launch vendor
   (`data/vendor-index.json:171-193`).
4. Base scores are **not KYA**. They are rounded marketplace `feedbackRate`, behind
   an explicit override and labelled in the output
   (`tools/vendor-index/generate.js:201-214`,
   `data/vendor-index.json:1-18`). The frozen KYA precondition is unmet.
5. `rank_candidates` filters by capability, intersection of vendor flags with
   `banned_categories`, and effective score, then sorts score descending
   (`apps/firm/src/firm/sourcing.py:24-54`). It does not use observed liveness,
   price, latency or marketplace category. `deadline_minutes` is unused.
6. A call success adds +1; validation failure or any non-ok procurer result adds
   -10 (`apps/firm/src/firm/sourcing.py:64-83`,
   `apps/firm/src/firm/graph.py:183-216`). Postgres stores the adjustment in
   [-30,+10].
7. Validation failure creates both a `hires[]` entry and a `vendors_fired[]` entry.
   Transport/payment/cap failures create neither provenance entry; they are only
   counted as timeouts.

Trust provenance is therefore weak but mostly labelled honestly: score origin and
capability inference are visible in the JSON. The untrustworthy part is downstream:
cap/payment/client errors can punish a vendor, concurrent workers can lose updates,
and the semantic validator does not check acceptance criteria.

### 1.7 Dependency map

| From -> to | Protocol | If unavailable |
|---|---|---|
| buyer -> gateway | MCP/JSON-RPC over HTTP | no service |
| gateway -> Postgres | `pg` | startup or request fails; no quote/job/status |
| gateway -> x402 facilitator | HTTP `/verify` | paid calls always return 402 |
| worker -> Postgres | `psycopg` | job remains at last persisted state and may be reclaimed |
| worker -> vendor index | local JSON file | worker fails after claiming; stale retry repeats |
| worker -> procurer | localhost HTTP | unhandled `httpx` exception aborts the graph |
| procurer -> Postgres | `pg` | service startup/spend reservation fails closed |
| procurer -> `onchainos` CLI | subprocess | pre-sign payment failure; worker wrongly penalizes vendor |
| procurer -> vendor | HTTP/x402 | pre-sign failure releases; post-sign failure stays uncertain |
| generator -> marketplace/CLI | `onchainos agent search`, `token info` | scan may be partial; generation may drop unresolved services |
| worker -> Treasury | **no implementation** | no effect; enabled mode still emits `PENDING` |

The Docker image exposes 8790 but the server binds `127.0.0.1`, not `0.0.0.0`
(`apps/firm-gateway/Dockerfile:23-27`, `apps/firm-gateway/src/server.ts:493-501`).
Port publishing will not make that listener reachable outside the container. The
image also contains only the gateway; Express still needs Postgres, the worker and
the procurer deployed separately.

## 2. Review

### 2.1 Correctness findings, ordered by blast radius

#### C0 — Inbound x402 never settles

**Verified.** Successful verification releases `execute`/`express_run`; no code
calls a settle endpoint (`apps/firm-gateway/src/charging.ts:93-137`). The mock test
incorrectly supplies a transaction hash in the `/verify` response and calls it
`0xsettled` (`apps/firm-gateway/src/charging.test.ts:92-105`).

Scenario: buyer replays a valid authorization for a 0.1 USDT Express call. The
facilitator says it is cryptographically valid; the gateway inserts and fulfills a
job; nobody submits the authorization for settlement. Outcome: the buyer receives
the paid service for free and the gateway returns a misleading `PAYMENT-RESPONSE`.

There is a second integration blocker: the code posts unauthenticated JSON to a
root-relative `/verify` (`apps/firm-gateway/src/charging.ts:106-113`), while the
official OKX HTTP API requires authenticated API calls and distinct verify/settle
operations. This has only passed against the local fake facilitator.

#### C0 — “real payments on, real refunds off” records a fake refund

**Verified.** The switches are independent. With `REAL_PAYMENTS_ENABLED=true` and
`REAL_REFUNDS_ENABLED=false`, failed delivery returns `SIMULATED:refund:*`, which
the worker persists before `failed_refunded` (`packages/procurer/src/server.ts:212-215`,
`apps/firm/src/firm/graph.py:281-291`).

Scenario: a real buyer pays 0.1 USDT; every vendor fails. No refund transaction is
broadcast, but `get_result` says `REFUNDED` and exposes the simulated tx. Outcome:
the absolute guarantee and evidence-integrity rule are both violated.

#### C0 — Refunded economics report retained revenue

**Verified.** `build_provenance` always calculates `margin = quoted price - vendor
costs - books`, even when the full user price was refunded
(`apps/firm/src/firm/graph.py:295-334`).

Scenario: user pays 600,000; one vendor costs 300,000; delivery fails; user is
refunded 600,000. The receipt reports 300,000 “retained” instead of 300,000
“absorbed.” Outcome: the receipt's most judge-visible arithmetic is false.

#### C1 — Public deployment scaffold is unreachable and incomplete

**Verified.** The process listens on container loopback. Even after changing the
bind address, the image alone cannot complete Express because it deploys no worker
or procurer. Scenario: OKX calls the published endpoint and gets connection refused,
or Express accepts payment then returns pending forever. This reproduces the class
of listing failure documented for Treasury (`docs/status/F1.md:280-320`).

#### C1 — Missing payer can refund the placeholder address

**Verified.** A facilitator response may be considered valid with no `payer`
(`apps/firm-gateway/src/charging.ts:83-85`, `apps/firm-gateway/src/charging.ts:124-130`).
The job then has no buyer address and falls back to
`SIMULATED:refund-address` (`apps/firm/src/firm/config.py:12-19`,
`apps/firm/src/firm/graph.py:278-284`). A paid call must fail closed unless a valid
refund destination is durably captured.

#### C1 — Stale reclaim can run one job in two workers

**Verified.** Worker staleness defaults to 300 seconds. A non-ok vendor response
updates performance but writes no task checkpoint (`apps/firm/src/firm/graph.py:183-185`).
Five sequential 60-second timeouts can therefore make the task stale while the
first worker is still running. A second worker reclaims it, restarts at planning,
sees the first vendor call in flight, counts another timeout, and advances to other
vendors. Outcome: overlapping hires, extra spend up to the cap, racing final
receipts and repeated performance penalties.

#### C1 — Vendor failures are fabricated from Firm-side errors

**Verified.** Every non-ok procurer result—`CAP_EXCEEDED`, `PAYMENT_FAILED`,
`UNSUPPORTED_CHALLENGE`, `REQUIRES_HUMAN`, or actual timeout—calls
`record_timeout` (`apps/firm/src/firm/graph.py:183-185`). This exact class of false
penalty already occurred in G2 (`docs/status/F1.md:559-585`) but remains in code.

Scenario: Clawby asks 600x its listing price. The procurer correctly refuses before
signing; the worker records a vendor timeout and -10 adjustment even though the
vendor answered and the Firm's own cap made the decision. Outcome: corrupted trust
data and an accidental false accusation.

#### C1 — Live asset/network/scale authorization is not closed

**Verified.** The allow-list is optional, there is no network allow-list, and an
offer without `extra.decimals` proceeds using the caller's scale. Scenario: a
malicious endpoint offers 15 units of an unintended 18-decimal asset on another
network; raw `15 <= 15` passes. Whether the CLI will sign that exact combination is
an external dependency, but the Firm itself has not enforced the user's USDT/X
Layer intent. Require asset, network and decimals in real mode.

#### C1 — Enabling Treasury books invents a cost without making a call

**Verified.** `treasury_books_url` is never read outside configuration. Enabled mode
hard-codes 50,000 and tx `PENDING` (`apps/firm/src/firm/graph.py:316-345`). Scenario:
an operator turns on the documented flag believing it activates integration;
receipts now claim an intra-team expense that never happened.

#### C2 — The validator does not validate the requested outcome

**Verified.** `subtask_spec` is unused. “Semantic sanity” is only a 12-character
floor; URL “liveness” in the default stack is syntax only
(`apps/firm/src/firm/validation.py:90-169`). A long irrelevant dictionary with no
conventional error key passes. This is the central demo/product gap: fallback can
only be as meaningful as the validator that triggers it.

#### C2 — Firm Projects cannot reliably call the current vendor pool

**Verified.** Projects cannot carry params. The default top-ranked market service,
Predexon Market Search, documents a required `q` in prose but has no JSON example,
so the pre-check cannot see it (`data/vendor-index.json:20-44`). The worker sends
`{goal,subtask}` and may pay for a 400. The sole launch candidate is actually a
contract audit. A generic “launch briefing” is therefore not a defensible live
Projects capability today.

#### C2 — Performance updates lose concurrent increments

**Verified.** Each worker loads all rows, increments in memory, then upserts
absolute counters (`apps/firm/src/firm/storage.py:293-377`). Two successes loaded at
zero can both write one; last writer wins. Use atomic SQL increments/adjustment.

#### C2 — Procurer localhost is an unauthenticated spending API

**Verified.** Any local process can submit arbitrary endpoint/task/subtask values to
`/pay-and-call`; existence of a Firm job is not checked
(`packages/procurer/src/server.ts:23-35`, `packages/procurer/src/server.ts:231-259`).
Caps limit damage but do not establish authority. On a shared host or after SSRF,
an attacker can spend the daily cap at its own endpoint.

#### C3 — JavaScript money conversion is not safe for arbitrary base-unit strings

`Number(value.amount)` is used in gateway/procurer money parsing and offer prices
(`apps/firm-gateway/src/money.ts:11-15`, `packages/procurer/src/x402.ts:130-139`).
Above `2^53-1`, integers lose precision. Current caps are far below that, so this is
not a six-day blocker; use `bigint` before broadening token support.

### 2.2 Frozen contract conformance

| Section | Conforms | Deviations | Known? |
|---|---|---|---|
| §1 tools | Five MCP tools exist; free/paid split and quote formula exist | inbound charge not settled; Express retries all candidates, may return `EXPRESS_PENDING`, has no params schema, vendor `name` is always null, `firm_margin` lacks `decimals`; Projects cannot pass params | Params limitation and Express lock known; settlement/schema/receipt gaps not recorded |
| §2 state | enum and principal happy path exist; task/checkpoint rows persist | quoted/paid not checkpointed; fallback never observes validating->procuring; refund path is refunding->refunded->refunding->failed_refunded; restart begins at planning rather than last node | Some stale recovery known; exact deviations not called out |
| §3 receipt | required top-level fields exist; all vendor costs are summed; books is disclosed | refunded margin false; enabled books fabricated; failed-validation hire appears in both hires/fired; procurement failures omitted | hires/books concerns partly known; refunded margin not known |
| §4 index | generated timestamp/provenance, services, prices, flags and score fields exist | feedback substituted for KYA; capability is keyword inference; current output is wrapper object rather than illustrated array; `last_verified_at` is scan time; categories/liveness not used | Score substitution and inference known; current 117/1 split contradicts handoff's 4 launch services |
| §5 procurer | API, pre-pay caps, SQL idempotency and key quarantine exist | real-mode asset allow-list optional; pending settlement may be stored as settled; refunds can be simulated, stranded, or sent from a different wallet; error codes exceed frozen union | Most refund/asset issues known in status, but simulated-refund terminal state is not |
| §6 validation | deterministic pure function and unit tests exist | no acceptance-criteria rubric, no real liveness in flow, schema check is only conventional error detection, timestamps other than top-level `generated_at` ignored | LLM/liveness limits known |
| §7 evals | five test names exist | five are a parallel fixture implementation, not the gateway/worker/procurer; default service tests skip DB; no successful inbound settlement or real-refund test | Status reports “147 green” without separating skips |

### 2.3 Integrity-rule audit

1. **No fabricated results/failures/tx hashes — fails on reachable paths.**
   `CAP_EXCEEDED` and payment/client failures are recorded as vendor timeouts. Enabled
   books claims a cost without a call. Disabled real refunds return a simulated tx
   and the worker records `refunded`. Fixture/demo txs themselves are visibly
   labelled, which is good.
2. **Simulations labelled SIMULATED — mostly conforms.** Simulated vendor, books and
   refund strings are labelled (`packages/procurer/src/server.ts:60-85`,
   `apps/firm/src/firm/graph.py:336-345`). The problem is semantic: a labelled
   simulated refund still drives a production terminal state claiming the guarantee
   was honored.
3. **Treasury payment disclosed and not external revenue — disclosure conforms while
   disabled.** No actual Treasury payment exists. Enabled mode would fabricate the
   cost; keep it impossible to enable until implemented.
4. **No scripted self-purchases — code has no explicit self-purchase script.** The G2
   runbook correctly bypassed inbound charging to avoid wash trading
   (`docs/status/F1.md:519-534`). Fixture demo must remain labelled simulated.
5. **Refund guarantee honored — does not conform.** No live refund has been made;
   wallet identity is unresolved; disabled mode marks fake success; refund crash
   recovery can strand reservations.

The fixture-only demo also has stale arithmetic: it adds books into
`actual_vendor_costs`, then labels a zero overrun as `absorbed`
(`tools/demo/scenario.js:30-79`). This contradicts the current worker receipt and
must not be screen-recorded as product output.

### 2.4 Test quality

Current execution in this review:

- `uv run pytest -q`: 38 passed.
- root `pnpm -r test`: gateway 21 passed/7 skipped; procurer 45 passed/20 skipped;
  firm evals 5 passed/5 skipped; mocks 3 passed; vendor report 2 passed.
- `tools/vendor-index/generate.test.js` is not wired to a package `test` script
  (`tools/vendor-index/package.json:1-8`).

The “147 green” arithmetic in the handoff is 38 + 65 + 28 + 10 + 6, but 32 of
those 65/28/10 are skipped unless DB-specific env vars are set. The truthful default
claim is 115 passing among those named components, plus 32 skipped—not 147 green.

Quality of the five golden evals:

- **Quote honored is vacuous for charging.** `charged` and receipt quote are assigned
  from the same local constant, then compared (`tests/firm-evals/evals.test.js:16-19`,
  `tests/firm-evals/evals.test.js:153-160`). No gateway or payment runs.
- **Fallback tests a second implementation.** `runFixtureProject` implements its own
  candidate loop, validator and performance map (`tests/firm-evals/evals.test.js:16-150`).
  It can pass while the Python worker is broken.
- **Refund test does not test a refund.** It checks a generated `SIMULATED:` prefix
  and actually asserts the full charge existed; it never checks settlement or net
  retention (`tests/firm-evals/evals.test.js:174-181`).
- **Provenance completeness validates an object it just constructed.** It checks
  field presence, not worker output (`tests/firm-evals/evals.test.js:183-191`).
- **Budget safety tests local arithmetic, not SQL reservation/interleaving.** The
  meaningful concurrent-cap tests are in `reservation.test.ts`, but are skipped by
  default (`packages/procurer/src/reservation.test.ts:181-225`).

The package-level procurer tests are generally strong: they assert ordering around
signing, real SQL concurrency and idempotent replay, and the status log records a
negative control with the lock removed (`docs/status/F1.md:116-122`). The biggest
holes are the seller's successful settle path, real refund, crash boundaries,
worker error classification and a true gateway->worker->x402 mock-vendor run.

### 2.5 Load and adversity

- **Concurrent jobs:** spend reservation is serialized correctly, but performance
  counters lose updates and stale job reclaim can overlap workers.
- **Slow/dead vendors:** a pre-sign timeout releases money safely; repeated timeouts
  do not heartbeat the job and can trigger concurrent reclaim.
- **Price changes:** if live 402 price exceeds the indexed ceiling, signing is
  refused—good. If lower, actual amount replaces the reservation—good. The worker
  wrongly penalizes the vendor for the refusal.
- **Partition before signing:** safe release/retry.
- **Partition after signing:** procurer preserves an uncertain signed row—good—but
  worker immediately tries another vendor and does not surface human reconciliation.
- **Malicious vendor:** caps constrain amount, but asset/network allow-lists are not
  mandatory, endpoint is not allow-listed at the procurer boundary, and arbitrary
  long irrelevant JSON can pass validation.
- **Refund partition:** no signed/unknown state or stale-safe recovery; automatic
  guarantee can block forever.
- **Gateway/facilitator partition:** returns 402 and writes no job—safe. There is no
  successful-settlement crash protocol because settlement is absent.

### 2.6 Demo versus product, and what the two payments prove

Both published hashes were independently queried from the X Layer RPC during this
review. Each receipt has status `0x1` and a token `Transfer` log of `0x0f` (15 base
units) from `0xc029...50e0` to `0xa7e3...987`. The repository records the same facts:

- G1: `0x493a...6072`, isolated procurer payment
  (`docs/status/F1.md:427-463`).
- G2: `0x2672...eb9`, one controlled worker run through OKLink
  (`docs/status/F1.md:542-553`).

They prove:

- the local-key signer can produce an accepted `exact/eip3009` authorization;
- the outbound vendor replay can settle 15 base units on X Layer;
- the procurer stores/replays a receipt without paying the same idempotency key
  twice;
- one single-subtask worker run, against a controlled one-vendor index and supplied
  OKLink params, reached `complete` and generated provenance.

They do **not** prove:

- any external buyer paid The Firm;
- gateway seller settlement, public HTTPS/MCP deployment or listing readiness;
- a real refund;
- a genuine validation failure/firing/fallback;
- multi-vendor or multi-subtask live execution;
- live Treasury books;
- KYA scoring;
- the full/default vendor index can be called safely;
- that the returned data was semantically correct merely because the transfer
  settled.

The polished firing demo is fixture-only (`tools/demo/scenario.js:178-203`). The G2
successful run had no firing. Its earlier rejection of correct OKLink data was a
Firm validator bug, not a genuine vendor failure (`docs/status/F1.md:559-600`) and
must never be presented as Darwinian fallback evidence.

## 3. Six-day action ranking

Ranking uses judging impact divided by implementation cost; estimates assume one
payments/infra owner and one AI-core owner.

### Must fix before submission

| Priority | Change | Size |
|---|---|---|
| 1 | Replace the custom seller gate with the official OKX seller SDK, or implement authenticated verify **and settle** plus durable inbound idempotency. Require payer, successful settlement and exact amount/asset/network before inserting a job. Add a successful paid integration test. | 1-2 days |
| 2 | Make the public deployment real: bind configurable `HOST=0.0.0.0`, deploy gateway + worker + procurer + Postgres, run OKX's `x402-check`, then submit the service. | 0.5-1 day excluding platform setup |
| 3 | Close refunds before accepting real inbound money: same-wallet local token transfer or an explicitly funded designated refund wallet; real/simulated refund ledgers; no terminal refunded state for simulated/error responses; add `reserved/signed-or-broadcast/settled` recovery. Human-run one tiny real refund. | 1-2 days |
| 4 | Fix refunded economics: net user revenue is zero after full refund, so margin is `-(vendor costs + real books cost)`. Add a failed-after-paid-vendor test. | 1-2 hours |
| 5 | Split procurer failures by cause. Only genuine vendor transport timeout should affect `timeouts`; cap, Firm config, signer and unknown-settlement errors must be recorded as Firm-side events and surfaced in provenance without accusing the vendor. | 0.5 day |
| 6 | Turn the five golden evals into production-path tests. At minimum: fake facilitator verify+settle -> real gateway -> real worker -> real procurer -> x402 mock vendor -> receipt; and an equally real refund path. Make DB tests part of the gate, not skipped green. | 1 day |
| 7 | Lock Express to at most three attempts, a curated service/endpoint/params schema, mandatory asset/network/decimals allow-lists, and a deterministic job-specific validator. | 0.5-1 day |
| 8 | Fix demo receipt arithmetic and ensure every fixture screen says SIMULATED. Never use the earlier OKLink false rejection as the firing clip. | 1-2 hours |

### Worth fixing if time allows

- Add a durable worker lease/heartbeat or a per-task advisory lock so stale reclaim
  cannot overlap an active worker; make performance increments atomic. Medium.
- Persist graph-side attempt records (`rejected/fired/hires/subtask results`) so
  restart resumes/reconstructs without reapplying side effects. Medium-large.
- Add procurer authorization (shared secret or Unix socket) and validate that task,
  subtask, endpoint and ceiling match `firm_jobs`/the selected vendor. Medium.
- Use service-level endpoints explicitly in the worker model. Small.
- Use `bigint` for all base-unit arithmetic. Small-medium.
- Check money token/decimals consistently at quote and refund boundaries. Small.
- Checkpoint `paid`, make fallback transitions match the frozen state machine, and
  remove the `refunded -> refunding` regression. Small.

### Disclose rather than fix in six days

- Firm Projects cannot carry vendor params and should be presented as limited to
  curated parameterless services until the frozen schema is deliberately revised.
- KYA is absent; base scores are labelled marketplace feedback substitutions.
- Current capabilities are keyword categories, not verified skill contracts. The
  only generated launch candidate is not a launcher.
- Semantic validation is deterministic and job-specific only where you actually
  implement a schema; there is no LLM acceptance rubric or default URL reachability.
- Live proof is one vendor, one capability, two 15-unit outbound transfers, no
  real fallback and no real Treasury books.
- Treasury is not currently a callable books dependency; keep the receipt line at
  zero and explicitly simulated/disabled.

### Explicitly do not do

- Do not enable `ENABLE_TREASURY_BOOKS`; it does not make a call.
- Do not ship `CHARGING_MODE=bypass`, an empty asset allow-list, or real payments
  with real refunds disabled.
- Do not call the full vendor index merely to manufacture volume/failures. Most
  services publish no machine-readable args, and the current mapping is broad.
- Do not present fixture firing, the validator-caused OKLink rejection, `PENDING`,
  `NONE`, or `SIMULATED:` references as real vendor/payment evidence.
- Do not claim “147 green,” “automatic live refunds,” “KYA-scored vendors,” “live
  Treasury books,” or “full end-to-end payments” in judging copy.
- Do not add a dashboard, second Express type, Task Hall, or generalized LLM
  orchestration before the money/refund/test gates above.
- Do not touch Treasury without Poulav's explicit written go.

## Bottom line for judges

The defensible story today is: “We proved an outbound x402 buyer with durable spend
reservation and idempotent receipt replay against a genuine third-party vendor, and
we learned that marketplace prices/endpoints/schemas cannot be trusted blindly.”
That is real and technically interesting.

The not-yet-defensible story is: “A buyer can pay the live Firm, receive guaranteed
validated fallback, and automatically get a truthful refund.” Inbound settlement,
real refund, semantic acceptance and genuine fallback proof must be closed—or
disclosed as limitations—before making that claim.
