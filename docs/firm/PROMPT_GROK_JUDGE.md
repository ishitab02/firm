# Prompt for Grok — judge The Firm as an OKX hackathon entry

Copy everything below the line. Attach or paste the repo's `README.md`,
`docs/firm/INTERFACES.md`, `docs/firm/PLAN.md`, `docs/status/F1.md`,
`docs/status/F2.md`, and `docs/firm/HANDOFF_ISHITA.md` if the tool allows it.

---

Judge a hackathon entry. Be a hostile-but-fair reviewer, not a cheerleader. The
team wants to know where they lose, not where they are clever. Assume they can
take criticism and cannot afford flattery — they have six days left and limited
attention, so tell them what actually decides the outcome.

## The competition

**OKX.AI hackathon.** OKX has built an agent marketplace where AI agents register
as service providers (ASPs), list services with prices, and get paid per call via
the x402 payment protocol on X Layer. Agents can hire other agents. OKX's founder
has publicly framed the thesis as "one-person companies running agent
workforces". Entries are listed agents on that marketplace. **An entry that is
not listed and approved does not count.** Listing review has rejected teams
repeatedly and has taken 5+ days.

## The entry

**The Firm** — positioned as "an autonomous prime contractor". The pitch: the
marketplace has 60+ worker agents and no employer; The Firm is the employer.

A buyer gives it a goal and a budget. It quotes a fixed price, hires specialist
agents from the marketplace, background-checks them before paying, validates
their work after, fires and replaces the ones that fail, and returns one finished
deliverable with a complete costed paper trail. If it cannot deliver, it refunds.

Three claimed differentiators:
1. **Fixed quote, guarantee premium.** The Firm bears execution risk. When a
   hired agent fails and a replacement is hired, the overrun comes out of The
   Firm's margin, not the buyer's price. Total failure means a full refund.
2. **Darwinian fallback.** Every deliverable passes a validation stack. Failures
   downgrade that vendor's trust score in a performance database, and the next
   candidate is hired automatically. The claim: it does not just consume
   reputation, it manufactures it.
3. **Two price shapes.** "Firm Express" (fixed cheap price, single vendor,
   instant) and "Firm Projects" (free quote, then execution at the quoted price).

## Verified state as of 2026-07-21

Treat these as established facts, not claims:

**Working, with on-chain evidence**
- Two real outbound x402 payments to a genuine third-party marketplace agent
  (OKLink Onchain Data Explorer #2023) on X Layer:
  - `0x493a34a5b33dc8c17760a81d4b028f298ccb9264d19dd1032e9549b182f26072`
  - `0x2672820a7d1429a7a84c03f330d89b64bf3701e090aab9bb4ee83a08bbec7eb9`
  - 15 base units each (0.000015 USD₮0)
- The second ran the full pipeline — plan, source, vet, procure, validate,
  assemble, book — and produced a provenance receipt with a real tx hash.
- Idempotency proven under a real retry: three worker runs, two payments. The
  re-run returned the recorded receipt instead of paying twice.
- Spend caps (per-call, per-task, daily) enforced before any signature, backed by
  Postgres with an advisory lock.
- The gateway speaks the MCP handshake and returns a standard HTTP 402 challenge
  to unpaid requests.
- 147 automated tests pass.
- A real marketplace scan: 218 agents, 118 priced services mapped.

**Original research the team produced**
Unpaid probes of the 10 cheapest matching vendors found:
- 6 of 10 reachable and x402-conformant
- 4 of 10 dead or misrouted (2 unreachable, 2 return 404 at their *listed* endpoint)
- 2 of 6 working vendors charge a different price than they advertise
- **One vendor is listed at 0.005 USDT and its live 402 demands 3 USDT — 600x**

**Not working / not done**
- **Not yet listed on the marketplace.** This is the entry-invalidating item.
- No demo video exists. There is a script that prints a run.
- The gateway is not deployed publicly; it runs on localhost.
- The refund path is implemented and tested but has never moved real money.
- "Firm Projects" cannot drive vendors that require specific request parameters —
  its `execute` tool takes only a quote id, and widening that would change a
  frozen contract. Only "Firm Express" carries parameters.
- The team's own earlier product (Treasury Copilot, cited in the entry as a
  disclosed intra-team bookkeeping dependency) was rejected from the marketplace
  twice and is not listed. So the "books" line in every provenance receipt is
  currently SIMULATED.
- Only one vendor in the entire marketplace publishes a machine-readable request
  schema. The rest are called somewhat blind.

**Bugs found by running it with real money, and fixed**
Included because they show the failure modes and because you may judge how much
confidence the remaining code deserves:
- The validation stack only recognised the shape of the team's own test fixtures.
  A real vendor delivered correctly, was rejected, fired, and recorded in the
  performance database as having failed — a fabricated accusation against a real
  third party with 1,572 completed sales, written into a provenance receipt.
- Simulated and real spend shared one ledger, so test traffic could exhaust the
  real daily cap and block a live payment.
- The receipt subtracted a Treasury books cost that was never incurred,
  understating the team's own margin.
- The reservation function had two sources of truth for the amount being claimed.

## What to judge

**1. Would this win?** Against a field of agents on a new marketplace, most of
which will be single-purpose service agents. Where does it place, and what is the
single thing most likely to sink it?

**2. Is the thesis actually right?** "The marketplace has workers and no
employer" — is an orchestrator the valuable position, or is it a thin wrapper
capturing margin between a buyer and a vendor who could have transacted directly?
Argue the strongest case against the entry's own premise.

**3. Is the evidence proportionate to the claims?** Two payments of 0.000015 USDT
each is real money and real protocol conformance — but it is also 3 cents of a
cent. What does it genuinely prove, what does it not, and would a judge notice
the gap? Is "we made a real payment" impressive here or table stakes?

**4. The Darwinian claim.** The system manufactures vendor reputation from its
own procurement outcomes. Given it has run a handful of real jobs, is that a real
product or a story about one? What would make it credible?

**5. The integrity posture.** This team has been unusually strict — refusing to
fabricate tx hashes, labelling simulations, deleting a false vendor-performance
record when they found one, disclosing that their own margin was misstated in
their favour. Does that discipline read as credibility to a judge, or as
unnecessary self-limitation next to competitors who will simply demo something
shinier? Be honest, including if the answer is uncomfortable.

**6. The vendor research.** They accidentally produced the only real dataset on
this marketplace's reliability — 40% dead endpoints, a 600x mispricing. Is that a
bigger asset than the product itself? How would you use it?

**7. What would you cut and what would you add**, given six days, two engineers,
and the constraint that listing review may consume most of that time.

## How to answer

Lead with your verdict and the one thing that decides it. Be specific and
quantitative. If you think the entry is mediocre, say so plainly and explain what
a winning entry in this competition looks like instead. If you think a claimed
differentiator is actually weak, attack it directly.

The team's failure mode is over-engineering correctness that no judge will ever
look at. Their strength is that the parts they built genuinely work. Tell them
where the line between those two is, and which side of it their remaining six
days should be spent on.
