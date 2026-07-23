# Grok judging prompt — post-approval (2026-07-23)

**Regenerated 2026-07-23, the day ASP #7138 was approved and listed.** Earlier
versions of this file predate approval; do not reuse them. Every factual claim
below is verifiable on chain or against the live endpoint; nothing is
aspirational, and the admissions section is as load-bearing as the claims.

---

Copy everything below the line into Grok.

---

You are an adversarial judge for the OKX.AI Genesis Hackathon (submission
deadline July 27, 23:59 UTC). Score the entry described below. Be harsh,
specific, and do not reward any claim that lacks evidence. Where a claim is
verifiable on chain, treat it as fact; where it is the team's own framing,
discount it accordingly.

## The entry

**The Firm** — an autonomous prime contractor on the OKX.AI agent marketplace
(X Layer, x402 payments in USD₮0). A buyer pays a fixed price; the Firm hires
real third-party marketplace agents, validates their output, and returns one
deliverable with a costed provenance receipt. If it cannot deliver, the buyer
is refunded automatically — or never charged at all.

**Status: ASP #7138 was approved and listed on July 23**, after three failed
reviews, each root-caused and fixed (reachability; a wrong-symbol deliverable
that passed validation; a transient vendor-payment rejection surfacing as
fulfilment failure).

Two products, both proven on real money in production:

- **Firm Express, 0.1 USDT.** One BTC/ETH market snapshot (1h/2h/4h/1d). Buys
  the raw price series from OKLink #2023 — a real third-party marketplace
  agent — for 15 base units over x402, derives price action / trend / support /
  resistance itself, validates 12 checks, and settles the buyer's payment
  ONLY after validation passes. Receipt: `100000 = 15 + 99985`.
- **Firm Projects, 1 USDT.** Two to four analysis legs; each leg is a separate
  paid vendor purchase; assembly is all-or-nothing, else full refund. Proven
  run: 4 legs, 4 separate 15-unit vendor payments, buyer settled once, all in
  consecutive blocks. Receipt: `1000000 = 60 + 999940`.

## Evidence the team can produce on demand (all on X Layer)

- Express delivery with vendor-paid-before-buyer-settled ordering: vendor tx
  `0xaee8ba41…` (blk 66021738) then buyer settle `0x532f1b26…` (blk 66021739) —
  and the buyer was a **plain MetaMask/local EIP-3009 signer**, not the
  OKX-managed wallet, proving open interoperability.
- Projects run: settle `0xb69d7688…` plus four vendor txs in blocks
  66017033–66017038.
- The refund guarantee firing unprompted on real money (July 22): buyer repaid
  in full, vendor cost absorbed by the Firm.
- Idempotency enforced ON CHAIN: the EIP-3009 nonce is derived from the
  idempotency key, so a retried payment cannot double-spend by construction.
- Spend caps (per-call, per-task, daily, daily-refund) enforced BEFORE any
  transfer, in the only component allowed to hold a key.
- Fail-closed operations: the public gateway refuses to boot if the refund path
  is not operationally ready (signer, network, native gas checked live) — the
  endpoint goes honestly down rather than quietly unrefundable.
- A 95-agent marketplace reliability study with paid probes, published, whose
  findings changed the product's own vendor selection.
- Pricing at market: across 129 observed marketplace prices, the median is
  100,000 base units — exactly Express's price; eight other listed services
  charge Projects' 1 USDT.

## What the team admits, and you should weigh

- **Zero external customers at approval time.** Every purchase to date is the
  team's own QA, disclosed as such, one of them circularly funded (also
  disclosed). Self-purchases are not demand, and the team does not count them
  as revenue or traction. The listing has only just gone public.
- **One effective data vendor.** OKLink #2023 is the only marketplace agent
  with a verified paid contract; if it is down, delivery honestly refunds but
  does not happen. "Agent workforce" is demonstrated at N=1 supplier.
- **Projects' listed endpoint is currently wrong** (points at the Express root,
  a live fee mismatch) pending a service-record fix that may require re-review.
- Adaptive fallback with a performance ledger is demonstrated; closed-loop
  "Darwinian learning" (a score measurably improving a later job) is not, and
  the team's materials say so explicitly.
- A signing key for the treasury wallet was exposed to an AI-session
  transcript; the team documented it and deliberately deferred rotation past
  the deadline as an accepted risk. The wallet holds only a few USDT.
- Late-breaking defects were found by real purchases as recently as July 23 (a
  CLI param-shape bug; a transient vendor rejection). The team's own position
  is that only paid end-to-end runs count as testing.

## Score it

Score each 0–20, then tally to /100 and give a verdict:

1. **Working product** — does it demonstrably do what it sells, end to end, on
   real money, in production?
2. **Integrity of evidence** — are claims verifiable, self-purchases disclosed,
   receipts honest (margin shown both retained AND absorbed)?
3. **Thesis and differentiation** — is "the employer for the agent economy" a
   real product insight, and does the implementation embody it beyond a thin
   wrapper?
4. **Demand and ecosystem reality** — external customers, marketplace fit,
   single-vendor concentration, unit economics under scrutiny.
5. **Execution quality under review** — three rejections to approval, response
   to reviewer feedback, operational readiness (caps, refunds, fail-closed,
   monitoring).

Then answer plainly: **can this entry win the hackathon, and what single change
in the remaining days would most raise its odds?** Do not be polite; be right.
