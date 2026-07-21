# Firm gateway — the public MCP + x402 endpoint OKX calls.
#
# Build from the REPO ROOT (pnpm workspace context), not this directory:
#   docker build -f apps/firm-gateway/Dockerfile -t firm-gateway .
#
# Prefer `docker compose -f docker-compose.deploy.yml up` over running this
# alone: the gateway accepts payment and creates jobs, but a job only becomes a
# deliverable when the worker and the procurer are also running. A gateway
# deployed by itself takes money and returns PENDING forever.
#
# For the OKX "API service" listing this must sit behind public HTTPS (platform
# TLS or a reverse proxy) and CHARGING_MODE must be `enforce` — the process
# refuses to bind a public interface in bypass mode. See .env.example.
FROM node:20-slim

RUN corepack enable
WORKDIR /app

# Every workspace manifest, so --frozen-lockfile can validate the lockfile it
# was given. Copying only the gateway's manifest makes pnpm reject the lockfile
# as out of date with the workspace.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/firm-gateway/package.json apps/firm-gateway/
COPY packages/mocks/package.json packages/mocks/
COPY packages/procurer/package.json packages/procurer/
COPY tests/firm-evals/package.json tests/firm-evals/
COPY tools/demo/package.json tools/demo/
COPY tools/vendor-index/package.json tools/vendor-index/
COPY tools/vendor-report/package.json tools/vendor-report/

RUN pnpm install --frozen-lockfile --filter @firm/gateway...

COPY apps/firm-gateway apps/firm-gateway
WORKDIR /app/apps/firm-gateway

ENV PORT=8790
# Loopback is the right default for a laptop and useless in a container: a
# published port reaches the container's external interface, not its loopback.
# A process bound to 127.0.0.1 here answers nothing, which is exactly the
# "unable to reach your Agent's service endpoint" rejection OKX sent Treasury.
ENV HOST=0.0.0.0
EXPOSE 8790

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsx runs the TypeScript entrypoint directly; no separate build step needed.
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
