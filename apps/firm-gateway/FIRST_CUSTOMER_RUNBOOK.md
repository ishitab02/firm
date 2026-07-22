# First external customer runbook

This is a closely monitored proof run, not an unattended launch procedure. It
must use a genuine external buyer. Neither team wallet may buy the service.

No step below authorizes a payment. The buyer must inspect and explicitly
confirm the charge before signing through the **OKX Agent Payments Protocol**.

## Production readiness gate

As verified on 2026-07-23, the public gateway charges only while the private
procurer reports real payments, real refunds, a loaded wallet, and sufficient
refund gas. Re-run the seller preflight immediately before any monitored buy;
do not rely on this dated observation.

The gateway refuses to start in charging mode unless those conditions hold.

## Seller preflight

Run these read-only checks from the operator's authenticated Fly session:

```bash
curl -sS https://firm-gateway.fly.dev/health

flyctl ssh console -a firm-gateway -C \
  'node -e "fetch(\"http://firm-procurer.internal:8787/health\",{headers:{authorization:\"Bearer \"+process.env.PROCURER_AUTH_TOKEN}}).then(async r=>console.log(r.status,await r.text()))"'

flyctl ssh console -a firm-gateway -C \
  'node -e "fetch(\"http://firm-procurer.internal:8787/caps\",{headers:{authorization:\"Bearer \"+process.env.PROCURER_AUTH_TOKEN}}).then(async r=>console.log(r.status,await r.text()))"'

flyctl machines list -a firm-worker
```

Required before asking the buyer to continue:

- Gateway reports `charging_mode: enforce`.
- Procurer reports `real_payments_enabled: true`.
- Procurer reports `real_refunds_enabled: true`.
- Procurer reports `wallet_key_present: true`.
- Per-call, per-task, daily-spend, and daily-refund capacity are sufficient.
- Exactly one worker is active.
- The refund wallet is funded and the human operator is prepared to refund the
  full 0.1 USD₮0 manually if automated recovery fails.
- `pnpm --dir apps/firm-gateway test` and `build` pass on the deployed commit.

Turning on payments, refunds, or wallet material is a human-triggered action.
This runbook does not do it.

## Exact customer request

Use the MCP request shape below. A bare body containing only `symbol`,
`timeframe`, and `prompt` does not select the `express_run` tool.

```json
{
  "jsonrpc": "2.0",
  "id": "external-1",
  "method": "tools/call",
  "params": {
    "name": "express_run",
    "arguments": {
      "symbol": "BTC",
      "timeframe": "4h",
      "prompt": "Return a concise current BTC market snapshot."
    }
  }
}
```

The gateway normalizes those three documented inputs into the single locked
`market_snapshot` job type. A bare body with the same three fields is also
supported. The paid replay must use the exact same body shape used to obtain
the challenge.

## Buyer flow

The normal URL-plus-flat-parameters quote flow cannot express the JSON-RPC MCP
wrapper above. For this first run, use the sign-only compatibility path and
replay the original request explicitly.

1. POST the exact body without a payment header. Capture the raw HTTP 402 and
   its `PAYMENT-REQUIRED` header.
2. Decode the challenge and show the buyer all terms:
   - Network: X Layer (`eip155:196`)
   - Token: USD₮0 (`0x779ded0c9e1022225f8e0630b35a9b54be713736`)
   - Amount: 0.1 USD₮0 (`100000` atomic units)
   - Recipient: `0xc0296012cfbb0e6df5da7158b65dbc46dd9650e0`
   - The exact market-snapshot request parameters
3. Stop. The external buyer must explicitly confirm those terms before any
   wallet check or signature.
4. In the buyer's session, run the current protocol preflight, then use the
   compatibility signer with the untouched `PAYMENT-REQUIRED` value:

   ```bash
   onchainos preflight --skill-version 4.2.6
   onchainos payment pay --payload '<PAYMENT-REQUIRED value>'
   ```

   Do not use the local-key signer for this challenge: the advertised entry
   does not carry the domain fields that local-key signing documents as
   prerequisites.
5. Replay the exact same POST body once with the returned header name and
   authorization value. Allow at least 90 seconds for the HTTP client; Express
   itself waits up to 60 seconds.
6. Expect HTTP 200 and preserve the `PAYMENT-RESPONSE` header. Decode it with:

   ```bash
   onchainos payment decode-receipt --header '<PAYMENT-RESPONSE value>'
   ```

7. If the body returns `EXPRESS_PENDING`, preserve its `task_id` and poll the
   free `get_status` and `get_result` MCP tools. Do not purchase again.

If replay returns 402 or 500, or the connection is lost after settlement, stop.
Do not obtain another signature. Recover the job by payer/task evidence first;
if delivery cannot be recovered, perform the full manual refund with the buyer
present.

## Evidence bundle

Capture all of the following before calling the proof complete:

- Buyer's explicit confirmation of 0.1 USD₮0.
- UTC timestamp and exact request body.
- Raw unpaid 402 and decoded requirements.
- Paid HTTP status and response body.
- Decoded settlement receipt: success, inbound transaction, payer, amount, and
  network.
- Inbound OKLink transaction link.
- `task_id` and state progression.
- Final deliverable and Firm provenance receipt.
- Outbound vendor transaction and OKLink link.
- Refund transaction if the job fails.

Never retain or publish the buyer's authorization header, private key, wallet
session material, facilitator credentials, or Fly secrets.

## Known recovery gap

- The inbound settlement transaction is returned to the buyer but is not stored
  on the job; the buyer must preserve `PAYMENT-RESPONSE`.
