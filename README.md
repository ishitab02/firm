# The Firm

**An autonomous prime contractor on OKX.AI.** You give it a supported market-research goal and a budget. It quotes a fixed price, hires marketplace services, checks their exact contracts before paying, validates every result, and returns one finished deliverable with a complete costed paper trail. If it cannot deliver, it refunds you.

Entry owner: **Ishita** (her hackathon submission, her AI core). Payments and infrastructure: **Poulav**. Deadline: **July 27, 23:59 UTC**.

## The one-line pitch

OKX's founder says the future is one-person companies running agent workforces. The marketplace has 60+ workers and no employer. The Firm is the employer.

## Status, stated plainly

Live at **https://firm-gateway.fly.dev**. Both the 0.1-USDT Express endpoint and
the 1-USDT Projects endpoint at `/projects` return valid x402 challenges.

**The whole paid path now works end to end. Zero external customers.**

Both halves matter. A buyer can pay The Firm, the payment settles on X Layer, a
worker sources and hires real marketplace agents, a deliverable comes back
inline, and the margin reconciles against chain state. When it cannot deliver,
it refunds automatically — that has happened, on real money, unprompted.

Every purchase so far was **our own QA transaction from our own wallet,
disclosed as such**. Nobody outside this team has bought anything. Those runs are
evidence that the machine works; they are not revenue, not demand, and not
traction, and they are never counted as any of those.

| proven | not yet proven |
|---|---|
| Public endpoint passes OKX's own x402 validator, on both the documented and MCP request shapes | Demand: no external customer has bought |
| A customer payment verifies, settles, and returns a deliverable (`t_c6aaf880…`, ~12s) | Sustainable unit economics at any volume |
| The refund guarantee fires automatically on failure, absorbing vendor cost | Outcome quality at scale |
| The Firm pays real third-party agents; idempotency holds under retry, enforced on-chain by a derived EIP-3009 nonce | A moat |
| Provenance reconciles: `user_price = vendor_costs + books + margin` | Multi-subtask jobs against real vendors |
| 95 agents probed: a measurable reliability problem exists, and it predicted our own run |  |

## Why this version wins (the three upgrades over a generic orchestrator)

1. **Fixed quote, guarantee premium.** The Firm quotes a fixed price up front and bears execution risk. When a hired agent fails and a replacement is hired, the overrun comes out of The Firm's margin, not the user's price. The margin is not markup: it buys vetting, validation, retries, and a guaranteed outcome. Total failure = full refund.

   **Priced at market, not at cost-plus** — and the distinction is worth stating before someone does the arithmetic themselves. Express costs 15 base units of vendor input and sells for 100,000, which is a ratio of ~6,700x; Projects buys 30–60 units across its legs and sells for 1,000,000. Those ratios look indefensible if you assume the price is meant to be a markup on the input. It is not.

   Across the 129 service prices in our own marketplace scan (`data/marketplace-health-2026-07-21.json`):

   | | base units | USDT |
   |---|---|---|
   | minimum | 1 | 0.000001 |
   | 25th percentile | 10,000 | 0.01 |
   | **median** | **100,000** | **0.1** |
   | 75th percentile | 300,000 | 0.3 |
   | maximum | 6,600,000 | 6.6 |

   The most common price points are 10,000 (33 services), 100,000 (24), 500,000 (17), 50,000 (13) and 1,000,000 (8). **Firm Express at 0.1 USDT is exactly the marketplace median. Firm Projects at 1 USDT is a price eight other listed services already charge.** Neither is an outlier.

   What makes the ratio large is the input, not the price: OKLink sells a raw price series for 15 units, which sits *below the 25th percentile* — near the floor of the entire market. Comparing a median retail price against one unusually cheap input measures OKLink's pricing, not ours. The buyer is paying for the analysis, the validation, the replacement of failed vendors, and a refund guarantee the Firm funds out of its own margin — priced where comparable services are priced.
2. **Adaptive fallback, on measured evidence.** The Firm does not trust its hires. It background-checks every candidate before paying — a free 402 probe that reads what the vendor will *actually* charge, not what it advertises. Deliverables then pass a validation stack; failures are recorded, the vendor's score drops, and the next candidate is hired automatically. The user never sees the hiccup.

   Still **not** claimed as "Darwinian learning", but the gap has narrowed and it is worth being exact about where. Demonstrated on real paid jobs: the fallback loop firing and replacing five vendors inside a single job; a performance ledger with nine vendors carrying adjustments earned from paid outcomes (−30, −19, −10); and preflight health over 95 probed agents changing which vendors get hired at all — after that filter went in, a run that had been hiring dead endpoints first hired **zero**.

   What is still *not* demonstrated is the closing of the loop: a vendor's accumulated score demoting it on a later job in a way that measurably improves the outcome. Until that is observed, the true claim is "adaptive fallback with accumulated performance evidence", and that is what we say.
3. **Two services, two honest scopes.** "Firm Express" is a 0.1-USDT single-symbol, single-timeframe snapshot. "Firm Projects" is a 1-USDT bundle of two to four BTC/ETH analysis legs across 1h, 2h, 4h, or 1d. Each Projects leg purchases a separate marketplace price series, validates symbol/timeframe/topic relevance, and is assembled only if every leg passes; otherwise the full buyer price is refunded. A one-leg request is refused with a pointer to Express, and an unsupported goal is refused before payment.

   Express is the smallest honest instance of the whole thesis. A buyer asks for an ETH 4h market snapshot and pays 0.1 USDT. The Firm buys the raw price series from **OKLink (Agent #2023)** for **15 base units** — a real third-party marketplace agent, paid over x402 — and derives the price action, trend, support and resistance itself. The receipt reads `100000 = 15 + 99985`.

   What the buyer pays for is the analysis, not the data. That distinction is the product: the alternative was to fetch OKX's own free public candle endpoint and resell it at 0.1 USDT, which would deliver the same JSON while making this a proxy rather than a contractor — and would resell the host's free data back to them inside their own competition. Where a quoted asset has no direct feed, the source is disclosed: ETH is priced via WETH, and an unmapped symbol is refused **before** any money moves.

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
        verified third-party ASP contract (OKLink #2023 today)
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

   This extends to how a QA buyer is funded. A test purchase whose USDT came *from the Firm's own wallet* is circular — the Firm pays itself, and the only real movement is gas. It is a valid smoke test of the machinery and it is **not** a sale: it must never be counted as revenue, demand, or traction, and it must not be presented as a customer purchase. When a purchase needs to stand as evidence that someone bought something, the buyer is funded from an independently controlled human wallet.
4. **The refund guarantee is honored.** If validation fails across all candidates, the quoted price is refunded in full, automatically.
5. **Treasury (apps/treasury, Agent 5863) is live production.** Nobody edits it, its prices, or its listing without Poulav's explicit go.

## The 90-second demo (build toward this ending)

Hook: "OKX says the future is one-person companies with an agent workforce. We built the employer." Middle, live: one instruction and a budget go in, The Firm returns a fixed quote, vets candidates on camera and rejects one on a trust flag, hires real third-party agents, real OKLink transactions appear, one hire fails validation and is fired and replaced while the price stays fixed, the deliverable returns with the Profit and Provenance Receipt. Kicker: "One person. One instruction. An economy did the work, and the price never moved."
