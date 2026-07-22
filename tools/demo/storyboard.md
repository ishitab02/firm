# 90-second storyboard and voiceover

Rewritten 2026-07-22. The previous cut carried a `SIMULATED` failure sequence
because no real one existed. One does now — a paid job that hired five vendors,
fired all five, refunded the buyer automatically and absorbed the cost — so the
most important twenty seconds of this video are real footage instead of a
labelled reconstruction. Nothing in this cut needs a SIMULATED badge.

Record the terminal at roughly 110 columns. The integrity labels in the command
output are part of the story; keep them legible in the final cut.

**One disclosure that must stay on screen.** Every purchase shown was made from
our own wallet as QA. It is evidence the machine runs, not a customer. Where a
buyer appears, the badge reads `OUR OWN WALLET · QA` — never "customer". A judge
who goes looking for an undisclosed self-purchase should find nothing, because
there is nothing to find.

---

## 0:00–0:08 — Hook

**Screen:** title, then the first lines of the demo command.

**Voiceover:** "OKX gives one founder an agent workforce. Nobody checks whether
those workers are alive, honest about price, or any good. We built the employer."

## 0:08–0:26 — The background check, live and unpaid

**Screen:** `LIVE / UNPAID`. Hold on the worst live mismatch and the
pre-signature refusal.

**Voiceover:** "Before spending anything, The Firm reads each candidate's live
payment challenge. Nothing is signed. This one lists 0.005 USDT and demands 3 —
six hundred times more — so The Firm refuses before a signature exists."

Narrate whatever the run actually prints. Do not say "six hundred times" unless
that run prints it.

## 0:26–0:38 — What the probe found

**Screen:** the July 21 snapshot lines.

**Voiceover:** "We probed every endpoint-bearing agent on the marketplace —
ninety-five of them. Forty-one failed unpaid preflight. Nothing was signed and
nothing was spent."

## 0:38–0:52 — A buyer pays, and it settles

**Screen:** the 402 challenge, then the settle receipt and its X Layer hash.
Badges: `REAL · SETTLED` and `OUR OWN WALLET · QA`.

**Voiceover:** "A buyer calls the endpoint and gets a price. They pay it. OKX's
facilitator settles it on X Layer. This purchase is ours — we bought from
ourselves to prove the path, and we label it that way."

## 0:52–1:12 — It fails, and the guarantee pays out. Real.

**Screen:** the progress log, one vendor per line, firing in sequence. Then the
refund transaction.

**Voiceover:** "Then the work goes wrong. The Firm hires, pays a vendor, and the
result fails validation. It fires that vendor and hires the next. Five in a row
fail. So it refunds the buyer in full, automatically, and absorbs the vendor
cost out of its own margin. Nobody triggered that. It is what the fixed price
buys."

The most important beat in the video. Hold on the fired-vendor lines long enough
to read them, and on `DELIVERY_FAILED_REFUNDED` with the refund hash. Two
on-chain transactions sixteen blocks apart: money in, money back.

Worth saying out loud if there is room: our own probe predicted this. We
published that 43% of these endpoints were dead, then tried to buy from them and
watched it happen.

## 1:12–1:24 — And when it works

**Screen:** the completed run — real ETF holdings returning inline — then the
economics block.

**Voiceover:** "Stop ranking dead endpoints above live ones, and the same job
completes in twelve seconds with real market data. Price, a tenth of a dollar.
Vendor cost, a thousandth. The rest is margin, and every line reconciles against
the chain."

```
user price            100000
vendor costs         −  1000
─────────────────────────────
margin retained         99000
```

## 1:24–1:30 — Close

**Screen:** near-black. One line.

**Voiceover:** "Someone has to check first. That's the job."

---

## What must NOT appear in this cut

- Any framing of a QA purchase as customer revenue, demand or traction.
- The word "Darwinian". The ledger holds nine vendors scored from real paid
  outcomes, which is worth showing — but a vendor's score demoting it on a
  *later* job has not been demonstrated, so the claim is "adaptive fallback with
  accumulated performance evidence".
- Firm Projects, while it is registered on the listing and failing `x402-check`.
- Any transaction hash not verifiable on X Layer at the moment of filming.
