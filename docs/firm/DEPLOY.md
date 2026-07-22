# Deploying The Firm — runbook

> **LIVE as of 2026-07-21.** `https://firm-gateway.fly.dev` is deployed and
> `onchainos agent x402-check` returns `valid: true` against it. The stack runs
> on Fly (`sin`) with Neon Postgres (`ap-southeast-1`). Everything below is the
> procedure that produced it, kept so it can be reproduced or moved.

Getting a public HTTPS endpoint that passes OKX's own validator, so the listing
can be submitted with the reachability question already answered rather than
discovered during review.

Every step below was run end to end on 2026-07-21 against the real images.
Where something is unverified, it says so.

---

## Why the whole stack, not just the gateway

Four processes, all load-bearing:

| service | role |
|---|---|
| `db` | job state, checkpoints, the spend ledger, idempotency keys |
| `migrate` | one-shot; creates the worker's tables, then exits |
| `procurer` | the only component holding a key; pays vendors, refunds buyers |
| `worker` | claims paid jobs and runs the graph to a deliverable |
| `gateway` | the public endpoint; takes payment, creates jobs |

**Deploying the gateway alone is the trap.** It will accept a payment, create a
job, and return `PENDING` forever, because nothing is working the queue. From
outside that is indistinguishable from an agent that took your money and
vanished.

---

## 1. Configure

Copy `.env.deploy.example` to `.env.deploy` and fill it. Five values have no
defaults and the stack refuses to start without them:

```
POSTGRES_PASSWORD=          # not "firm"
PROCURER_AUTH_TOKEN=        # openssl rand -hex 32
FIRM_PAYTO_ADDRESS=         # where the Firm gets paid
FIRM_CHARGE_ASSET=          # 0x779ded0c9e1022225f8e0630b35a9b54be713736 (USD₮0)
FIRM_CHARGE_NETWORK=        # eip155:196 (X Layer)
```

`.env.deploy` is gitignored. `FIRM_WALLET_KEY` is passed at run time and is
never baked into an image.

Two safety rails will stop the stack rather than let a mistake through:

- The **gateway refuses to bind a public interface with `CHARGING_MODE=bypass`**.
  A publicly reachable gateway in bypass mode does unlimited paid work for free
  while still paying vendors from our wallet. `ALLOW_PUBLIC_BYPASS=true` exists
  for deliberate staging runs and should not be set in production.
- The **procurer refuses a non-loopback bind without `PROCURER_AUTH_TOKEN`**.
  Anything that can reach `/pay-and-call` can spend up to the caps.

## 2. Bring it up

```bash
docker compose -f docker-compose.deploy.yml --env-file .env.deploy up -d --build
docker compose -f docker-compose.deploy.yml --env-file .env.deploy ps
```

Healthy looks like this — note `migrate` **must** show `Exited (0)`, not running:

```
SERVICE    STATUS                    PORTS
db         Up (healthy)              5432/tcp
gateway    Up (healthy)              0.0.0.0:8790->8790/tcp
migrate    Exited (0)
procurer   Up (healthy)              8787/tcp
worker     Up
```

`procurer` showing `8787/tcp` with no `0.0.0.0->` mapping is correct and
required: it is reachable from sibling containers only.

If `worker` is `Restarting`, check `docker compose logs worker`. A missing
`firm_jobs` table means the migrate step did not run.

## 3. Verify locally before exposing anything

```bash
curl -s localhost:8790/health
# {"ok":true,"service":"firm-gateway","charging_mode":"enforce",...}

curl -s -X POST localhost:8790 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# The 402 challenge — this is the thing OKX validates.
curl -si -X POST localhost:8790 -H 'content-type: application/json' \
  -d '{"tool":"express_run","args":{"job_type":"market_snapshot","params":{"symbol":"BTC"}}}' \
  | grep -i payment-required
```

Decode that header and check `amount`, `asset`, `payTo` and `network` are what
you meant to charge. A verified run produces:

```json
{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:196",
  "amount":"100000","asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736",
  "payTo":"0x…","resource":"firm:express:market_snapshot",
  "extra":{"decimals":6}}]}
```

Then confirm the payment boundary holds: an unpaid `execute` must return 402 and
write **no** row.

