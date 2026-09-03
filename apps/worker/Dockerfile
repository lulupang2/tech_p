# Production-oriented non-root container for @techpulse/worker
# Node version pinned per ADR-0001 (Node 22 LTS)
FROM node:22-bookworm-slim AS base

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app

FROM base AS builder

ENV NODE_ENV=development
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/database/package.json ./packages/database/
COPY packages/domain/package.json ./packages/domain/
COPY packages/observability/package.json ./packages/observability/
COPY packages/rag/package.json ./packages/rag/
COPY packages/collectors/package.json ./packages/collectors/
COPY tooling/test-harness/package.json ./tooling/test-harness/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @techpulse/worker exec playwright install --with-deps chromium

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm install --frozen-lockfile


RUN pnpm --filter @techpulse/worker build

FROM base AS runner

RUN pnpm dlx playwright@1.62.1 install-deps chromium

# Non-root unprivileged execution
USER node
WORKDIR /app

COPY --chown=node:node --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/packages ./packages
COPY --chown=node:node --from=builder /app/apps/worker ./apps/worker
COPY --chown=node:node --from=builder /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --chown=node:node --from=builder /ms-playwright /ms-playwright

ENV NODE_ENV=production

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=5 \
  CMD node -e "process.exit(0)"
CMD ["node", "--import=./node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/loader.mjs", "apps/worker/src/index.ts"]
