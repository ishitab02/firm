# Prompt for Grok — score and judge The Firm

**Regenerated 2026-07-22, after a full day of change.** The previous version of
this prompt described the entry as "not listed on the marketplace, has not been
submitted". That was already stale when it was judged, and the resulting verdict
("does not place") rested on a fact that had changed. Do not reuse an older
version of this file.

Everything in the "Verified state" section below is checkable. Where something
is unproven it says so; take those disclaimers as seriously as the claims.

---

Copy everything below the line.

---

You are judging a hackathon entry. Score it, tally the scores, and give a
verdict. Be blunt and quantitative. Do not soften.

## The competition

**OKX.AI Genesis Hackathon.** Deadline **2026-07-27 23:59 UTC**, confirmed firm
by the organiser — no extension. Today is 2026-07-22.

OKX built an agent marketplace: AI agents register as service providers (ASPs),
list services at a price, and get paid per call via the x402 protocol on X Layer.
Agents can hire other agents. OKX's founder frames the thesis publicly as
"one-person companies running agent workforces".

Entries are listed agents on that marketplace. **An unapproved listing does not
count.** Listing review is multi-stage — automated quality review, then a
marketplace flow test in which a reviewer actually buys the service and expects
a deliverable, then human review. It has rejected teams repeatedly, including
this one.

## The entry

**The Firm** — "an autonomous prime contractor". Pitch: the marketplace has
60+ worker agents and no employer; The Firm is the employer.

A buyer gives it a goal and a budget. It quotes a fixed price, hires specialist
agents, background-checks them before paying, validates their work after, fires
and replaces failures, and returns one deliverable with a costed paper trail. If
it cannot deliver, it refunds.

Claimed differentiators:
1. **Fixed quote, guarantee premium.** The Firm bears execution risk; overruns
   come out of its margin, not the buyer's price. Total failure = full refund.
2. **Adaptive fallback on measured evidence.** Failures downgrade a vendor and
   the next candidate is hired automatically.
3. **Two price shapes.** Firm Express (fixed, cheap, single vendor, instant) and
   Firm Projects (free quote, then execution at the quoted price).

## Verified state as of 2026-07-22

Established facts. Do not re-litigate whether they are true; judge what they are
worth.

**Listing**
- Agent **#7138 "Firm"**, role ASP, status **"Listing under review"**. Not yet
  approved.
- **It was rejected once, today.** The reviewer's findings: `GET` returned 405,
  a POST of the body the listing documents returned 200, no 402 challenge was
  ever issued, no USDT entry appeared in an accepts array, and a paid replay
  returned no content. The task he opened remained stuck in "accepted".
- Every one of those findings has since been fixed and redeployed. OKX's own
  `x402-check` now returns `valid: true` against the endpoint for **both** the
  documented flat body and the wrapped MCP body. A re-test has been requested
  but **has not happened**.
- Two services are registered. **Firm Express** (0.1 USDT) passes. **Firm
  Projects** (1 USDT) still fails `x402-check` — it returns HTTP 200 and no 402,
  because its documented input maps to a free quote call. It is being removed.

**Live infrastructure**
- `https://firm-gateway.fly.dev`, always-on, Fly (Singapore) + Neon Postgres.
- Four components: gateway (public), procurer (no public IP, bearer token over
  the private network only), worker, Postgres.

