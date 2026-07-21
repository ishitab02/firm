# The State of the OKX Agent Economy

### What 95 live endpoint probes found

_Measured 2026-07-21. Every figure below is computed from
`data/marketplace-health-2026-07-21.json` by `tools/vendor-report/health-report.js` — none of it is typed by hand._

---

## Method

One unpaid HTTP POST to the first endpoint-bearing service each agent
publishes, then read whatever comes back. A conformant x402 seller answers
`402` with a challenge stating its price; that challenge is the ground truth
for what the service actually costs.

**Nothing was signed and nothing was spent.** No agent was charged, and no
payment authorization was produced at any point. Reading a 402 is free — that
is what makes this measurable at all.

- Population: of **218** agents in our ten-query marketplace search snapshot, **95** publish an
  A2MCP service with an HTTP endpoint. The rest are A2A-only or list no
  service in that snapshot.
- Request body: the service's documented literal example when one can be parsed;
  otherwise `{}`. An HTTP error can therefore mean missing or undocumented
  arguments/method semantics, not necessarily dead infrastructure.
- Up to 2 attempts, retrying only on network-level failure. A cold-starting
  container is not a dead one, and one timeout is not evidence.
- Timeout: 12000ms.

Reproduce it:

```bash
pnpm -F @firm/procurer vet -- --index data/marketplace-scan.json --out health.json
```

**Caveat, stated up front:** this probes the *first* endpoint-bearing service
per agent, not all of them. An agent whose first endpoint is dead may have
live ones. The honest claim is "X% of endpoint-bearing agents have a dead
first endpoint", not "X% of services are dead". Endpoints also change — this
is a snapshot, and a re-run may differ.

---

## The headline

| | count | share |
|---|---:|---:|
| Probed | 95 | 100% |
| Reachable and x402-conformant | 47 | 49% |
| Returned 200 without an x402 challenge | 7 | 7% |
| **Dead or misrouted** | **41** | **43%** |

**41 of 95 (43%) failed this unpaid preflight.**
32 answered with an HTTP status other than a usable 200 or conformant 402.
That set includes missing-route responses as well as responses that may require
arguments or method semantics absent from the listing. 9 did not resolve,
refused the connection, or timed out after the configured retries.

For a buyer using only the public listing metadata, roughly two in five agents
could not be classified as callable by this preflight.

---

## Prices that do not match their listing

The listing states a price. The live 402 states a price. They are not always
the same number, and the gap is not small.

| agent | listed | live 402 demands | ratio |
|---|---:|---:|---:|
| #3209 Clawby | 0.005 USDT | 3.0 USDT | **600×** |
| #6560 SignalForge AI | 0.01 USDT | 0.5 USDT | **50×** |
| #5169 Alpha Radar | 0.1 USDT | 0.5 USDT | **5×** |
| #2080 MarketBrew Stock Agent | 0.03 USDT | 0.1 USDT | **3.3333×** |
| #2626 X API MCP | 0.5 USDT | 0.9 USDT | **1.8×** |

**#3209 Clawby advertises 0.005 USDT and its live challenge
demands 3.0 USDT — 600 times the advertised price.**

An agent that reads the listing, trusts it, and signs whatever the challenge
asks would pay 600× its expected cost on a single call. Nothing in the
protocol prevents this: the buyer is the only party in a position to check.

The error runs both ways. 2 agent(s) charge *less* than they advertise —
for example #2013 CoinAnk OpenAPI, listed at
0.01 USDT and charging 0.001 USDT.

And 5 agents advertise a nonzero price but answer 200 without issuing
an x402 challenge:

- #2392 Icarus-AI miner — listed 0.5 USDT, returned 200 without a challenge
- #5540 DoraFusion AI — listed 1.0 USDT, returned 200 without a challenge
- #4203 DailyDigest — listed 0.05 USDT, returned 200 without a challenge
- #5939 宏观速递 · MacroPulse — listed 0.01 USDT, returned 200 without a challenge
- #5776 ScoutGate — listed 0.01 USDT, returned 200 without a challenge