```bash
docker compose -f docker-compose.deploy.yml --env-file .env.deploy \
  exec db psql -U firm -d firm -c "SELECT count(*) FROM firm_jobs;"
```

## 4. Public HTTPS — what actually shipped

Sections 1–3 use docker-compose, which is the local path. **The live deployment
is Fly**, and these are the commands that produced it:

```bash
# Postgres: Neon free tier, ap-southeast-1 to match Fly's sin.
# Use the DIRECT connection string, not the -pooler one (see below).
cd apps/firm && DATABASE_URL="postgresql://…" uv run firm-worker migrate

TOKEN=$(openssl rand -hex 32)
fly secrets set -a firm-procurer PROCURER_AUTH_TOKEN="$TOKEN" DATABASE_URL="…"
fly secrets set -a firm-worker   PROCURER_AUTH_TOKEN="$TOKEN" DATABASE_URL="…"
fly secrets set -a firm-gateway  DATABASE_URL="…" \
  FIRM_PAYTO_ADDRESS="0x…" FIRM_CHARGE_ASSET="0x779ded…736" FIRM_CHARGE_NETWORK="eip155:196"

fly deploy --config fly.procurer.toml --remote-only
fly deploy --config fly.gateway.toml  --remote-only
fly deploy --config fly.worker.toml   --remote-only
```

Only the gateway gets a public address. `fly.procurer.toml` has no
`[http_service]` on purpose, so Fly allocates it no IP — running
`fly ips allocate` on that app would publish a spending API to the internet.

Three deployment details that are load-bearing:

- **`HOST=::`, not `0.0.0.0`.** Fly's private network (6PN) is IPv6-only, and a
  Node server bound to `0.0.0.0` listens on IPv4 only. Get this wrong and
  `firm-procurer.internal:8787` resolves and then refuses every connection.
- **Use Neon's direct endpoint, not `-pooler`.** Both work and both support
  `pg_advisory_xact_lock`, so cap enforcement is safe either way — but three
  long-lived pools gain nothing from PgBouncer, and psycopg3's automatic
  prepared statements are a known hazard in transaction pooling mode.
- **Check the worker machine count.** Fly creates a standby per process group.
  It must be `stopped`; two *started* workers is the stale-reclaim scenario.
  `fly machines list -a firm-worker`.

Verify from outside:

```bash
curl -s https://firm-gateway.fly.dev/health
curl -s --max-time 8 https://firm-procurer.fly.dev/health   # must NOT resolve
fly ssh console -a firm-worker -C "python -c \"import httpx;print(httpx.get('http://firm-procurer.internal:8787/health').json())\""
```

## 5. Run OKX's own validator — before submitting

This is the whole point of choosing the A2MCP ("API service") listing type over
A2A: the path can be checked before review, instead of during it.

```bash
onchainos agent x402-check --endpoint https://firm-gateway.fly.dev \
  --body '{"tool":"express_run","args":{"job_type":"market_snapshot","params":{"symbol":"BTC"}}}'
onchainos agent gate-check --role ASP
```

Run on 2026-07-21 against the live endpoint:

```json
{"ok":true,"data":{"valid":true,"amountHuman":0.1,"amountMinimal":"100000",
  "asset":"0x779ded0c9e1022225f8e0630b35a9b54be713736","decimals":6,
  "network":"eip155:196","payTo":"0xc029…","scheme":"exact","x402Version":2}}
```

`tokenSymbol` comes back `UNKNOWN`, which did not block validation — the asset
address is what matters and it is correct.

Do not submit the listing until `x402-check` passes. Treasury was rejected twice
with "unable to reach your Agent's service endpoint" and "has not passed x402
standard validation" — both of which this step would have caught in advance.

## 6. Register the service

`gate-check` passing is not enough on its own. Treasury's `serviceList` was
literally `[]`, which is the root cause of both its rejections: there was
nothing registered to reach and nothing to validate. After the endpoint is live,
register the service and confirm it appears:

```bash
onchainos agent service-list
```

---

## 7. Redeploying: the order is not optional

Updated 2026-07-22. **procurer -> worker -> gateway. The public surface comes up
last, and only once everything behind it is ready.**

