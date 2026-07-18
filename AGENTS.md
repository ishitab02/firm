# AGENTS.md

This file replaces the previous AGENTS.md. Old P/I workstreams are RETIRED. Current state: **Treasury Copilot (apps/treasury, Agent 5863) is LIVE PRODUCTION. The Firm is the active build.** Rules here mirror CLAUDE.md; both files bind all agents.

You are one of several coding agents working in parallel. Your kickoff prompt names your workstream: **F2**, **F4**, or **AG** (optional). Before any code, read: apps/firm/README.md, docs/firm/INTERFACES.md, docs/firm/PLAN.md.

## Ownership matrix (hard boundaries)

| Workstream | Owns (create/edit) | Must never edit |
|---|---|---|
| F2 (Poulav, Codex) | apps/firm-gateway, tools/vendor-index (generation script), apps/kya score reconcile ONLY | apps/firm, apps/treasury, packages/procurer, packages/mocks, tests/ |
| F4 (Ishita, Codex) | packages/mocks (vendor fixtures), tests/ (firm evals), tools/demo | all apps/* except reading, all other packages/* |
| AG (optional, gated) | apps/dashboard Firm-run view only | everything else |

Shared read-only for ALL agents: docs/firm/INTERFACES.md (the law), apps/firm/README.md, docs/firm/PLAN.md. Schema objections go in your status file; stop, never patch the schema or code around it.

## Non-negotiables (identical to CLAUDE.md, binding)

1. **Treasury is live production**: apps/treasury, its deploy, prices, listing are untouchable without Poulav's explicit written go. Report bugs, do not fix cross-lane.
2. **Money code is quarantined in packages/procurer.** No other component holds keys or sends transactions. The gateway CHARGES inbound via the existing seller-side adapter pattern (as Treasury does); it never pays outbound.
3. **Integrity rules are absolute**: no fabricated vendor results/failures/tx hashes; simulations labeled SIMULATED; the Firm-to-Treasury payment disclosed and never counted as external revenue; no scripted self-purchases; the refund guarantee honored.
4. Build exactly to docs/firm/INTERFACES.md. The dynamic-pricing question (section 1B) is OPEN until a human closes it; implement behind a switch supporting both quoted-amount and tier modes.
5. Never invent facts: unverified fees/endpoints/behavior become env vars + TODO(unverified) + a status line.
6. No secrets in the repo; .env.example documents everything. Conventional commits, branch per workstream (f2/*, f4/*, ag/*), humans merge.

## Session protocol

End every session appending to docs/status/<YOUR-ID>.md: `## <date>` + Done / Blocked / Next / Questions for humans. Stop-and-ask: anything touching apps/treasury; wallet code anywhere outside procurer; assuming the pricing answer; real-money operations (always human-triggered); cross-lane temptation.

---

## F2 brief (Poulav, Codex): gateway, vendor index, KYA reconcile

Mission: the inbound surface The Firm is listed on, and trustworthy vendor intelligence underneath it.

Scope, in order:
1. apps/firm-gateway: MCP server exposing the five tools in INTERFACES section 1 (express_run, get_quote, execute, get_status, get_result), charging via the hardened seller-side pattern lifted from apps/treasury (do not modify treasury; copy the pattern). Pricing mode behind a switch: QUOTED_AMOUNT | TIERS, default TIERS until the open question closes.
2. Job queue writes: paid execute/express calls insert jobs into Postgres for the Python worker; get_status/get_result read worker state. The gateway never runs graph logic.
3. KYA score reconcile (surgical, inside apps/kya's scoring only): fix the known fixture-scoring inconsistency (declared golden scores vs weighted component sums; the missing BURST_FEEDBACK trigger). Add weighted-sum and derived-flag consistency tests so it cannot regress. This is a precondition for step 4; an untrustworthy trust score is worse than none.
4. tools/vendor-index: script that scans the live marketplace (reuse the existing scanner), runs reconciled KYA scoring on candidates, and emits data/vendor-index.json per INTERFACES section 4. Regenerable on demand; record generation timestamp inside the file.
5. Registration support: the listing configuration for one ASP with both services under Ishita's identity, ready for the July 22 submission.

## F4 brief (Ishita, Codex): fixtures, evals, demo harness

Mission: everyone else's velocity and the gate that says The Firm is real. F3 can only build today because your vendor fixtures exist; the listing only ships July 22 if your evals pass it.

Scope, in order:
1. packages/mocks vendor fixtures: three mock vendor MCP servers with the personalities the whole design depends on: vendor_good (reliable), vendor_flaky (succeeds then fails validation on schema/staleness), vendor_dead (times out). Internally consistent prices and latencies; both x402-challenge shapes served, matching what the procurer expects.
2. tests/: the five golden evals from INTERFACES section 7 (quote honored, fallback fires, refund on total failure, provenance completeness, budget safety) as one-command automated checks against the worker. These gate G2 on July 22.
3. tools/demo: scenario runner that executes the flagship demo spine (quote -> trust rejection -> hires -> firing -> delivery at fixed price) against fixtures, printing cleanly enough to screen-record; plus a live-mode flag that runs the same spine against the real vendor pool once it exists.
4. Fixture realism discipline: the flaky vendor's failure must trip specific validators, not generic errors; the receipt in the demo output must show absorbed margin on the firing run.

## AG brief (optional, gated): dashboard Firm-run view

Do not begin unless a human writes GO in docs/status/AG.md (decision July 23, PLAN cut order item 2). Read-only view: live job timeline (states lighting up), vendor cards with effective scores, payment receipts with OKLink links, the ProvenanceReceipt rendered. Consumes worker state and gateway reads only; no writes; no edits outside apps/dashboard; bugs elsewhere reported in status, never patched.