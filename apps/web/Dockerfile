# Production-oriented non-root container for @techpulse/web
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
COPY apps/web ./apps/web

RUN pnpm --filter @techpulse/web build

FROM base AS runner

# Non-root unprivileged execution
USER node
WORKDIR /app

COPY --chown=node:node --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/packages ./packages
COPY --chown=node:node --from=builder /app/apps/web ./apps/web

ENV NODE_ENV=production
ENV PORT=5173
EXPOSE 5173

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 5173) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "./apps/web/node_modules/vite/bin/vite.js", "preview", "--config", "apps/web/vite.config.ts", "--host", "0.0.0.0", "--port", "5173"]
