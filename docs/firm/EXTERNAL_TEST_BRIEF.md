# Independent test brief — Firm Express (ASP #7138)

Send this to your tester as-is; add your own note on top. It is self-contained:
they need no repository access, no internal logs, and no contact with the team
while testing.

---

## What you're testing

**Firm Express** — a paid API on the OKX.AI marketplace (agent #7138). You pay
0.1 USDT on X Layer over the x402 protocol; it buys a raw price series from a
third-party data agent, derives a market snapshot (price action, trend,
support, resistance), validates it, and only then settles your payment. If it
cannot deliver, you are not charged.

## For this to count as an independent test

- Use **your own** OKX Agentic Wallet or a local wallet you control.
- Fund it with USDT (X Layer) from a source unrelated to the Firm team.
  ~0.15 USDT is plenty. You will not be reimbursed — that is the point.
- **Pick your own symbol, timeframe, and test time. Do not tell the team in
  advance.** Supported: BTC or ETH; 1h, 2h, 4h, or 1d.
- Keep the raw responses and transaction hashes.

## Step 1 — free validation (no payment)

```bash
onchainos agent x402-check \
  --endpoint https://firm-gateway.fly.dev/ \
  --body '{"symbol":"ETH","timeframe":"1d","prompt":"short snapshot: trend, momentum, key levels"}'
```

Expect `valid: true`, price 0.1, asset `0x779ded…3736` (USD₮0), `eip155:196`.

## Step 2 — quote, then pay

```bash
onchainos payment quote https://firm-gateway.fly.dev/ \
  --method POST \
  --param symbol=ETH --param timeframe=1d \
  --param "prompt=short snapshot: trend, momentum, key levels"

# review the 0.1 USDT quote, then:
onchainos payment pay --payment-id <PAYMENT_ID> --selected-index 0 --yes \
  --param symbol=ETH --param timeframe=1d \
  --param "prompt=short snapshot: trend, momentum, key levels"
```

(Substitute your own symbol/timeframe throughout.)

## Step 3 — what a pass looks like

Confirm each of these yourself; HTTP 200 alone proves nothing:

- [ ] `status: success` and a **non-empty buyer `txHash`**
- [ ] Output names **your** symbol and timeframe, and answers **your** prompt
- [ ] Contains price action, trend, support, and resistance
- [ ] `receipt.validation.passed: true`
- [ ] Vendor is OKLink agent `2023` with a **non-empty `vendor_tx`**
- [ ] Both transactions succeed on the X Layer explorer, and the small vendor
      transfer (15 units) lands **before** your 100000-unit settlement
- [ ] The receipt's arithmetic: `100000 = 15 + 99985` (vendor cost + margin)

## If it fails

The honest failure mode is **HTTP 503 with `retriable: true` and an empty
txHash** — meaning you were never charged. If you are ever charged without
receiving a matching deliverable, that is a defect the team wants to know
about immediately, with the tx hash.

## Afterwards

Share with the team (and feel free to publish): the full JSON response, both
tx hashes, and the time you tested. Your wallet address will be visible on
chain as the payer — that is what makes this evidence someone outside the
team paid and received value.
