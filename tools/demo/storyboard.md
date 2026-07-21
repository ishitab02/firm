# 90-second storyboard and voiceover

Run `pnpm -F @firm/demo film:paced`. Record the terminal at roughly 110
columns. The labels in the command output are part of the integrity story; keep
them visible in the final cut.

## 0:00–0:08 — Hook

**Screen:** Firm logo/title, then the first three lines from the demo command.

**Voiceover:** “OKX gives one founder an agent workforce. But who checks that
workers are alive, honest on price, and useful? We built the employer.”

## 0:08–0:30 — Live background check

**Screen:** `LIVE / UNPAID`. Let the current shortlist probe run. Hold on the
worst live mismatch and the pre-signature refusal.

**Voiceover:** “Before spending, The Firm probes each candidate’s live endpoint
and reads its payment challenge. This is live; nothing is signed. This vendor
lists 0.005 USDT but asks 3 USDT—600 times more—so The Firm refuses before money
moves.”

If the vendor fixes its price before recording, narrate the current output. Do
not reuse “600 times” unless that run prints it.

## 0:30–0:42 — Research result

**Screen:** `JULY 21 SNAPSHOT / UNPAID` lines.

**Voiceover:** “Our July 21 ten-query search snapshot found 95 endpoint-bearing
agents among 218. Forty-one failed unpaid preflight: nine unreachable and 32
unusable HTTP responses. Seven returned 200 without a challenge; five of those
advertised nonzero fees.”

## 0:42–0:57 — Real payment evidence

**Screen:** `REAL / SETTLED`, the two hashes, and their OKLink links.

**Voiceover:** “The buyer path is real: two settled X Layer payments to OKLink’s
marketplace agent, including one from the full worker graph. A retry reused the
receipt instead of paying twice. These are procurement costs, not revenue.”

## 0:57–1:18 — Failure guarantee

**Screen:** `SIMULATED`, then the compact fixture sequence and economics.

**Voiceover:** “This failure is explicitly simulated; we will not fabricate a
real vendor incident. The Firm quotes a fixed price, rejects a low-trust
candidate, fires invalid output, replaces the vendor, and absorbs the extra
cost. The customer still gets one result at the quoted price.”

## 1:18–1:30 — Close

**Screen:** `THE PRODUCT` final four lines, then the live Firm listing or
submission card added during editing.

**Voiceover:** “One goal, one budget, one accountable result—with live checks,
capped payments, and a receipt showing who worked and what it cost. The Firm is
the agent economy’s prime contractor.”

Do not show a fake refund, call outbound spend revenue, or imply the simulated
fallback was a production incident. If a genuine inbound customer payment lands
before recording, add it as a separate `REAL / CUSTOMER` card; otherwise say
nothing about revenue.
