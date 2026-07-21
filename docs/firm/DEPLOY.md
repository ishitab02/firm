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

## 4. Public HTTPS

The container speaks plain HTTP on 8790. OKX needs public HTTPS, so put it
behind platform TLS (Railway, Render, Fly) or a reverse proxy with a real
certificate. Terminate TLS in front; do not add it to the container.

Only the gateway is exposed. The procurer, worker and database must stay on the
internal network.

## 5. Run OKX's own validator — before submitting

This is the whole point of choosing the A2MCP ("API service") listing type over
A2A: the path can be checked before review, instead of during it.

```bash
onchainos agent x402-check --endpoint https://<your-domain> --body '{"tool":"express_run","args":{"job_type":"market_snapshot","params":{"symbol":"BTC"}}}'
onchainos agent gate-check --role ASP
```

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

## Open, and it gates the paid path

**`X402_FACILITATOR_URL` is unset, and its contract is unverified.**

The gateway verifies and settles payments against a facilitator. Route names
(`/verify`, `/settle`) and body shapes are confirmed only against our own fake —
never against the real OKX facilitator, which may use different routes, require
authentication, or expect a different envelope.

With it unset the gateway fails closed: every paid call gets a 402 forever. That
is the correct failure direction, and it also means:

- `x402-check` should still pass, because it inspects the challenge
- a real buyer paying would **not** get through

So: reconcile the facilitator contract before announcing the agent, and make the
first paid call yourself before letting anyone else near it.

Related open item: the payer wallet `0xc029…` is not the CLI-logged-in account,
so `REAL_REFUNDS_ENABLED` stays off until that is resolved. While real payments
are on and real refunds are off, `/refund` deliberately fails closed with
`REQUIRES_HUMAN` and hands back the exact command to run by hand — it will not
fabricate a refund transaction.
