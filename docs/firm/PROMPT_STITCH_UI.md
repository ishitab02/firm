# Prompt for Google Stitch — The Firm demo surface

**Scope discipline, read first.** This is a *demo surface*, not a product
surface. Its only job is to make a 90-second video look like the work it
represents. It is not a dashboard, not a console, not a thing users navigate.
Every screen below exists because it is a beat in the video.

Build it **after the OKX listing is submitted**, never before. If the listing is
still unsent, close this file.

**Non-negotiable:** every number in this UI is real and already measured. Do not
invent metrics to fill a chart, do not mock a transaction hash, and render
anything simulated with the explicit `SIMULATED` treatment described below. The
entire pitch is that this team does not fabricate evidence; a fabricated UI
would destroy the thing it is meant to showcase.

---

Copy everything below the line into Google Stitch.

---

Design a dark, cinematic single-page web experience for a product called
**The Firm** — an autonomous AI agent that hires other AI agents, checks them
before paying, and guarantees the result.

## Tone

Bloomberg terminal crossed with a Swiss annual report. Institutional, exact,
slightly menacing. This is financial infrastructure, not a crypto startup — so
no neon gradients, no glassmorphism, no floating 3D blobs, no cartoon mascots.
The luxury comes from restraint, precision, and motion, not decoration.

Think: the confidence of a firm that sends invoices.

## Palette

- Base: near-black `#07080A`, with a second surface at `#0E1013`
- Text: `#F2F3F5` primary, `#8B9099` secondary
- Signal green `#00E08A` — used ONLY for verified/real things
- Alert amber `#FFB020` — used ONLY for refusals and warnings
- Dead grey `#4A4F57` — used ONLY for dead endpoints
- One accent: deep ink blue `#1B3A6B` for depth and glow

Colour carries meaning here. A judge should learn the code in five seconds and
never see it violated.

## Typography

- Display: a tight grotesque (Neue Haas / Inter Tight), heavy weights, negative
  tracking, very large
- Data: a monospace (JetBrains Mono / Berkeley Mono) for every number, address,
  hash and price — money must always look like money
- Numbers animate by counting up, never by fading in

## Motion — the part that matters

**Background.** A slow parallax field of faint concentric rings, like a radar
sweep or an order book depth chart, drifting at three depths as the user
scrolls. Beneath it, a barely-visible animated grid that subtly warps toward the
cursor. It should feel alive but never demand attention. 8–12 second loops, no
sudden movement.

**Scroll.** Section-snapped, with content assembling rather than sliding:
elements arrive on staggered 60ms delays, rising 24px with a 400ms cubic-bezier
ease. Statistics count up as they enter. Long numbers use a slot-machine roll.

**Hover.** Every interactive row lifts 2px, gains a 1px signal-coloured border,
and reveals its detail line in place. Vendor rows expand inline to show the
live 402 challenge. Cursor gets a subtle magnetic pull toward primary actions.

**Transitions.** A thin scanline sweeps across a panel when its state changes,
as if a terminal repainted. Never a spinner — use a pulsing monospace caret.

## Sections, in order

### 1. Hero

Full viewport. Enormous headline, left-aligned, three lines:

> **The marketplace has**
> **sixty workers**
> **and no employer.**

Below it, one line of secondary text: *The Firm is the employer.*

Bottom-anchored, a live status strip in monospace, always visible:

```
● LIVE   firm-gateway.fly.dev   x402-check: valid   X Layer · USD₮0
```

The `●` pulses signal green. Behind everything, the parallax radar field.

### 2. The problem — a live scoreboard

The emotional core. Three enormous counting numbers on near-black:

```
    43%              600×               95
 dead or         worst price       agents probed
 misrouted        mismatch          unpaid
```

Under them, one line: *We probed every endpoint-bearing agent on the
marketplace. Nothing was signed. Nothing was spent.*

Then a dense monospace table, one row per agent, that fills in row by row on
scroll as if the scan were running live — each row arriving 40ms after the last:

| status | agent | listed | live | ratio |
|---|---|---|---|---|
| ● OK | #2023 Onchain Data Explorer | 15 | 15 | 1× |
| ● OK | #2013 CoinAnk OpenAPI | 10000 | 1000 | 0.1× |
| ▲ STOP | #3209 Clawby | 5000 | 3000000 | **600×** |
| ▲ STOP | #6560 SignalForge AI | 10000 | 500000 | 50× |
| ○ DEAD | #2012 Barker Yield Agent | 1000 | — | — |
| ○ DEAD | #2143 Predexon | 10000 | — | — |

Dead rows render in dead-grey at 40% opacity. The Clawby row is amber and, when
it arrives, holds for a beat while the `600×` counts up dramatically. Hovering
it expands to show the raw 402 challenge in monospace.

### 3. The refusal — the single best moment

A focused panel, almost cinematic. Sequenced text appearing line by line like a
terminal, with the caret blinking between lines:

```
  hiring #3209 Clawby ...
  listed price          0.005 USDT
  live 402 demands      3.000 USDT       ▲ 600×
  buyer ceiling         0.050 USDT
  ─────────────────────────────────────
  REFUSED before signature
  no signature produced · no money moved
```

`REFUSED` lands hard: a scanline sweep, then it settles in amber. Below, in
small secondary text: *The vendor is not penalised. It answered correctly — the
decision was ours.*

This is the whole product in one panel. Give it room.

### 4. How it works — a horizontal parallax rail

Six stages that move horizontally as the user scrolls vertically. Each is a card
that comes into focus as it centres and dims as it leaves:

**Quote** → **Source** → **Vet** → **Procure** → **Validate** → **Deliver**

Each card: a one-line description, and one real detail in monospace. The Vet
card shows `0 paid · 0 signatures`. The Procure card shows a real transaction
hash. Cards tilt slightly toward the cursor on hover.

### 5. Proof — real money

Two transaction cards, side by side, monospace, treated like certificates:

```
  X LAYER · CONFIRMED
  0x493a34a5…f26072
  15 base units USD₮0  →  OKLink #2023
```

Each links to the explorer. A signal-green `REAL` badge sits in the corner.

Directly beside them, deliberately and visibly different — dashed border, amber
`SIMULATED` badge, reduced opacity — any simulated element. **The visual
distinction between REAL and SIMULATED must be obvious at a glance from across
a room.** This is the most important design constraint on the page.

Below, one honest line in secondary text:

> Two real third-party procurement transactions. Zero customer revenue so far.

### 6. The receipt

A provenance receipt rendered like a printed document on dark paper — generous
margins, hairline rules, monospace figures right-aligned in a column so they
reconcile visually:

```
  user price              100000
  vendor costs           − 15
  books (simulated)      − 0
  ───────────────────────────────
  margin retained          99985
```

The rule above the total draws itself left to right as it enters view.

### 7. Close

Return to near-black. One line, very large:

> **Someone has to check first.**

Then, small: *That is the job.*

The live status strip from the hero remains pinned at the bottom throughout the
entire page.

## Requirements

- Responsive, but design for a 16:9 screen recording first — this will be filmed
- 60fps motion; prefer transforms and opacity over layout animation
- Respect `prefers-reduced-motion`: keep the content, drop the parallax
- No stock photography, no illustrations, no icon sets. Type, rules, numbers and
  motion only
- Every hash, address, price and percentage is real data and must be rendered
  exactly as given — never rounded for aesthetics