Treat a multi-service update as a maintenance window, not three independent
deploys. While it is in progress the components are mutually incompatible, so
**unlist or disable Express first** — a buyer arriving mid-window pays a live
endpoint whose worker cannot serve it.

```bash
# 0. Unlist Express so no purchase lands mid-window.
fly deploy --config fly.procurer.toml --remote-only   # 1. money spine
fly deploy --config fly.worker.toml   --remote-only   # 2. runs migrations
fly deploy --config fly.gateway.toml  --remote-only   # 3. public surface last
# 4. Re-list Express only after the verification below passes.
```

Why this exact order:

- **Procurer first.** The gateway asks the procurer whether refunds are
  operationally ready and *refuses to boot* when the answer is no
  (`fulfilment.ts` — a startup check, deliberately). A procurer predating
  `refundReadiness()` cannot answer, so a gateway deployed against it takes the
  public endpoint down rather than degrading it.
- **Worker second, because it carries the schema.** `fly.worker.toml` sets
  `[deploy] release_command = "firm-worker migrate"`. Fly aborts the deploy if
  that exits non-zero, so the migration is the gate on the new worker starting.
  Running it before the gateway means the public endpoint never accepts a
  payment against a database the new code cannot use.
- **Gateway last.** It is the only thing with a public address. Nothing it
  accepts is serviceable until the two above are in place.

Verify before re-listing — health, then unpaid behaviour, then the validators:

```bash
fly ssh console -a firm-worker -C "python -c \"import httpx;print(httpx.get('http://firm-procurer.internal:8787/health').json())\""
# require: refund_ready true, real_payments_enabled true, real_refunds_enabled true,
#          wallet_key_present true, and refund_gas_balance_wei > refund_gas_required_wei

curl -si https://firm-gateway.fly.dev            # GET  -> 402
curl -si -X POST https://firm-gateway.fly.dev -H 'content-type: application/json' \
  -d '{"symbol":"ETH","timeframe":"4h","prompt":"market snapshot with support and resistance"}'
# POST with the documented flat body -> 402, and the decoded challenge must carry
# the USD₮0 asset, eip155:196, and the POST input schema.

onchainos agent x402-check --endpoint https://firm-gateway.fly.dev --body '…'
onchainos agent x402-validate
```

Checking the deployed version is not optional — the procurer is the easy one to
miss because it has no public health URL to look wrong:

```bash
git log -1 --format='%h %ad' --date=iso -- packages/procurer fly.procurer.toml
fly status -a firm-procurer | grep 'LAST UPDATED' -A3
```

A commit timestamp newer than the machine's last update means that service is
behind, whatever the app-level "latest deploy" column says.

### The native-gas dependency

Refunds are now transactions the Firm broadcasts, not authorizations someone
else redeems, so `0xC029…50e0` **must hold native OKB**. It is checked before
every transfer and again at gateway boot. Out of gas means the gateway will not
start — deliberately, because the alternative is advertising a refund guarantee
the wallet cannot honour.

```bash
cast balance 0xC0296012Cfbb0e6DF5dA7158B65Dbc46DD9650e0 --rpc-url https://rpc.xlayer.tech
```

Budget `REFUND_GAS_LIMIT` (100,000) × gas price per refund. Top up well above
one refund's worth; the floor is not the target.

## Resolved (kept for history)

Two items gated the paid path and no longer do:

- **The facilitator contract is verified.** `X402_FACILITATOR_URL` is set and
  both legs were reconciled against the real OKX facilitator on 2026-07-22. It
  wants `{x402Version, paymentPayload, paymentRequirements}` with the payload as
  a decoded **object**; the gateway had been sending `{paymentHeader: <base64>}`
  and getting `30001`. Responses are wrapped as `{code, data:{isValid…}}`, and
  reading `raw.isValid` scored valid payments invalid. Both fixed and pinned by
  tests.
- **Real refunds are armed.** The payer wallet is no longer the CLI-logged-in
  account: signing moved in-process, collapsing payer, payee and refunder onto
  `0xC029…50e0`, and `REAL_REFUNDS_ENABLED=true`. `REFUND_FROM_ADDRESS` is
  checked against the address the key derives to before every transfer, so a
  wrong key deployed to production is a startup mismatch rather than a refund
  from an unintended wallet.
