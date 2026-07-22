# Handoff to Ishita — 2026-07-21

> **NEWER HANDOFF BELOW — see "Handoff to Ishita — 2026-07-22" at the end of
> this file. It is time-critical and supersedes the ACTION items here. Do the
> 07-22 items first.**

From: Poulav (F1/F2 lanes, via Claude Code)
Branch: `f1/x402-live-money`, 30 commits, all pushed, tree clean.
Tests: 147 green — 38 pytest, 65 procurer, 28 gateway, 10 firm-evals, 6 vendor-index.

Read the three ACTION items first; everything else is context.

---

## ACTION 1 — the listing is yours, and I changed my mind about how to file it

The Firm ASP is registered under **your** wallet (`ishita02.b@gmail.com`). Poulav's
account holds only Treasury (5863), so **only you can submit the service form.**
This is the invalidating item: unlisted means the entry does not count.

**The recommendation changed today, based on Treasury's rejection emails.**

The original plan was to list as `agent to agent` because it needs no deployed
endpoint. That is still true, but it trades a deployment problem for a *liveness*
problem — and liveness is what has now failed twice:

| | A2A ("agent to agent") | A2MCP ("API service") |
|---|---|---|
| needs a public HTTPS deploy | no | **yes** |
| needs a live session answering during review | **yes** | no |
| can be validated BEFORE submitting | no | **yes** |

That last row decides it. **OKX ships the validator they review with:**

```bash
onchainos agent x402-check --endpoint <url> --body '{...}'
```

The gateway already passes the MCP handshake and returns a correct HTTP 402 — I
verified both this session. It only does so on `127.0.0.1`. Deploy it publicly,
run OKX's own validator until it passes, *then* submit. Against a 5+ day queue
and two identical rejections, deterministic beats convenient.

**If there is no time to deploy**, `agent to agent` is still viable, but someone
must be watching for OKX's test message during review and responding
(`onchainos agent pending-decisions-v2`, `onchainos agent active-tasks`).
Treasury failed on exactly this.

**Whichever type you choose, register the service.** Treasury's `serviceList` is
literally `[]` — see ACTION 3.

Listing values, locked today:
- Service: **Firm Express**
- Job type: **`market_snapshot`** (one type — 117 of 118 indexed services map to
  it; `token_launch` has only 4. INTERFACES §1A allows 1–2)
- Fee: **0.1 USDT** (was 0.5 in the draft — reasoning in ACTION 2)

## ACTION 2 — sanity-check the Express price, because I lowered it

I dropped Express from 0.5 to 0.1 USDT. You should agree or overrule, because it
is a positioning call about how our margin reads to a judge.

Median vendor cost for `market_snapshot` is ~10,000 base units (0.01 USDT). At
0.1 that is a ~10x premium for a validated, guaranteed, provenance-backed result
instead of a raw API call. At 0.5 it is ~50x, which invites arithmetic the
"margin is not markup" claim in our README does not survive.

> **SUPERSEDED 2026-07-23 — the reasoning above was wrong on the facts.** It
> assumed ~10,000 base units of vendor cost. The vendor we actually hire, OKLink
> #2023, charges **15 units** — below the 25th percentile of the whole market —
> so the real ratio is ~6,700x for Express, not 10x, and the "~10x premium"
> line must not be repeated anywhere.
>
> The price itself is fine and the justification changes rather than the number.
> Across the 129 prices in our own scan: p25 10,000, **median 100,000**, p75
> 300,000, max 6,600,000. **Express at 0.1 USDT is exactly the median, and
> Projects at 1 USDT is a price point eight other listed services already
> charge.** We price at market. The large ratio reflects how unusually cheap
> OKLink is, not how expensive we are. Full reasoning in the README.

**Related correction you should know about**, because it changes the numbers:
`build_provenance` was subtracting a flat 50,000-unit Treasury books cost from
our margin *whether or not the books call happened* — and it never happens, since
Treasury is not listed. The G2 receipt claimed margin 49,985 when we had actually
retained 99,985. We were understating our own margin against a cost we never
incurred. Fixed: the books line is disclosed either way but only counts as a cost
when `ENABLE_TREASURY_BOOKS` is on.

## ACTION 3 — Treasury is fixable, and it is now fully diagnosed

Treasury was rejected **twice with identical reasons** (Jul 17 and Jul 19), which
means the Jul 19 resubmission changed nothing. Root cause, verified against the
marketplace API rather than guessed:

- **`serviceList: []`** — Treasury has zero services registered. That alone
  explains reason 1 ("unable to reach your Agent's service endpoint") and reason
  2 ("has not passed x402 standard validation") — there is nothing to reach and
  nothing to validate.
- **`gate-check --role ASP` returns `ready: true`** — wallet, identity and the
  A2A communication channel are all fine. So reason 3 ("unable to receive a
  response... task timed out") is not a broken channel. It is that nothing was
  *answering* it.

Fixing Treasury would make The Firm's provenance `books` line **real instead of
SIMULATED**, which materially strengthens the receipt. The gateway's
seller-side charging code is the obvious transplant for reason 2.

**This needs Poulav's explicit written go — `apps/treasury` is untouchable by
rule and nobody has touched it.**

---

## What landed since your handoff

### Both gates passed, with on-chain evidence

| gate | what | tx |
|---|---|---|
| **G1** | procurer in isolation | `0x493a34a5b33dc8c17760a81d4b028f298ccb9264d19dd1032e9549b182f26072` |
| **G2** | full graph → live vendor → provenance receipt | `0x2672820a7d1429a7a84c03f330d89b64bf3701e090aab9bb4ee83a08bbec7eb9` |

Both on X Layer to OKLink Onchain Data Explorer #2023, 15 base units each
(0.000015 USD₮0). Payer wallet `0xc0296012cfbb0e6df5da7158b65dbc46dd9650e0`.

Idempotency was proven under a *real* retry, not a staged one: three worker runs
produced two payments. The re-run returned the recorded receipt instead of paying
again, which is why the final provenance carries the tx from the original call.

### Four bugs found by running it for real

These are the ones worth your attention as the owner of the AI core.

**1. The validator would have fired every real vendor.** G2's first attempt paid
OKLink, got a correct response, and *rejected it* — because `validate()` asserted
the key names our own mock fixtures emit (`observations`/`checklist`/`sections`
plus a mandatory `generated_at`). No real marketplace vendor uses those.

This was worse than an economic bug. The Darwinian layer is meant to manufacture
vendor intelligence; instead it manufactured a false accusation — recorded
against a real agent with 1,572 completed sales at adjustment −30 (the floor),
and written into a provenance receipt as
`"reason": "validation failed: schema, freshness, semantic_sanity"`. Putting that
on camera would have been showing judges a fabricated vendor failure.

Fixed to what INTERFACES §6 actually specifies: no assertion of anyone's success
schema, a real check that the vendor did not report its *own* error, content must
exist (status keys excluded so a bare `code: "0"` cannot pass on its own
metadata), and freshness **only where a timestamp exists**. Our fixture shape
still passes unchanged. The false performance row and the fabricated receipt were
deleted; **the payment rows were deliberately left untouched** because that is
real money and must stay auditable.

**2. Simulated spend shared a ledger with real money.** A day of evals could
exhaust the real daily cap and block a live payment — which is exactly what
happened, and it is how the bug was found. `/caps` also reported simulated spend
as real. Now split by `mode`, with history backfilled from the recorded receipts.

**3. Provenance economics double-counted.** `actual_vendor_costs` included the
books cost, which has its own disclosed block — so anyone adding the published
numbers up counted it twice. Now `user_price = actual_vendor_costs + books +
margin` reconciles exactly.

**4. `reserveCall` had two sources of truth** for the reservation amount: cap
arithmetic used a number, the row persisted an object, nothing enforced they
agreed. A caller passing ceiling 0 with units 50,000 cleared every cap and
reserved nothing. Now derived from one source, so the misuse is not expressible.

### Vendor reliability testing (PLAN D4) — done, and it found something

Probed the 10 cheapest `market_snapshot` agents with **unpaid** requests and read
their 402s. Zero cost — nothing was signed. Full data in
`data/vendor-reliability-2026-07-21.json`.

- **6 of 10** reachable and x402-conformant
- **4 of 10** dead or misrouted (2 unreachable, 2 return 404 at their listed endpoint)
- **2 of 6** working vendors misprice against their listing

**Clawby #3209 is listed at 0.005 USDT and its live 402 demands 3 USDT — 600x.**

An agent that trusts listings and pays whatever the challenge asks would have
paid 600x its expected cost on one call. The Firm verifies the challenge amount
against `max_amount` and the per-call cap *before signing*, so it is refused.
That is the best real-world justification our spend caps have, and it is a live
vendor on the marketplace today.

**Suggested demo beat:** attempt to hire Clawby at its listed price and let the
cap refuse it on camera. Real vendor, real 600x overcharge, no money moved.
(Needs a procurer with `PER_CALL_MAX` above 5,000 to reach the amount check.)

### Demo pool locked from observed reliability

`data/vendor-index.demo.json` — 5 vendors that are reachable, conformant, and
priced at or below their listing. **Prices are taken from each vendor's live 402,
not from its listing**, because two listings were wrong. Ranks 5 candidates, so a
genuine fire-and-rehire chain is possible on camera.

---

## Changes in YOUR lane (apps/firm) — please review

Poulav waived the lane boundary for these because G2 was blocked on them and
submission was imminent. Nothing else in `apps/firm` was touched.

| file | change | why |
|---|---|---|
| `models.py` | `FirmTask.params`; `VendorService.documented_example_args` | the worker sent `{goal, subtask}` to every vendor; real vendors have real schemas |
| `migrations/004_job_params.sql` | new `firm_jobs.params` column | as above |
| `storage.py` | params plumbed through save/get/both claim queries | as above |
| `graph.py` | `_vendor_args`; `missing_documented_params`; books-cost and economics fixes | see bugs 1, 3 above |
| `validation.py` | shape-agnostic rewrite | see bug 1 above |
| `tests/` | 9 new validation tests, params tests, economics reconciliation | pins all of it |

**Deliberately NOT done:** no params on `execute`. INTERFACES §1B defines it as
`{quote_id}` only, and widening a frozen contract needs both of you. Firm
Projects therefore still cannot drive a schema-bearing vendor — a real
limitation, recorded rather than patched around. Express carries params
contractually (§1A), which is why G2 went through Express.

Also **not** done: no `FirmTask.constraints`. I started to add one, then found
constraints already ride on `quote.constraints` and are read there by
`sourcing_node`. Two sources of truth for a buyer's filters would be a bug
generator, so I reverted it.

---

## Still open

**Needs a human decision:**
1. Listing type and submission — **yours** (ACTION 1)
2. Express price sanity-check — yours (ACTION 2)
3. Treasury fix — needs Poulav's written go (ACTION 3)
4. Refund wallet: the payer `0xc029…` is **not** the CLI-logged-in account, so
   `onchainos wallet send` would refund from a different wallet than the one that
   paid. Options: fund the CLI account and accept the split (no code), or add a
   local transfer signer to the procurer (a web3 dependency + verified RPC).
   `REAL_REFUNDS_ENABLED` stays off until chosen.

**Not started, and the largest remaining deliverable:**
5. **The demo video.** `tools/demo/scenario.js` prints a run; there is no
   recording. PLAN D8 wants the fixed quote, an on-camera trust rejection, real
   OKLink transactions, a firing, and the provenance receipt.
6. **Volume runs** — genuine usage, and the fishing expedition for a real
   on-camera vendor failure. The demo pool costs 0.000015–0.02 USDT per call, so
   a hundred runs is pennies.
7. **Live refund test** — checklist item, blocked on 4.
8. **X threads** — the product thread, and a "State of the Agent Economy" data
   thread that now writes itself (600x mispricing, 40% dead endpoints, 118
   services mapped).
9. **The hackathon Google form** — separate from the OKX listing. Both are due.

**Known limitations, honestly:**
- Firm Projects cannot drive schema-bearing vendors (see above)
- The books line is SIMULATED until Treasury is fixed
- `token_launch` has only 4 candidate vendors — thin
- The LLM semantic rubric in INTERFACES §6 is a deterministic floor only
- `check_liveness()` exists but is not wired into the flow
- Multi-subtask jobs work in code but have never run against real vendors

---
---

# Handoff to Ishita — 2026-07-22

From: Poulav (F1, via Claude Code). Repo at `fa0e702`, pushed to `main`.
Suites green: 88 pytest, 78 gateway, 121 procurer, ruff clean.

**Everything below needs your account.** Poulav's CLI login
(`bpoulav@gmail.com`) is bound to agent **5863 Treasury Copilot** — confirmed
today by `onchainos agent gate-check`, and `task-in-progress --agent-ids 7138`
answers `agent is not bound to the current user`. Nothing on `#7138` can be done
from his side. That is correct access control, not a problem to route around.

## Why this is urgent, stated plainly

**A purchase against production right now reproduces David's round-2 rejection.**

All three services are behind `main`:

| service | deployed | current code | |
|---|---|---|---|
| procurer | 07:18Z | `6adac1b` 14:21Z | stale |
| gateway | 10:28Z | `9fd2d24` 14:49Z | stale |
| worker | 11:59Z | `9fd2d24` 14:49Z | stale |

The deployed worker predates both the relevance validator (`2dfe852`) and the
change that makes Express buy its data from OKLink (`6adac1b`). So an ETH
request is still answered with BTC-ETF data — and without the relevance check it
*passes* validation, so no refund fires either. Wrong answer, money kept. That is
worse than failing.

Confirmed today, not assumed: the deployed procurer's `/health` has no
`refund_ready` field at all.

## ACTION 1 — unlist **Firm Express** for the deploy window

Before Poulav deploys, not after. The three services are mutually incompatible
while the deployment runs, and Express is the only thing anyone can buy.

**Corrected — this is weaker protection than first written.** OKX's own guidance
says a registered agent "is callable, it just won't appear in public discovery
until listed." So unlisting removes Express from *discovery*, not from the
network: `firm-gateway.fly.dev` stays live, and anyone holding the URL — David
included — can still call it. Do it anyway, because it stops new buyers finding
us mid-window, but do not treat it as a safety gate. The actual protection is
that the window is short and correctly ordered.

The same fact helps later: because a registered agent is callable before it is
listed, the full purchase test does **not** need public discovery. Testing does
not have to wait on re-listing.

Poulav cannot do this — it is your listing.

## ACTION 2 — drop **Firm Projects** from `#7138`

Permanently, not for the window. The listing should offer only what a reviewer
can actually buy end to end today. Firm Projects is the free-quote-then-execute
flow; it is not the thing that has been proven on real money, and leaving it
listed invites a reviewer to test the path we are least able to defend.

Express is the entry's demonstrable product: fixed 0.1 USDT, buys its price
series from OKLink #2023 at 15 base units, returns the analysis, refunds
automatically when it cannot deliver.

## ACTION 3 — reconcile the stuck `accepted` task

**Do not simply close it.** It is an unresolved financial record: settle the
payment or refund it, then close. Closing an open money state without resolving
it is exactly the thing this entry claims not to do, and it would be visible to
anyone auditing the task history.

If it needs a refund and you cannot trigger one from your side, say so and
Poulav will run it through the procurer.

## ACTION 4 — re-list Express, then request the re-test

Only after Poulav confirms all three deployed and verified:

- procurer `/health` reports `refund_ready: true` with gas headroom
- GET and the documented flat POST both return 402
- `x402-check` returns `valid: true`
- one live ETH/4h purchase returns a relevant answer whose receipt names
  OKLink #2023 at 15 units

Then ask David to re-test. Not before — a third rejection on a finding we
already fixed but had not shipped would be the worst available outcome.

**Run this immediately before you message him**, not the day before:

```bash
node tools/review/preflight.mjs
```

It checks the whole path a reviewer touches — endpoint up, GET and POST both
pricing, the challenge well-formed, refund gas, daily cap, worker alive, and
whether OKLink is live. It prints `READY` or `NOT READY`. If it says NOT READY,
do not send the message.

Two things drift on their own and both take the endpoint down or turn a sale
into a refund: native gas on `0xC029…50e0` draining, and OKLink going offline.
That is why the check belongs next to the message, not ahead of it.

**Do not deploy anything while David is testing.** A rolling restart mid-purchase
is the one way to turn a working path into "took my money, returned nothing".

Afterwards, capture his purchase:

```bash
node tools/review/preflight.mjs --inbound
```

Any payer that is not our QA wallet is flagged `*** EXTERNAL BUYER ***`. That
transaction is the first genuine external sale this entry has ever had — save
the tx hash, the receipt and the job record.

## One thing that may change the listing — wait for Poulav

A private key for the Firm wallet `0xC029…50e0` was exposed, and rotating it is
under consideration. **`payTo` in every 402 challenge is that address**, so
rotation changes what the listing advertises. Do not submit or update listing
copy containing the payment address until Poulav confirms the decision. Actions
1–3 above are unaffected and should proceed now.

## What Poulav still owes you

- The three deploys, in order procurer -> worker -> gateway (blocked on Action 1
  and the rotation decision).
- The buyer wallet funded from an independent wallet — not the Firm's own, which
  would make the purchase circular and inadmissible as evidence of a sale.
- The live-purchase verification listed in Action 4.
