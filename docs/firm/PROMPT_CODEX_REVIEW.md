# Prompt for Codex — map and review The Firm

Copy everything below the line into Codex, with the repo checked out at branch
`f1/x402-live-money`.

---

You are reviewing a codebase called **The Firm** for two engineers who own parts
of it but have never read the whole thing end to end. One is the payments/infra
owner, the other owns the AI core. Both are under deadline pressure and need to
be able to *explain and defend* this system to hackathon judges in six days.

Your job has two halves: **map it** so they understand it, and **review it** so
they know where it is weak. Do the mapping first. Do not skip to opinions.

## Ground rules

- **Read the code before asserting anything about it.** Do not infer behaviour
  from file names, comments, or documentation. Comments in this repo are unusually
  detailed and mostly accurate, but several were written by an agent that also
  wrote the code — treat them as claims to verify, not as ground truth.
- **Distinguish fact from inference explicitly.** Write "verified: <file:line>"
  or "inferring, verify by <specific check>". This matters more than usual: the
  reviewers cannot easily check your work.
- **Where you find a discrepancy between the docs and the code, say which one is
  wrong.** `docs/firm/INTERFACES.md` is a frozen contract; deviations from it are
  findings, not style notes.
- Quantify where you can. "Three of the five validators are unreachable from the
  worker" beats "validation coverage is patchy".

## Repository orientation

Read these first, in this order. They are the intended contract and the history:

1. `README.md` — the product thesis
2. `docs/firm/INTERFACES.md` — the frozen contract, **the law**
3. `docs/firm/PLAN.md` — the schedule and its gates (G1, G2, G3)
4. `CLAUDE.md` and `AGENTS.md` — the rules the agents were bound by, including
   lane ownership and a set of integrity rules
5. `docs/status/F1.md`, `F2.md`, `F3.md`, `F4.md` — the running work log. F1 and
   F2 contain a detailed record of bugs found by running the system with real
   money; treat these as the most information-dense files in the repo.
6. `docs/firm/HANDOFF_ISHITA.md` — current state summary

Then the code:

```
apps/firm-gateway/   TypeScript. The paid inbound surface. MCP tools + seller-side x402.
apps/firm/           Python. The worker/brain: plan → source → vet → procure →
                     validate → assemble → book. LangGraph. Postgres checkpoints.
packages/procurer/   TypeScript. THE ONLY COMPONENT ALLOWED TO HOLD A KEY.
                     Buyer-side x402, spend caps, idempotency, refunds.
packages/mocks/      Fixture vendors (good/flaky/dead/low-trust).
tools/vendor-index/  Real marketplace scanner + index generator.
tools/demo/          Demo scenario runner.
tests/firm-evals/    Golden evals (INTERFACES §7).
data/                Real marketplace scan, generated vendor indexes, reliability probes.
```

## Part 1 — Map it (this is the primary deliverable)

Produce a document that lets someone who has never seen this repo understand and
defend it. Include:

**1.1 The one-paragraph product.** What does a buyer get, what do they pay, and
what does the system actually do for the money?

**1.2 The request lifecycle, end to end.** Trace a single Firm Express call from
the inbound HTTP request to the provenance receipt. Name every file and function
it passes through, in order, and say what each one decides. Do the same for the
Firm Projects flow (`get_quote` → `execute` → worker → `get_result`). Show where
they diverge and why.

**1.3 The money path, in both directions.** Inbound (buyer pays The Firm) and
outbound (The Firm pays vendors). For each: where the money decision is made,
what enforces the limits, and what would have to be true for money to move
incorrectly. Be specific about ordering — several safety properties in this
codebase depend on *when* a check runs relative to a signature.

**1.4 State and failure.** Enumerate the job states, what transitions between
them, what is persisted where, and what happens on a crash at each stage. Say
explicitly which failures are safely retryable and which are not, and how the
code distinguishes them.

**1.5 The data model.** Every Postgres table, who owns it, who writes it, who
reads it. Flag any table written by more than one component.

**1.6 Trust and vendor selection.** How a vendor gets chosen, scored, filtered,
hired, validated, and fired. Where the scores come from and how trustworthy that
provenance actually is.

**1.7 A dependency map.** What talks to what, over what protocol, and what
happens when each dependency is unavailable.

## Part 2 — Review it

**2.1 Correctness, ordered by blast radius.** Prioritise anything that could move
money incorrectly, lose a payment, double-pay, or produce a receipt that
misstates what happened. For each finding give a concrete failure scenario:
specific inputs or interleavings, and the wrong outcome.

**2.2 Contract conformance.** Go through `INTERFACES.md` section by section and
report where the implementation deviates. §1 (tool schemas), §2 (state machine),
§3 (ProvenanceReceipt shape), §4 (vendor index), §5 (procurer API), §6
(validation stack), §7 (golden evals). Some deviations are known and documented
in the status files — say which are known and which are not.

**2.3 The integrity rules.** `CLAUDE.md` lists rules the team treats as absolute:
no fabricated vendor results/failures/tx hashes, simulations labelled SIMULATED,
the intra-team Treasury payment disclosed and never counted as external revenue,
no scripted self-purchases, refunds honoured. **Audit the code against each one**
and report any path that could violate it, including by accident. A receipt that
records a vendor failure that did not happen is a violation; so is one that
misstates margin in either direction.

**2.4 Test quality, not test count.** There are ~147 tests. Ask of the important
ones: does this test fail if the behaviour it names regresses? Look specifically
for tests that pass for the wrong reason, assert on a value they also compute, or
exercise a mock so thoroughly they never touch the real path. Flag any
*money-safety* test that is vacuous — that is worse than no test, because it
creates false confidence.

**2.5 What breaks under load or adversity.** Concurrency, partial failure, a
malicious or broken vendor, a vendor that changes its price between quote and
call, network partitions mid-payment.

**2.6 The gap between demo and product.** Which capabilities work only against
the fixtures in `packages/mocks`, and which are proven against real third-party
vendors? Be blunt. Two real payments have been made (tx hashes in
`docs/status/F1.md`) — establish exactly what those prove and what they do not.

## Part 3 — Tell them what to do

Rank every finding by **(impact on judging) × (cost to fix)**, given six days and
two engineers. Separate:
- must fix before submission
- worth fixing if time allows
- known limitations to disclose honestly rather than fix
- things to explicitly *not* do

For anything you would fix, say what you would change and roughly how large the
change is.

## What good output looks like

A document they can read in twenty minutes and then answer questions about their
own system confidently. Concrete over abstract. Cite `file:line`. If you are
uncertain, say so and name the check that would resolve it. If you think a design
decision is wrong, argue it — but represent the reasoning that led to it first,
since much of it is recorded in the status files and several apparently odd
choices were deliberate responses to real incidents.
