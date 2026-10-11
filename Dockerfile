ARG PLAYWRIGHT_VERSION=1.58.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS browser-vendor

FROM node:26-slim AS builder

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY NO_PROXY=$NO_PROXY

RUN set -eux; \
    sed -Ei 's/deb\.debian\.org/mirrors.aliyun.com/g' \
      /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true; \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 python3-venv python3-dev python3-pip \
      build-essential git wget curl libsqlite3-dev ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN npm install -g pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml .npmrc ./

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    npm_config_build_from_source=false \
    PNPM_FETCH_RETRIES=5 \
    PNPM_NETWORK_CONCURRENCY=8

RUN pnpm install --frozen-lockfile || pnpm install

COPY . .
RUN pnpm build
WORKDIR /app/subserver/pyserver
RUN /usr/local/bin/uv venv .venv && \
    /usr/local/bin/uv pip install --no-cache fastapi "uvicorn[standard]" pyyaml && \
    find .venv -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true && \
    find .venv -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete 2>/dev/null || true

FROM node:26-slim AS runtime

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY NO_PROXY=$NO_PROXY

RUN set -eux; \
    sed -Ei 's/deb\.debian\.org/mirrors.aliyun.com/g' \
      /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true; \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 python3-venv wget curl ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -g 10000 xrk && \
    useradd -u 10000 -g xrk -m -s /bin/bash xrk

WORKDIR /app
COPY --from=builder --chown=xrk:xrk /app/node_modules ./node_modules
COPY --from=builder --chown=xrk:xrk /app/package.json ./package.json
COPY --from=builder --chown=xrk:xrk /app/pnpm-lock.yaml* ./
COPY --from=builder --chown=xrk:xrk /app/pnpm-workspace.yaml* ./
COPY --from=builder --chown=xrk:xrk /app/dist ./dist
COPY --chown=xrk:xrk . .
COPY --from=builder --chown=xrk:xrk /app/subserver/pyserver/.venv ./subserver/pyserver/.venv
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && chmod 755 /app/docker-entrypoint.sh && \
    mkdir -p logs data config resources www trash && \
    chown -R xrk:xrk logs data config resources www trash

ENV NODE_ENV=production \
    NODE_OPTIONS="--no-warnings --no-deprecation" \
    PUPPETEER_SKIP_DOWNLOAD=true

USER xrk
EXPOSE 8080 8000
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
CMD ["server"]

FROM runtime AS runtime-browser
USER root
COPY --from=browser-vendor /ms-playwright /ms-playwright
RUN set -eux; \
    apt-get update && \
    node /app/node_modules/playwright/cli.js install-deps chromium && \
    chown -R xrk:xrk /ms-playwright && \
    rm -rf /var/lib/apt/lists/*
USER xrk
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
