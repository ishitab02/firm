# G3 — first live payment from the DEPLOYED procurer

**Prepared 2026-07-22. Not fired.** Every real-money step here is human-triggered
per the standing rule; this file exists so the operator runs a checked command
rather than composing one under pressure.

## What G3 proves that G1/G2 did not

G1 and G2 were real payments, but they were signed by the `onchainos` CLI on
Poulav's Mac. That path cannot exist in production: the CLI is a macOS-only
binary whose Agentic Wallet login is browser-based, so the container could hold
a funded key and still be unable to spend.

The money path now signs in-process (viem, EIP-3009). `verify-signing` proves
the *token* accepts a signature this code produces — but no **vendor** has yet
accepted and redeemed one. Until G3, "production can move money" is inference.

G3 is one payment, from the deployed procurer, to a real third-party agent.

## Preconditions

- [ ] Branch merged and pushed.
- [ ] `pnpm -F @firm/procurer test` green (118), and the 20 reservation tests
      green against a real Postgres.
- [ ] `pnpm -F @firm/procurer verify-signing` prints **ACCEPTED** for the valid
      signature and **reverted** for the tampered one. Both, or stop — a pass
      without the negative control proves nothing.
- [ ] `0xC029…50e0` holds USD₮0 for the payment. Last observed: 1.680248.
- [ ] `0xC029…50e0` holds native OKB **for refunds only** — payments need none,
      because the vendor's relayer pays that gas. Last observed 6.0e12 wei,
      roughly four refunds' headroom at 2.0e7 wei/gas.

## Step 1 — config the new signer needs

`fly.procurer.toml` `[env]` additions. None of these are secret:

```toml
  X402_RPC_URL_196      = "https://rpc.xlayer.tech"
  REFUND_CHAIN          = "196"
  REFUND_TOKEN_CONTRACT = "0x779ded0c9e1022225f8e0630b35a9b54be713736"
  REFUND_FROM_ADDRESS   = "0xC0296012Cfbb0e6DF5dA7158B65Dbc46DD9650e0"
```

`REFUND_FROM_ADDRESS` must equal the address `FIRM_WALLET_KEY` derives to. It is
checked at refund time and a mismatch refuses to send — it guards the wrong key
reaching production, which would otherwise refund customers from an unintended
wallet with every log line looking normal.

## Step 2 — the key, as a secret

```bash
fly secrets set -a firm-procurer --stage \
  FIRM_WALLET_KEY="0x…"
```

`--stage` so it is not applied until the deploy below. The key is never in the
repo, never in `[env]`, never in argv.

## Step 3 — arm payments only. NOT refunds.

Deliberately asymmetric for this run. `REAL_PAYMENTS_ENABLED=true` with
`REAL_REFUNDS_ENABLED=false` puts `/refund` into `REQUIRES_HUMAN`, which returns
the exact manual command instead of sending — see `refundMode`. G3 is about
proving the payment leg; arming an unexercised refund path at the same time
would mean two untested things moving money on the same deploy.

In `fly.procurer.toml`:

```toml
  REAL_PAYMENTS_ENABLED = "true"
  REAL_REFUNDS_ENABLED  = "false"
```

The procurer refuses to start with real payments on unless **both** x402
allow-lists are set. They already are (`X402_ALLOWED_ASSETS`,
`X402_ALLOWED_NETWORKS`), so a boot failure here means one was lost — fix that,
do not relax the check.

## Step 4 — deploy the procurer ALONE

```bash
fly deploy --config fly.procurer.toml
```

Safe with respect to the listing: the procurer has no public IP, and the gateway
does not reference it yet (`PROCURER_URL` unset), so nothing changes for anyone
hitting `firm-gateway.fly.dev`. **Do not deploy the gateway in the same step.**

Confirm what actually shipped:

```bash
fly ssh console -a firm-procurer -C \
  "node -e \"fetch('http://[::1]:8787/health').then(r=>r.text()).then(console.log)\""
```

Expect `real_payments_enabled: true`, `wallet_key_present: true`,
`real_refunds_enabled: false`.

## Step 5 — the payment. Human fires this.

Vendor: **OKLink Onchain Data Explorer #2023**, the agent G1 and G2 paid.
15 base units USD₮0 (0.000015), well under the 1 USDT per-call cap.

```bash
fly ssh console -a firm-procurer -C "node -e \"
fetch('http://[::1]:8787/pay-and-call', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer ' + process.env.PROCURER_AUTH_TOKEN
  },
  body: JSON.stringify({
    task_id: 'G3',
    subtask_id: 'g3-first-deployed-payment',
    vendor_endpoint: 'https://www.oklink.com/api/v5/explorer/mcp/x402/get_address_balance_history',
    tool: 'get_address_balance_history',
    args: { chainIndex: '1', address: '0x0000000000000000000000000000000000000000', height: '21000000' },
    max_amount: { amount: '20', decimals: 6, token: 'USDT' }
  })
}).then(r => r.text()).then(console.log)
\""
```

Endpoint, tool and args are copied verbatim from the G1 request in
`LIVE_PAYMENT_RUNBOOK.md` §, which is known to have succeeded — deliberately
not re-derived. Note the endpoint already carries a path, so `toolUrl` uses it
verbatim rather than appending `/tools/<tool>`; that behaviour is pinned by a
unit test.

`max_amount` is 20 against a listed 15 — a small ceiling above the quote, so a
minor vendor-side price move does not fail the run, while staying far below the
per-call cap. If the vendor asks for more than 20 the call refuses **before**
signing; that refusal is a correct outcome, not a failure to work around.

## Step 6 — verify, and do not take the response's word for it

1. Response carries a `tx` and a settlement block.
2. The transaction exists on X Layer and moves USD₮0 from `0xC029…50e0`.
3. `procurer_calls` has exactly **one** row for
   `G3:g3-first-deployed-payment:…` in state `settled`.
4. **Re-fire step 5 verbatim.** It must replay the stored receipt and produce
   **no second transaction**. Two mechanisms should now prevent a double-pay —
   the Postgres idempotency row, and the derived EIP-3009 nonce making the
   token itself reject a replayed authorization. Confirm the row count is still
   one and no new tx appears on chain.

## If it fails

- `UNSUPPORTED_CHALLENGE` mentioning `DOMAIN_SEPARATOR` — the token's EIP-712
  domain could not be proven. Do **not** add an assumed domain; the refusal is
  the feature. Capture the message and the token address.
- `CAP_EXCEEDED` — working as designed. Read the amount before changing anything.
- Signature accepted by us but rejected by the vendor — the most interesting
  failure, and the reason G3 exists. Capture the vendor's exact response body
  and the `PAYMENT-RESPONSE` header verbatim before retrying anything.

## Rollback

Set `REAL_PAYMENTS_ENABLED = "false"` and redeploy. The wallet key can be left
staged; with payments off it is unused. Nothing that already settled is undone
by this — a completed payment is a completed payment.

## After G3

Only then consider the gateway: redeploying it with `PROCURER_URL` set is the
step that touches the endpoint under review, and it is what finally makes the
fulfilment guard active. Separate decision, separate runbook.