The probe does not judge whether those 200 bodies contain a useful deliverable.
They may be free despite the listing, or they may be non-billable/error responses;
a paid semantic check would be required to distinguish the two.

---

## A protocol detail worth flagging

Of the 47 conformant sellers, only **6** declare the decimal scale of the
asset they price in.

This matters more than it looks. `15` means nothing without knowing whether it
is 15 units of a 6-decimal token or an 18-decimal one — those differ by a
factor of a trillion. A buyer comparing a price against a spending limit is
comparing raw integers, and if the scales differ the comparison is not merely
wrong, it is wrong in the permissive direction.

The safe reading is to treat an undeclared scale as *known* only when the
buyer has itself pinned the asset and chain in advance, and to refuse
otherwise. Requiring sellers to declare it would break most of the market.

---

## What this says about the market

These are early-market failure modes, not bad actors. Endpoints rot, hosting
sleeps, prices get updated in one place and not the other. Every young
marketplace looks like this, and most of it is fixable by the platform:
periodic health checks, rejecting listings whose live price disagrees with
their advertised one, and requiring a declared decimal scale would remove
most of what is measured above.

Until then the checking has to happen somewhere, and the only party with an
incentive to do it is whoever is about to spend the money.

That is the position The Firm occupies: it verifies live commercial terms
before signature, validates outcomes after, absorbs the cost of replacing
failures, and publishes the evidence. The dataset above is what its own
background check produces, run across the whole marketplace instead of one
job's candidates.

---

## Raw data

- `data/marketplace-health-2026-07-21.json` — every probe result, with verdict, latency, attempts, and both prices
- `data/marketplace-scan.json` — the underlying agent scan
- `packages/procurer/src/vet.ts` — the prober, MIT licensed, no key required

Corrections welcome. If an agent below is listed as dead and is not, the
probe result and its timestamp are in the JSON — send it back and it will be
re-run.

## Full results

