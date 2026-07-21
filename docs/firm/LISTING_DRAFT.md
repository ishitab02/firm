# Firm Listing Draft

Owner: Ishita

Submission placeholders:
- Ishita Agent ID: `#7138` (Submitted & Under Review)
- Wallet/listing identity: `ishita02.b@gmail.com / EVM 0x5298633246d682266d5cd7b6da856193da30fa9e / Solana 45j4Kbu98Ktk8y3CgZevP6pGQGGEfiaHmXVNUpADJj1U`
- Avatar asset: `docs/firm/assets/firm-avatar.png`
- Pricing mode: `<TIERS unless dynamic quoted amount is confirmed>`
- Firm Express final job type: `<lock after vendor reliability testing>`
- Review/contact notes: `<fill from OKX/TG thread>`

## ASP Name

Firm

## Short Description

Firm is an autonomous prime contractor for OKX.AI. Give it a goal and budget; it quotes a fixed price, hires specialist agents, validates their work, replaces failures, and returns one deliverable with a costed provenance receipt.

## Long Description

Firm turns the OKX.AI marketplace into an agent workforce. Instead of asking a user to find, vet, pay, and retry individual agents, Firm acts as the employer: it plans the job, sources candidates, filters low-trust vendors, pays through controlled procurement, validates outputs, fires bad hires, and delivers a final result at the quoted price.

If a vendor fails validation, Firm absorbs the retry cost. If all candidates fail, Firm refunds the quoted price. Every completed project includes a provenance receipt showing vendors vetted, vendors rejected, vendors fired, payments, validation checks, truthful margin retained or absorbed, and the disclosed Treasury Copilot books line.

## Service 1: Firm Express

Fixed-price single-vendor jobs for fast repeatable tasks.

Initial listing note:
Express job type is locked after vendor reliability testing. Current placeholder: `market_snapshot`.

Suggested price if tier fallback remains active:
`0.5 USDT` for Express.

## Service 2: Firm Projects

Free quote, then paid execution at the quoted price.

Suggested price display if dynamic quote is not accepted:
S/M/L tiers at `1 / 3 / 5 USDT`.

Flow:
1. `get_quote`: returns deterministic fixed quote and plan summary.
2. `execute`: starts the paid job.
3. `get_status`: returns checkpointed progress.
4. `get_result`: returns deliverable and provenance receipt when complete.

## Integrity Notes

- No fake live tx hashes.
- Mock or local simulation output is labeled `SIMULATED`.
- Treasury Copilot books calls are disclosed as intra-team and not counted as external revenue.
- No wash trading or scripted self-purchases.
- Refund guarantee is honored.

## Demo Spine

One instruction and budget go in. Firm quotes a fixed price, rejects a low-trust vendor, hires a vendor, fires it after validation failure, hires a replacement, delivers at the same price, and shows absorbed margin in the provenance receipt.

## Current Blockers Before Submission

- Ishita Agentic Wallet and Agent ID.
- Real inbound gateway charging.
- Human-triggered outbound x402 payment spike.
- Real vendor pool/index from marketplace scan.
- Express job type lock after reliability testing.

## Evidence to Attach

- Local gateway-worker smoke showing `get_quote -> execute -> get_status -> get_result`.
- Worker refund smoke showing `failed_refunded` and SIMULATED refund tx in local mode.
- Real payment spike tx after Poulav/human-triggered live run.
- Real vendor-index generation timestamp after marketplace scan.
- Screenshot or recording of provenance receipt with fired vendor and absorbed margin.
