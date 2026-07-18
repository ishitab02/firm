# CLAUDE.md

This file replaces the previous CLAUDE.md. The old P1/P2/I1/I2 workstreams are RETIRED (their status files in docs/status/ remain as history). Current state: **Treasury Copilot (apps/treasury, Agent 5863) is LIVE PRODUCTION. The Firm is the active build.**

You are one of several coding agents working in parallel. Your kickoff prompt names your workstream: **F1** or **F3**. Before any code, read: apps/firm/README.md, docs/firm/INTERFACES.md, docs/firm/PLAN.md.

## Ownership matrix (hard boundaries)

| Workstream | Owns (create/edit) | Must never edit |
|---|---|---|
| F1 (Poulav, Claude Code) | packages/procurer | apps/firm, apps/firm-gateway, apps/treasury, apps/kya, packages/mocks, tests/ |
| F3 (Ishita, Claude Code) | apps/firm (Python worker), Postgres migrations for firm job/vendor_performance tables | all packages/*, apps/firm-gateway, apps/treasury, apps/kya |

Shared read-only for ALL agents: docs/firm/INTERFACES.md (the law), apps/firm/README.md, docs/firm/PLAN.md. Schema objections go in your status file; you stop that thread, you never patch the schema or code around it.

## Non-negotiables

1. **Treasury is live production.** apps/treasury, its deploy config, its prices, its listing: untouchable without Poulav's explicit written go in a status file. A bug found there is reported, not fixed in-lane.
2. **Money code is quarantined.** packages/procurer is the ONLY component that may hold a key or send transactions (payments AND refunds). Nothing else imports wallet code. FIRM_WALLET_KEY exists only as an env var, never in the repo.
3. **Spend caps before payment.** Per-call, per-task, daily, and daily-refund caps are enforced in the procurer BEFORE any transfer. No code path may pay first and check later.
4. **Integrity rules from apps/firm/README.md are absolute:** no fabricated vendor results, failures, or tx hashes; simulations labeled SIMULATED; the Firm-to-Treasury payment disclosed in every receipt and never counted as external revenue; no scripted self-purchases; refunds honored automatically up to the quoted price.
5. **Build exactly to docs/firm/INTERFACES.md**, including the truthful economics block (margin retained AND absorbed), the refund transitions, and the idempotency rules. Checkpointed state: a restarted worker never re-pays a completed subtask.
6. **Never invent facts.** Unverified endpoints, fees, addresses, or SDK behavior become env vars + TODO(unverified) + a status-file line. The dynamic-pricing question (INTERFACES section 1B) is OPEN until a human closes it; do not assume either answer.
7. No secrets in the repo; every env var documented in .env.example. Conventional commits, branch per workstream (f1/*, f3/*), humans merge to main.

## Environment

Node 20+, pnpm workspaces (`pnpm i`, `pnpm -F <pkg> dev|test|build`). apps/firm is Python 3.12 + uv + LangGraph (`uv sync`, `uv run pytest`). Postgres via `docker compose up -d db`. TypeScript strict; vitest. Money math, cap enforcement, quote math, and validators require unit tests; a PR touching any without tests is incomplete.

## Session protocol

End every session by appending to docs/status/<YOUR-ID>.md: `## <date>` + Done / Blocked / Next / Questions for humans. Stop-and-ask conditions: anything that would touch apps/treasury; any second place wanting wallet code; the pricing-mechanics assumption; real-money operations (first live payment, first live refund) which ALWAYS need a human go; any temptation to edit outside your lane.

---

## F1 brief (Poulav, Claude Code): packages/procurer, the money spine

Mission: the payment spike. One real outbound x402 payment from The Firm's funded wallet to a genuine third-party marketplace ASP, receipt and tx captured, by July 20. This gates the entire entry (PLAN gate G1).

Scope, in order:
1. Read the official buyer quickstart ("My Agent buys services") and the Node SDK docs; record the actual buyer flow shape in your status file, especially anything that contradicts INTERFACES section 5.
2. Implement /pay-and-call: detect the vendor's 402, verify amount against max_amount and caps, sign via the funded wallet, replay the call, capture receipt + tx. Idempotency on (task_id, subtask_id, vendor_endpoint) backed by Postgres, not memory: you learned this lesson on Treasury's nonce cache.
3. Cap enforcement (per-call, per-task, daily) rejecting BEFORE payment, with tests proving no interleaving of calls can breach a cap.
4. /refund with auto-approval up to the task's quoted price, REQUIRES_HUMAN beyond, daily refund cap, and the same idempotency discipline.
5. Support the pricing-mechanics verification (INTERFACES 1B open question) with a live probe once a human directs it.
First live payment and first live refund are human-triggered: prepare the command, do not fire it yourself.

## F3 brief (Ishita, Claude Code): apps/firm, the brain (your entry)

Mission: the six-stage graph running end to end on vendor fixtures by July 19, on a live vendor by July 22. Definition of done is the five golden evals in INTERFACES section 7, not feature count.

Scope, in order:
1. Pydantic models mirroring INTERFACES exactly: quote, job states, ProvenanceReceipt (truthful economics both directions), vendor_performance.
2. LangGraph state machine with a Postgres checkpoint after every node. Exception paths are product features: the fallback loop (fire, downgrade, re-hire) and the refund path must produce clear, human-readable records.
3. Quote calculator implementing the deterministic math in INTERFACES 1B; unit-test edge cases (budget too small, single-subtask jobs, tier-fallback mode).
4. Sourcing against data/vendor-index.json + the vendor_performance adjustment; ranking and filtering per constraints. The Darwinian update happens on every procurement outcome, firing decrements immediately.
5. The validation stack (INTERFACES 6): pure, unit-tested validators per capability; cheap LLM rubric last, deterministic checks first.
6. Procurement via the procurer's HTTP API only; treat it as a black box; never import wallet code.
7. Assembly + provenance + the disclosed Treasury books call (a real paid call to the live Treasury endpoint, marked intra-team in the receipt).
Build against packages/mocks vendor fixtures from hour one; F4's fixtures are your contract. If the gateway or procurer is not ready, mock their HTTP surfaces per INTERFACES and keep moving.