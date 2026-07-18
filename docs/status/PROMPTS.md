# FIRM PROMPTS — Kickoff prompts

Paste as the first message of each agent session. Fill `<...>` slots first. Re-anchor long-running agents each morning with: "Re-read docs/firm/INTERFACES.md and docs/firm/PLAN.md, then continue from docs/status/<ID>.md."

---

## F1 (Poulav, Claude Code): procurer, the payment spike

```
You are workstream F1. Read CLAUDE.md, apps/firm/README.md, docs/firm/INTERFACES.md, docs/firm/PLAN.md fully before any code. Ownership boundaries and stop-and-ask rules in CLAUDE.md are absolute. Note: apps/treasury is LIVE PRODUCTION and untouchable.

Mission: the payment spike (PLAN gate G1). One real outbound x402 payment from The Firm's funded wallet to a genuine third-party marketplace ASP, receipt and tx hash captured, by July 20. Everything else in this entry gates on you.

Context from me now:
- Buyer quickstart + Node SDK docs: <links/paste>
- Firm wallet: funded? <yes/no>; FIRM_WALLET_KEY delivery method: <env only>
- Target vendor for the spike (cheap, reliable, from the scan): <agent id + endpoint>

Today, in order:
1. Build packages/procurer skeleton with the exact HTTP surface in INTERFACES section 5.
2. Implement /pay-and-call: 402 detection, amount verification against max_amount AND caps BEFORE payment, signing, replay, receipt capture. Idempotency on (task_id, subtask_id, vendor_endpoint) backed by Postgres, not memory.
3. Cap enforcement with interleaving tests: no concurrent sequence may breach per-call, per-task, or daily caps.
4. /refund with auto-approval up to quoted price, REQUIRES_HUMAN beyond, daily refund cap, same idempotency.
5. Prepare (do not fire) the live spike command. First live payment and first live refund are ALWAYS human-triggered.

If the SDK/docs contradict INTERFACES section 5, stop that thread, write the contradiction to docs/status/F1.md, continue on unblocked work. End the session appending Done/Blocked/Next/Questions to docs/status/F1.md.
```

---

## F2 (Poulav, Codex): gateway, vendor index, KYA reconcile

```
You are workstream F2. Read AGENTS.md, apps/firm/README.md, docs/firm/INTERFACES.md, docs/firm/PLAN.md fully before any code. Ownership boundaries in AGENTS.md are absolute. apps/treasury is LIVE PRODUCTION: copy its server/charging patterns, never modify it.

Mission: the listable inbound surface and trustworthy vendor intelligence.

Today, in order:
1. apps/firm-gateway: MCP server exposing exactly the five tools in INTERFACES section 1, inbound charging via the seller-side pattern lifted from apps/treasury. Pricing mode behind a PRICING_MODE switch: TIERS (default) | QUOTED_AMOUNT. The dynamic-pricing question is OPEN; implement both, assume neither.
2. Job queue: paid calls insert jobs to Postgres; get_status/get_result read worker state; the gateway runs zero graph logic.
3. KYA reconcile, surgical, apps/kya scoring only: fix the fixture-score inconsistency (declared scores vs weighted sums, missing BURST_FEEDBACK trigger) and add weighted-sum + derived-flag consistency tests. Do this BEFORE the index script; an untrustworthy trust score is worse than none.
4. tools/vendor-index: scan the live marketplace (reuse the existing scanner), score with reconciled KYA, emit data/vendor-index.json per INTERFACES section 4 with a generation timestamp.

Never invent vendor fees or endpoints: unverified values become TODO(unverified) + a status line. End the session appending Done/Blocked/Next/Questions to docs/status/F2.md.
```

---

## F3 (Ishita, Claude Code): the brain, your entry

```
You are workstream F3. Read CLAUDE.md, apps/firm/README.md, docs/firm/INTERFACES.md, docs/firm/PLAN.md fully before any code. Ownership boundaries in CLAUDE.md are absolute. This is my hackathon entry; the AI core is my lane end to end.

Mission: the six-stage LangGraph worker (plan, source, vet, procure, validate with Darwinian fallback, assemble+book) running end to end on vendor fixtures by July 19, on a live vendor by July 22. Definition of done: the five golden evals in INTERFACES section 7.

Today, in order:
1. apps/firm as a uv project. Pydantic models mirroring INTERFACES exactly: quotes, job states, ProvenanceReceipt with the truthful economics block (margin retained AND absorbed), vendor_performance.
2. LangGraph state machine, Postgres checkpoint after every node, resume-safe: a restarted worker never re-pays a completed subtask (idempotency keys per INTERFACES).
3. Quote calculator per the deterministic math in INTERFACES 1B, unit-tested, including tier-fallback mode.
4. Sourcing: rank by kya_base_score + vendor_performance adjustment, filter by constraints. Every procurement outcome updates vendor_performance; a firing decrements immediately.
5. Validation stack per INTERFACES 6: deterministic checks first, cheap LLM rubric last, pure and unit-tested against F4's vendor fixtures.
6. The fallback loop and refund path as first-class product features with clear human-readable records.
7. Procurement ONLY via the procurer HTTP API (mock its surface if not ready). Books step: a real paid call to live Treasury, marked intra-team in the receipt.

Build against packages/mocks vendor fixtures from hour one. If a schema seems wrong, object in docs/status/F3.md and stop that thread; never patch INTERFACES. End the session appending Done/Blocked/Next/Questions to docs/status/F3.md.
```

---

## F4 (Ishita, Codex): fixtures, evals, demo harness

```
You are workstream F4. Read AGENTS.md, apps/firm/README.md, docs/firm/INTERFACES.md, docs/firm/PLAN.md fully before any code. Ownership boundaries in AGENTS.md are absolute.

Mission: everyone's velocity and the ship gate. F3 builds against your fixtures from hour one; the July 22 listing submission is gated on your evals passing.

Today, in order:
1. packages/mocks: three mock vendor MCP servers with distinct personalities: vendor_good (reliable), vendor_flaky (succeeds, then fails validation on schema/staleness specifically, not generic errors), vendor_dead (times out). Consistent prices/latencies; serve the x402 challenge shape the procurer expects.
2. tests/: the five golden evals from INTERFACES section 7 as one-command checks against the worker: quote honored (including absorbed-margin runs), fallback fires with performance downgrade, refund on total failure, provenance completeness, budget safety under interleaving.
3. tools/demo: scenario runner executing the flagship spine (quote, trust rejection, hires, firing, delivery at fixed price) against fixtures, screen-recordable output, plus a live-mode flag for the real vendor pool later.
4. Realism discipline: the demo output's receipt must show absorbed margin on the firing run; numbers must reconcile exactly.

Schema drift between your mocks and INTERFACES is a build-stopping bug; when INTERFACES bumps, your update ships in the same PR. End the session appending Done/Blocked/Next/Questions to docs/status/F4.md.
```