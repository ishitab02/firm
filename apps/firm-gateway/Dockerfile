# Firm gateway — public MCP + x402 endpoint for the OKX listing.
#
# Build from the REPO ROOT (pnpm workspace context), not this directory:
#   docker build -f apps/firm-gateway/Dockerfile -t firm-gateway .
#   docker run -p 8790:8790 --env-file apps/firm-gateway/.env firm-gateway
#
# For the OKX "API service" listing this container must sit behind public HTTPS
# (a reverse proxy or platform TLS). CHARGING_MODE must be `enforce` in
# production; see apps/firm-gateway/.env.example for the required seller config.
FROM node:20-slim

RUN corepack enable
WORKDIR /app

# Workspace manifests first for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/firm-gateway/package.json apps/firm-gateway/package.json
RUN pnpm install --frozen-lockfile

COPY apps/firm-gateway apps/firm-gateway
WORKDIR /app/apps/firm-gateway

ENV PORT=8790
EXPOSE 8790

# tsx runs the TypeScript entrypoint directly; no separate build step needed.
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
