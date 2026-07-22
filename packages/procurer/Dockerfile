# Firm procurer — the ONLY component that holds a key and moves money.
#
# Build from the REPO ROOT (pnpm workspace context):
#   docker build -f packages/procurer/Dockerfile -t firm-procurer .
#
# NEVER publish this container's port to the host or the internet. Anything that
# can POST /pay-and-call can spend the Firm's money up to the caps, so it is
# reachable only from sibling containers on the compose network, and only with
# PROCURER_AUTH_TOKEN. The process refuses to bind a non-loopback interface
# without one.
#
# FIRM_WALLET_KEY is passed at run time and never baked into the image.
#
# This image is self-sufficient as of 2026-07-22. It previously shelled out to
# the `onchainos` CLI to sign, which could never work here: that CLI is a
# macOS-only binary whose Agentic Wallet login is browser-based, so a container
# could hold a funded key and still be unable to spend or refund. Signing now
# happens in-process with viem, so the only external dependency left is an RPC
# endpoint.
FROM node:20-slim

# HTTPS to the chain RPC and to vendor endpoints needs a real certificate store.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/firm-gateway/package.json apps/firm-gateway/
COPY packages/mocks/package.json packages/mocks/
COPY packages/procurer/package.json packages/procurer/
COPY tests/firm-evals/package.json tests/firm-evals/
COPY tools/demo/package.json tools/demo/
COPY tools/vendor-index/package.json tools/vendor-index/
COPY tools/vendor-report/package.json tools/vendor-report/

RUN pnpm install --frozen-lockfile --filter @firm/procurer...

COPY packages/procurer packages/procurer
COPY data data
WORKDIR /app/packages/procurer

ENV PORT=8787
ENV HOST=0.0.0.0
EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "exec", "tsx", "src/server.ts"]
