# Prompt for Codex — judge The Firm as an OKX hackathon entry

Second Codex pass. The first was a code review (`PROMPT_CODEX_REVIEW.md`, output
in `CODEX_REVIEW_2026-07-21.md`) and its findings are now closed. This one is
different: **judge the entry, not the code.**

Copy everything below the line, with the repo checked out at `main`.

---

You are judging a hackathon entry six days before the deadline. Be brutal. The
team has had one review already and fixed everything it found, which means the
easy criticism is gone and you will have to work for the real one.

Assume they can take it. What they cannot afford is politeness that costs them
the competition, or praise for work that no judge will ever see.

## The competition

**OKX.AI hackathon**, deadline **2026-07-27**. Today is 2026-07-21.

OKX built an agent marketplace: AI agents register as service providers (ASPs),
list services at a price, and get paid per call via x402 on X Layer. Agents can
hire other agents. OKX's founder frames the thesis publicly as "one-person
companies running agent workforces."

Entries are listed agents on that marketplace. **An entry that is not listed and
approved does not count.** Listing review has rejected teams repeatedly and has
taken 5+ days.

## The entry

**The Firm** — "an autonomous prime contractor." The pitch: the marketplace has
60+ worker agents and no employer; The Firm is the employer.

A buyer gives it a goal and a budget. It quotes a fixed price, hires specialist
agents, background-checks them before paying, validates their work after, fires
and replaces failures, and returns one deliverable with a costed paper trail. If
it cannot deliver, it refunds.

Claimed differentiators:
1. **Fixed quote, guarantee premium.** The Firm bears execution risk; overruns
   come out of its margin, not the buyer's price. Total failure means a refund.
2. **Darwinian fallback.** Failures downgrade a vendor's trust score and the next
   candidate is hired automatically. The claim: it manufactures reputation rather
   than merely consuming it.
3. **Two price shapes.** Firm Express (fixed, cheap, single vendor, instant) and
   Firm Projects (free quote, then execution at the quoted price).

## Verified state as of 2026-07-21

Established facts. Do not re-litigate whether these are true; judge what they are
worth.

**Live infrastructure**
- `https://firm-gateway.fly.dev` — deployed, public HTTPS, Fly (sin) + Neon.
- `onchainos agent x402-check` returns **`valid: true`** against it. That is
  OKX's own validator, the one whose failure rejected this team's other product.
- Four services: gateway (public), procurer (no public IP, bearer-token only over
  the private network), worker, Postgres.

**Real money**
- Two outbound x402 payments to a genuine third-party marketplace agent (OKLink
  #2023) on X Layer: `0x493a34a5…f26072` and `0x2672820a…ec7eb9`, 15 base units
  each (0.000015 USD₮0).
- The second ran the full pipeline and produced a provenance receipt.
- Idempotency proven under a real retry: three worker runs, two payments.
- Spend caps (per-call, per-task, daily) enforced before any signature, backed by
  Postgres advisory locks.

**Paid inbound path**
- Facilitator wired: `https://web3.okx.com/api/v6/pay/x402`, with OKX HMAC
  request signing. Authenticated against the live API on the first attempt;
  `GET /supported` confirms `exact` on `eip155:196` is supported.
- A forged payment header against the deployed gateway is rejected **by OKX's
  facilitator**, not by the team's own fail-closed path.

**Original research**
Unpaid 402 probes of all 95 endpoint-bearing agents on the marketplace:
- **41 of 95 (43%) dead or misrouted** at their listed endpoint
- 5 charge above their listing — **Clawby #3209 lists at 0.005 USDT and its live
  402 demands 3 USDT, 600x**
- 7 serve for free despite listing a price
- Reproducible: `pnpm -F @firm/procurer vet`

**Engineering**
- 200 automated tests.
- A previous review found 3 C0 bugs, 4 C1, a C2 and a C3. All closed. Notably:
  the gateway verified payments but never settled them (serving every paid call
  free while claiming success); `/refund` returned a fabricated tx when real
  payments were on; refunded jobs reported margin "retained" when it had been
  absorbed; the procurement loop recorded the team's own cap refusals as vendor
  failures.

**Not done**
- **Not listed on the marketplace.** Entry-invalidating. The listing sits on the
  other teammate's wallet and has not been submitted.
- **No demo video.** A script exists that prints a run.
- **The settle success path is unproven.** Auth works, rejection works; no valid
  authorization has verified, settled and returned a transaction. It has never
  taken a real customer's money.
- Firm Projects cannot drive vendors requiring specific request parameters.
- The team's other product (Treasury Copilot) is rejected and unlisted, so the
  "books" line in every receipt is SIMULATED.
- Only one marketplace vendor publishes a machine-readable request schema.

## What to judge

**1. Where does it place, and what is the single thing most likely to sink it?**
Be specific. "Not listed" is the obvious answer — if you agree, say what the
correct triage is for the remaining six days given listing review may eat all of
them. If you disagree, say what is actually more dangerous.

**2. The thesis.** Argue the strongest case AGAINST an orchestrator being a
valuable position. The team's own data says a direct buyer faces a 43% dead rate
and 600x mispricing — does that justify an intermediary, or does it just mean the
marketplace is early and OKX will fix it themselves, wiping out the entire
premise?

**3. Evidence vs claims.** Two payments of 0.000015 USDT is real protocol
conformance and also three-thousandths of a cent. The team has never taken a
real customer's money. What does the evidence actually support, what does it not,
and would a judge notice the gap?

**4. The Darwinian claim, specifically.** It is the most-repeated differentiator
and it rests on a handful of real jobs. Is it a product or a story? The team has
95 probed agents of unused reliability data — would loading that as prior signal
make the claim credible, or is that dressing up an anecdote?

**5. The integrity posture.** This team refuses to fabricate tx hashes, labels
simulations, deleted a false vendor-performance record when they found one, and
disclosed that their own margin was misstated in their favour. Their last review
found that a *bug* had been serving paid work for free — they fixed it rather
than quietly shipping. **Does this discipline read as credibility to a judge, or
as expensive self-limitation next to competitors demoing something shinier?**
Answer honestly, including if the answer is that nobody will look.

**6. The research.** They produced the only reliability dataset on this
marketplace. Is it a bigger asset than the product? Should they publish it, and
if so does publishing help them win or just help OKX?

**7. What to cut.** Name things in this repo they should stop working on. Be
specific and be willing to say "the thing you are proudest of does not matter."

## How to answer

Lead with a verdict and the one thing that decides it. Be quantitative.

Then: **the six-day plan.** Two engineers, one of whom must chase the listing.
Ordered, concrete, with an explicit "do not do this" list.

Their known failure mode is over-engineering correctness no judge will inspect —
they have now had two reviews' worth of practice at it. Their strength is that
the parts they built genuinely work and the claims are unusually well-evidenced.
Tell them which side of that line the remaining six days belong on.

If your honest read is that this entry cannot place because of the listing
timeline, say so plainly and tell them what to salvage instead — the research,
the open-source release, the thread, whatever you judge is worth more than a
late submission.
