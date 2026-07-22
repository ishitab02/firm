# Firm Listing Draft

Owner: Ishita

Submission placeholders:
- Ishita Agent ID: `#7138` (Submitted & Under Review)
- Wallet/listing identity: `ishita02.b@gmail.com / EVM 0x5298633246d682266d5cd7b6da856193da30fa9e / Solana 45j4Kbu98Ktk8y3CgZevP6pGQGGEfiaHmXVNUpADJj1U`
- Avatar asset: `docs/firm/assets/firm-avatar.png`
- Pricing mode: `TIERS` (deployed gateway reports `pricing_mode: TIERS`)
- Firm Express final job type: `market_snapshot` (LOCKED)
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

Job type: `market_snapshot` (LOCKED — no longer a placeholder).
Price: **0.1 USDT** (`EXPRESS_PRICE_UNITS=100000`), matching the deployed gateway.

**What the buyer gets.** A market snapshot for a supported symbol and timeframe:
current price, price action over the window, trend, support and resistance.

Request fields, exactly as the endpoint accepts them:

```json
{ "symbol": "ETH", "timeframe": "4h", "prompt": "market snapshot with support and resistance" }
```

Supported symbols: `BTC`, `ETH`. Supported timeframes: `1h`, `2h`, `4h`, `1d`.
A flat body like the above is accepted directly — no JSON-RPC envelope required —
and any unpaid POST is answered with an HTTP 402 price challenge.

**How it is produced (say this plainly in the listing).** Firm does not own price
data. It buys the raw series from **OKLink, Agent #2023**, at **15 base units**
over x402, and derives the analysis itself. The provenance receipt names that
vendor and that cost: `100000 = 15 + 99985`.

The analysis is the thing being sold; the data is an input Firm pays a specialist
for. `4h` is bought hourly and resampled into 4h OHLC buckets, which is work
included in the price. Where a symbol has no direct feed the source asset is
disclosed — ETH is priced via WETH — and an unmapped symbol is refused before
any money moves.

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

Cleared (2026-07-22):

- ~~Ishita Agentic Wallet and Agent ID~~ — `#7138`, submitted and under review.
- ~~Real inbound gateway charging~~ — a customer payment verified, settled and
  returned a deliverable (`t_c6aaf880…`).
- ~~Human-triggered outbound x402 payment spike~~ — G3, from the deployed
  procurer.
- ~~Real vendor pool/index from marketplace scan~~ — 95 agents probed, health
  folded into the base scores.
- ~~Express job type lock~~ — `market_snapshot`, locked.

Open:

- **Decide whether to rotate the Firm wallet.** A private key for `0xC029…50e0`
  was exposed in a session transcript. Rotating changes `payTo` in every 402
  challenge, so it changes this listing — decide before submitting, not after.
  See `docs/status/F1.md`.
- **Three-component maintenance deployment is outstanding.** `packages/procurer`,
  `apps/firm` and `apps/firm-gateway` are all behind `main`. Express does not buy
  from OKLink in production until this ships. Order is **procurer -> worker ->
  gateway** (the worker deploy runs the migrations; the public surface goes last),
  and Express should be unlisted for the window.
- **Reconcile the stuck `accepted` task** — settle its payment/refund state.
  Closing an unresolved financial record is not the same as resolving it (Ishita).
- **Drop Firm Projects from `#7138`** so the listing offers only what a reviewer
  can actually buy (Ishita).
- **Request David's re-test** — only after all of the above. The currently
  deployed worker still reproduces his round-2 finding.

## Evidence to Attach

- Local gateway-worker smoke showing `get_quote -> execute -> get_status -> get_result`.
- Worker refund smoke showing `failed_refunded` and SIMULATED refund tx in local mode.
- Real payment spike tx after Poulav/human-triggered live run.
- Real vendor-index generation timestamp after marketplace scan.
- Screenshot or recording of provenance receipt with fired vendor and absorbed margin.
