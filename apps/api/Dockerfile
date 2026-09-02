# Production-oriented non-root container for @techpulse/api
# Node version pinned per ADR-0001 (Node 22 LTS)
FROM node:22-alpine AS base

ENV NODE_ENV=production
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

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

RUN pnpm --filter @techpulse/api build

FROM base AS runner

# Non-root unprivileged execution
USER node
WORKDIR /app

COPY --chown=node:node --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/packages ./packages
COPY --chown=node:node --from=builder /app/apps/api ./apps/api

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--import=tsx/esm", "apps/api/src/index.ts"]
