# The Firm

**An autonomous prime contractor on OKX.AI.** You give it a goal and a budget. It quotes a fixed price, hires specialist agents from the marketplace, background-checks them before paying, validates their work after, fires and replaces the ones that fail, and returns one finished deliverable with a complete costed paper trail. If it cannot deliver, it refunds you.

Entry owner: **Ishita** (her hackathon submission, her AI core). Payments and infrastructure: **Poulav**. Deadline: **July 27, 23:59 UTC**.

## The one-line pitch

OKX's founder says the future is one-person companies running agent workforces. The marketplace has 60+ workers and no employer. The Firm is the employer.

## Status, stated plainly

Live at **https://firm-gateway.fly.dev** — `onchainos agent x402-check` returns
`valid: true` against it.

**Two real third-party procurement transactions. Zero customer revenue so far.**

Those two payments are real money to a real marketplace agent on X Layer, and
they prove the buyer path works end to end. They are outbound *costs*, not
revenue, and nobody has yet bought anything from The Firm. Anywhere those
numbers appear, they appear with that sentence attached.

| proven | not yet proven |
|---|---|
| Public endpoint passes OKX's own x402 validator | A customer can successfully pay |
| The Firm pays real third-party agents; idempotency holds under retry | Demand, or sustainable unit economics |
| Facilitator auth works; a forged payment is rejected by OKX | A valid authorization settling end to end |
| 95 agents probed: a measurable reliability problem exists | Long-term moat, or outcome quality at scale |

## Why this version wins (the three upgrades over a generic orchestrator)

1. **Fixed quote, guarantee premium.** The Firm quotes a fixed price up front and bears execution risk. When a hired agent fails and a replacement is hired, the overrun comes out of The Firm's margin, not the user's price. The margin is not markup: it buys vetting, validation, retries, and a guaranteed outcome. Total failure = full refund.
2. **Adaptive fallback, on measured evidence.** The Firm does not trust its hires. It background-checks every candidate before paying — a free 402 probe that reads what the vendor will *actually* charge, not what it advertises. Deliverables then pass a validation stack; failures are recorded, the vendor's score drops, and the next candidate is hired automatically. The user never sees the hiccup.

   This is deliberately **not** claimed as "Darwinian learning". The full loop — a vendor ranks high, fails a paid job, drops, and ranks lower on a later job that then performs better — has not yet been demonstrated across enough real outcomes to assert. What exists today is preflight intelligence over 95 probed agents plus accumulated performance evidence, which is a smaller and true claim.
3. **Two services, two price shapes.** "Firm Express": one fixed cheap price for single-vendor jobs, instant, repeatable (the Revenue Rocket hero). "Firm Projects": free quote, then execution at the quoted price (the flagship demo).

## Architecture

```
                caller (human or agent)
                        |
              apps/firm-gateway  (TypeScript, Poulav)
              MCP tools + inbound x402 charging
              (reuses Treasury's hardened server pattern)
                        |
                 Postgres job queue + state
                        |
              apps/firm  (Python + LangGraph, Ishita)
              plan -> source -> vet -> procure -> validate
                 -> (fallback loop) -> assemble -> book
              checkpoint after every node
                        |
              packages/procurer  (TypeScript, Poulav)
              buyer-side x402: pay-and-call, receipts,
              refunds, hard spend caps
                        |
        real third-party ASPs (HatchAI, CoinAnk, ...)
                        |
        Treasury Copilot (Agent 5863, ours, live)
        books the spend: DISCLOSED intra-team payment
```

Reused from the monorepo: the marketplace scanner (vendor discovery), the KYA scoring engine (vendor base scores, used as an internal library and disclosed as such), the golden eval harness in `tests/` (extended for the new flows), the mocks package, Treasury's server and charging patterns.

Locked decisions, do not relitigate:
- **Async A2MCP, never A2A escrow.** Escrow is "coming soon" in the SDK and is the surface ASP 4962 died on in review. Task Hall auto-bidding is a gated stretch, not the product.
- **Checkpointed state.** Runs touch real money across external services. A crash resumes from the last completed node and never re-pays a vendor. Payment steps are idempotent per subtask.
- **Spend controls are first-class.** Per-call, per-task, and daily caps enforced in packages/procurer, visible in logs and provenance. This is what OKX review probes hardest on an autonomously spending agent.

## Integrity rules (breaking any of these is worse than losing)

1. **No fabricated evidence, ever.** No fake vendor failures, no staged agents presented as marketplace agents, no invented tx hashes. If a demo segment is simulated, it is labeled SIMULATED on screen. The plan is to capture a real vendor failure during volume runs; marketplace agents are genuinely flaky.
2. **Intra-team payments are disclosed.** The Firm paying Treasury for the closing statement appears in every provenance receipt as "books by our own Treasury Copilot" and is never counted as external revenue or traction.
3. **No wash trading.** No scripted self-purchases, no routed volume. OKX audits for exactly this.
4. **The refund guarantee is honored.** If validation fails across all candidates, the quoted price is refunded in full, automatically.
5. **Treasury (apps/treasury, Agent 5863) is live production.** Nobody edits it, its prices, or its listing without Poulav's explicit go.

## The 90-second demo (build toward this ending)

Hook: "OKX says the future is one-person companies with an agent workforce. We built the employer." Middle, live: one instruction and a budget go in, The Firm returns a fixed quote, vets candidates on camera and rejects one on a trust flag, hires real third-party agents, real OKLink transactions appear, one hire fails validation and is fired and replaced while the price stays fixed, the deliverable returns with the Profit and Provenance Receipt. Kicker: "One person. One instruction. An economy did the work, and the price never moved."