**Money that has actually moved, all verified on X Layer**
- **Outbound, three payments** to a genuine third-party marketplace agent
  (OKLink #2023). The third is the significant one: it was made by the
  *deployed* procurer signing in-process, on a machine that cannot run the OKX
  CLI at all. Before that, real payments only worked from a developer laptop.
- **Inbound, three settled customer payments.** One completed and returned a
  deliverable (real BTC-ETF market data, inline, ~12s). Two failed to deliver
  and **refunded automatically, on-chain, with no human involved**.
- **Two automatic refunds executed.** In one, The Firm hired five vendors, paid
  one, could not deliver, refunded the buyer in full and absorbed the vendor
  cost out of its own margin. Nobody triggered it.
- Provenance reconciles against chain state: user price 100000, vendor cost
  1000, margin retained 99000.

**CRITICAL DISCLOSURE, weigh it fully:** every inbound purchase was made by the
team from its own wallet, as QA. **There are zero external customers.** The team
labels these as QA everywhere and never counts them as revenue, demand or
traction. Judge them as evidence the machine works, not as commercial validation.

**Engineering**
- ~260 automated tests: 121 procurer (plus 20 concurrency tests against a real
  Postgres), 65 gateway, 53 Python.
- Spend caps (per-call, per-task, daily) enforced before any signature, backed
  by Postgres advisory locks.
- Payment idempotency is enforced *by the token contract*, not just by the
  database: the EIP-3009 nonce is derived from the idempotency key, so a
  re-signed subtask reproduces the same authorization and the chain rejects the
  duplicate.
- The EIP-712 domain is proven at runtime against the token's own
  `DOMAIN_SEPARATOR()` rather than assumed.

**Original research**
- Unpaid 402 probes of all 95 endpoint-bearing agents on the marketplace (of 218
  total): **41 dead or misrouted (43%)**, 5 charging above their listing —
  including one listing at 0.005 USDT whose live challenge demands 3 USDT (600x)
  — and 7 serving free despite advertising a price. Nothing was signed or spent.
- The dataset then predicted the team's own first production run: the first
  three vendors it hired were agents the scan had already recorded as dead.

**Bugs found and fixed in the last 24 hours** (judge what this says about
maturity, in either direction)
- The gateway had never been able to verify an inbound payment: it sent the
  payment as a base64 header string where OKX's facilitator requires a decoded
  object, and read the validity flag at the wrong nesting level. Every inbound
  payment ever received had been rejected, and the failure was indistinguishable
  from a buyer sending a bad signature.
- Vendor ranking used marketplace reputation with no liveness signal, so the
  system hired endpoints its own scan had recorded as dead.
- The output validator rejected a live vendor's genuine data because its success
  code was unfamiliar, firing a vendor that had delivered and recording a
  failure against it.

**Not done**
- **The listing is not approved.** One rejection already; re-test not yet run.
- **No demo video.** A storyboard exists.
- **Zero external customers.** No evidence of demand.
- The full "learning" loop is not demonstrated: a vendor's accumulated score has
  never been shown demoting it on a later job in a way that improved the outcome.
  The team explicitly declines to call this "Darwinian" for that reason.
- Multi-subtask jobs work in code, never run against real vendors.
- The team's other product (Treasury Copilot) is unlisted, so the "books" line
  in every receipt is SIMULATED.
- Only one marketplace vendor publishes a machine-readable request schema, which
  narrows what The Firm can safely buy.
- The research is written but not published.

## What to produce

**1. Score each criterion out of 10, with one sentence of justification.**
Use OKX.AI Genesis's published criteria if you know them; if you do not, say so
explicitly and use these, which are ours and not authoritative:

| criterion | weight |
|---|---|
| Working product on the marketplace (listed, approved, purchasable) | 25% |
| Technical depth and correctness | 20% |
| Originality of the idea and defensibility of the position | 20% |
| Evidence quality — are claims backed by verifiable artifacts | 15% |
| Completeness and user value | 10% |
| Presentation and narrative | 10% |

**2. Tally it.** Weighted total out of 100. Show the arithmetic.

**3. Place it.** Where does this land in a field of ~50–100 entries — top 3,
top 10, top 25, or nowhere? Commit to a band.

**4. Name the single thing most likely to sink it**, and say what the correct
triage is for the remaining five days.

**5. Argue the strongest case AGAINST the thesis.** The team's own data says a
direct buyer faces a 43% dead rate and 600x mispricing. Does that justify a
permanent intermediary, or does it just mean the marketplace is early and OKX
will fix it themselves — wiping out the premise? Is an orchestrator a business
or a stopgap?

**6. Judge the integrity posture, honestly.** This team refuses to fabricate
transaction hashes, labels simulations, discloses that all its purchases are its
own, and publicly documents bugs that were serving paid work incorrectly. Does
that discipline read as credibility to a judge, or as expensive self-limitation
next to competitors demoing something shinier? Answer honestly, including if the
answer is that nobody will look.

**7. Name what to cut.** Be specific and be willing to say "the thing you are
proudest of does not matter".

Lead with the verdict and the one thing that decides it. Then the scores, the
tally, and the five-day plan. If your honest read is that this cannot place
because of the listing timeline, say so plainly and say what to salvage instead.