| status | agent | listed | live | ratio | ms |
|---|---|---:|---:|---:|---:|
| **failed** | #1888 Hunch Research | 0.000001 USDT | — | — | 674 |
| ok | #2095 项目研究所 | 0.1 USDT | 0.1 USDT | 1× | 887 |
| **failed** | #2143 Predexon | 0.01 USDT | — | — | 484 |
| **failed** | #5082 Proof of Behavior | 0.1 USDT | — | — | 24 |
| **failed** | #5898 PREX · 短线分析 | 0.01 USDT | — | — | 882 |
| **failed** | #5047 Argus | 0.1 USDT | — | — | 125 |
| **failed** | #3733 Scope | 0.3 USDT | — | — | 24 |
| ok | #2567 EdgePulse CN | 0.1 USDT | 0.1 USDT | 1× | 356 |
| ok | #5311 LiquidityDesk | 0.1 USDT | 0.1 USDT | 1× | 376 |
| ok | #3837 OKB Monitoring | 0.01 USDT | 0.01 USDT | 1× | 990 |
| **failed** | #6234 Scope Guard Agent Safety | 0.0 USDT | — | — | 3 |
| ok | #5127 EdgeProof | 0.15 USDT | 0.15 USDT | 1× | 372 |
| **failed** | #3601 CollabShield | 1.0 USDT | — | — | 794 |
| **failed** | #5149 Serenity 美股瓶颈与收益研报 | 1.0 USDT | — | — | 5 |
| ok | #5077 DeepBrief | 0.05 USDT | 0.05 USDT | 1× | 222 |
| ok | #4990 TapeRead | 0.01 USDT | 0.01 USDT | 1× | 673 |
| ok | #2940 Lyra | 0.5 USDT | 0.5 USDT | 1× | 279 |
| ok | #3089 fold | 0.01 USDT | 0.01 USDT | 1× | 534 |
| **failed** | #5812 TORTILLA Flow Intel | 0.0 USDT | — | — | 573 |
| free | #2392 Icarus-AI miner | 0.5 USDT | 0.0 USDT | — | 381 |
| ok | #4848 美股 · Alpha猎手 | 0.1 USDT | 0.1 USDT | 1× | 633 |
| **failed** | #4137 ASP赛道情报 · NicheScope | 0.5 USDT | — | — | 612 |
| ok | #5010 QuantPulse Daily | 2.99 USDT | 2.99 USDT | 1× | 529 |
| ok | #3824 链上研究解析助手 | 0.05 USDT | 0.05 USDT | 1× | 529 |
| ok | #4287 TRUTH-PROTOCOL | 0.05 USDT | 0.05 USDT | 1× | 212 |
| **failed** | #4835 RouteRiskFirewall | 0.0 USDT | — | — | 1048 |
| free | #5540 DoraFusion AI | 1.0 USDT | 0.0 USDT | — | 654 |
| **failed** | #3130 链眼 | 2.0 USDT | — | — | 605 |
| **failed** | #3191 SignalLens AI | 1.0 USDT | — | — | 636 |
| ok | #5128 CycleProof | 0.15 USDT | 0.15 USDT | 1× | 178 |
| ok | #5191 SetupProof | 0.15 USDT | 0.15 USDT | 1× | 164 |
| **failed** | #5781 Prism AI | 0.5 USDT | — | — | 828 |
| ok | #5234 Quorum | 0.3 USDT | 0.3 USDT | 1× | 745 |
| **failed** | #4609 OnchainAI | 0.1 USDT | — | — | 136 |
| ok | #4462 MacroLens | 0.01 USDT | 0.01 USDT | 1× | 199 |
| over | #2080 MarketBrew Stock Agent | 0.03 USDT | 0.1 USDT | 3.3333× | 466 |
| **failed** | #6260 Argus | 0.0 USDT | — | — | 914 |
| free | #5996 RugCheck AI | 0.0 USDT | 0.0 USDT | — | 382 |
| **failed** | #4683 草台班子 | 0.05 USDT | — | — | 382 |
| **failed** | #2562 VortexMarketAnalysis | 0.01 USDT | — | — | 1421 |
| ok | #5005 DeepReview | 0.1 USDT | 0.1 USDT | 1× | 1195 |
| **failed** | #5055 港股打新 · Alpha雷达 | 0.1 USDT | — | — | 686 |
| ok | #4980 Covered Call Copilot | 0.05 USDT | 0.05 USDT | 1× | 202 |
| **failed** | #4605 ChainKun | 0.5 USDT | — | — | 664 |
| **failed** | #3706 爆款内容方法论 | 0.3 USDT | — | — | 6 |
| ok | #2100 预测市场眼 | 0.2 USDT | 0.2 USDT | 1× | 248 |
| free | #4203 DailyDigest | 0.05 USDT | 0.0 USDT | — | 589 |
| ok | #2721 rootAI | 0.01 USDT | 0.01 USDT | 1× | 924 |
| ok | #3369 WhalePulse Analytics | 0.5 USDT | 0.5 USDT | 1× | 799 |
| ok | #3619 易经六爻占事 | 0.5 USDT | 0.5 USDT | 1× | 819 |
| ok | #5012 Taco Boss | 1.0 USDT | 1.0 USDT | 1× | 718 |
| ok | #4989 DepthCharge | 0.01 USDT | 0.01 USDT | 1× | 134 |
| **failed** | #6442 Token DD Desk | 0.0 USDT | — | — | 564 |
| ok | #4537 VenueScan | 0.01 USDT | 0.01 USDT | 1× | 167 |
| ok | #5069 HashWatch | 0.01 USDT | 0.01 USDT | 1× | 141 |
| ok | #3646 Eastern Face Reading | 1.0 USDT | 1.0 USDT | 1× | 1058 |
| ok | #4045 鲸迹研判 | 0.05 USDT | 0.05 USDT | 1× | 685 |
| over | #5169 Alpha Radar | 0.1 USDT | 0.5 USDT | 5× | 717 |
| **failed** | #5628 Meridian Signal | 0.01 USDT | — | — | 210 |
| **failed** | #3991 坐标智研 | 0.1 USDT | — | — | 7 |
| free | #5939 宏观速递 · MacroPulse | 0.01 USDT | 0.0 USDT | — | 537 |
| **failed** | #2301 Onchain Alpha Lab | 0.06 USDT | — | — | 793 |
| **failed** | #5805 AlphaChef Signal Feed | 0.0 USDT | — | — | 621 |
| ok | #5977 QuantRefine | 0.5 USDT | 0.5 USDT | 1× | 342 |
| ok | #5524 API2ASP Factory | 0.01 USDT | 0.01 USDT | 1× | 761 |
| ok | #5557 Pitchook | 0.1 USDT | 0.1 USDT | 1× | 699 |
| **failed** | #3118 CoinWM Open API | 0.003 USDT | — | — | 963 |
| over | #2626 X API MCP | 0.5 USDT | 0.9 USDT | 1.8× | 303 |
| **failed** | #3590 x402node | 0.008 USDT | — | — | 756 |
| **failed** | #2917 MarketContext API | 0.1 USDT | — | — | 491 |
| ok | #6142 APA | 0.0 USDT | 0.0 USDT | — | 624 |
| **failed** | #5175 Lumora Stock Data Hub | 0.0 USDT | — | — | 8 |
| ok | #2013 CoinAnk OpenAPI | 0.01 USDT | 0.001 USDT | 0.1× | 217 |
| ok | #2023 Onchain Data Explorer | 0.000075 USDT | 0.000075 USDT | 1× | 263 |
| over | #3209 Clawby | 0.005 USDT | 3.0 USDT | 600× | 704 |
| ok | #5314 ExchangeFlowDesk | 0.2 USDT | 0.1 USDT | 0.5× | 213 |
| **failed** | #2652 RitMEX | 0.01 USDT | — | — | 803 |
| **failed** | #4636 MacroPulse · 宏观市场脉搏 | 0.1 USDT | — | — | 1040 |
| **failed** | #4543 健康生活 | 0.01 USDT | — | — | 290 |
| free | #6706 OutdoorWindow | 0.0 USDT | 0.0 USDT | — | 262 |
| ok | #3762 Web3 · 金融助手 | 0.5 USDT | 0.5 USDT | 1× | 1193 |
| **failed** | #6707 WhereWhen | 0.0 USDT | — | — | 226 |
| ok | #3977 Leo Labs | 0.1 USDT | 0.1 USDT | 1× | 373 |
| over | #6560 SignalForge AI | 0.01 USDT | 0.5 USDT | 50× | 443 |
| ok | #2364 AxiomAI | 6.6 USDT | 6.6 USDT | 1× | 788 |
| **failed** | #2134 Predict Protocol | 0.3 USDT | — | — | 11 |
| **failed** | #4171 FindNextTrade | 0.0 USDT | — | — | 308 |
| **failed** | #4043 ChainAlmanac | 0.05 USDT | — | — | 780 |
| **failed** | #3894 Bit Monk | 0.01 USDT | — | — | 251 |
| ok | #4611 Wallet Health Report | 0.01 USDT | 0.01 USDT | 1× | 336 |
| **failed** | #5421 PixelBrief | 0.25 USDT | — | — | 1145 |
| free | #5776 ScoutGate | 0.01 USDT | 0.0 USDT | — | 629 |
| ok | #3345 这个能吃吗？ | 0.01 USDT | 0.01 USDT | 1× | 794 |
| ok | #2135 Newsliquid | 0.002 USDT | 0.002 USDT | 1× | 354 |
| **failed** | #2012 Barker Yield Agent | 0.001 USDT | — | — | 337 |

