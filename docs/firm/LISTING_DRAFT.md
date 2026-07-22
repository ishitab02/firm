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

Endpoint: `https://firm-gateway.fly.dev/projects`
Price: **1 USDT** (`1000000` base units).

Two to four BTC/ETH market-analysis legs across `1h`, `2h`, `4h` or `1d`. Each
leg hires OKLink #2023 separately for its own price series. Results are
validated per leg and assembled **only if every leg passes**; otherwise the
buyer is refunded in full and the Firm absorbs the vendor cost.

Required input: a `goal` naming assets and timeframes, a `budget_cap` in
6-decimal USDT base units, and optional `constraints`. A single-leg request is
refused with a pointer to Express; an unsupported goal is refused before any
money moves. Every unpaid request receives a 402 challenge first.

## Pricing, and how to answer the margin question

Someone will divide our price by our vendor cost. Have the answer ready.

Across the 129 service prices in our own marketplace scan: p25 `10,000`,
**median `100,000`**, p75 `300,000`, max `6,600,000`. The most common price
points are 10,000 (33 services), 100,000 (24), 500,000 (17), 50,000 (13) and
1,000,000 (8).

**Express at 0.1 USDT is exactly the marketplace median. Projects at 1 USDT is
a price eight other listed services already charge.** We price at market.

The ratio looks extreme (~6,700x for Express) because OKLink sells raw data for
15 units, *below the 25th percentile of the entire market*. That measures how
cheap OKLink is, not how expensive we are. Do not repeat the old "~10x premium"
line — it assumed a 10,000-unit vendor cost that turned out to be 15.

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

Also cleared (2026-07-23):

- ~~Three-component maintenance deployment~~ — procurer v5, worker v10, gateway
  v12 all shipped; Express buys from OKLink in production and one purchase is
  verified on chain.
- ~~**Drop Firm Projects**~~ — **REVERSED, do not drop it.** Projects is now a
  distinct working product at `/projects`, not a broken duplicate of Express:
  2–4 legs, per-leg vendor purchase, all-or-nothing assembly, and it authorizes
  → validates → settles rather than charging up front. `x402-check` returns
  `valid: true` on a bare `{}` body.
- ~~Wallet rotation before submitting~~ — decided: ship now, rotate after the
  deadline. Recorded as an accepted risk in `docs/status/F1.md`. `0xC029…50e0`
  must not accumulate meaningful value before it is rotated.

Open:

- **No live 1 USDT Projects purchase has ever run.** Express was listed and
  technically valid while returning BTC data for ETH requests — that is exactly
  how round 2 happened. A passing validator is not a working product. Do not
  point service 36228 at `/projects` until one real purchase completes.
- **Point service 36228 at `/projects`** — it currently points at the Express
  root URL (Ishita), after the purchase above.
- **Reconcile the stuck `accepted` task** — settle its payment/refund state.
  Closing an unresolved financial record is not the same as resolving it (Ishita).
- **Request David's re-test** — only after all of the above.
- **No external customer has ever bought anything.** Every purchase to date was
  ours. This is the largest remaining gap in the entry and David's re-test is
  the most likely thing to close it.

## Evidence to Attach

- Local gateway-worker smoke showing `get_quote -> execute -> get_status -> get_result`.
- Worker refund smoke showing `failed_refunded` and SIMULATED refund tx in local mode.
- Real payment spike tx after Poulav/human-triggered live run.
- Real vendor-index generation timestamp after marketplace scan.
- Screenshot or recording of provenance receipt with fired vendor and absorbed margin.
