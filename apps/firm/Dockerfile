# Firm worker — the brain. Claims paid jobs and runs the six-stage graph.
#
# Build from the REPO ROOT:
#   docker build -f apps/firm/Dockerfile -t firm-worker .
#
# Holds no key and never signs anything. All spending goes through the
# procurer's HTTP API, which it authenticates to with PROCURER_AUTH_TOKEN.
FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv

WORKDIR /app/apps/firm

# Lockfile first so dependency layers cache independently of source edits.
COPY apps/firm/pyproject.toml apps/firm/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY apps/firm/src src
COPY apps/firm/migrations migrations
RUN uv sync --frozen --no-dev

# The vendor index lives at the repo root and is read at run time, so the
# default relative path (../../data) has to resolve inside the image too.
COPY data /app/data

ENV PATH="/app/apps/firm/.venv/bin:$PATH"

# `run` is the long-poll worker loop: claim a paid job, run it to a deliverable
# or a refund, repeat. Without this process a paid job never leaves `paid`.
CMD ["firm-worker", "run"]
