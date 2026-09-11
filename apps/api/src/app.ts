import { createStructuredLogger, type StructuredLogger } from '@techpulse/observability';
import {
  type DatabaseClient,
  createSourceRepository,
  createTopicRepository,
  createCollectionRunRepository,
  createCollectionStateRepository,
  createCoverageRepository,
  createDiscoveryStateRepository,
  createEmbeddingWorkRepository,
  createProviderBudgetRepository,
  createDatabaseReplayPorts,
} from '@techpulse/database';
import {
  type SourceRepositoryPort,
  type TopicRepositoryPort,
  type CollectionRunRepositoryPort,
  type ReplayRequest,
  type ReplayResult,
  type TombstoneServicePort,
  type CoveragePort,
  type CollectionStatePort,
  type DiscoveryStatePort,
  type EmbeddingWorkPort,
  type ProviderBudgetPort,
  createReplayService,
} from '@techpulse/domain';
import { type AnswerServicePort } from '@techpulse/rag';
import { node } from '@elysiajs/node';
import { Elysia } from 'elysia';

import { ConcurrencyLimiter, DailyBudgetTracker, MemoryRateLimiter } from './abuse-controls.js';
import { resolveRequestCorrelation } from './correlation.js';
import { ApiHttpError, formatErrorToEnvelope } from './errors.js';
import { createAnswerRoutes } from './routes/answers.js';
import { createCoverageRoutes } from './routes/coverage.js';
import {
  createHealthRoutes,
  type DatabaseHealthCheck,
  type DependencyHealthCheck,
} from './routes/health.js';
import {
  createOpsRoutes,
  type CollectionDispatcher,
  type IdempotencyStore,
  type OpsAuditEvent,
  type OpsRouteOptions,
} from './routes/ops.js';
import { createSourceRoutes } from './routes/sources.js';
import { createTopicRoutes } from './routes/topics.js';

export interface AppOptions {
  readonly databaseClient?: DatabaseClient | undefined;
  readonly checkDatabaseHealth?: DatabaseHealthCheck | undefined;
  readonly logger?: StructuredLogger | undefined;
  readonly sourceRepository?: SourceRepositoryPort | undefined;
  readonly topicRepository?: TopicRepositoryPort | undefined;
  readonly collectionRunRepository?: CollectionRunRepositoryPort | undefined;
  readonly collectionDispatcher?: CollectionDispatcher | undefined;
  readonly answerService?: AnswerServicePort | undefined;
  readonly replayService?:
    { readonly replay: (request: ReplayRequest) => Promise<ReplayResult> } | undefined;
  readonly tombstoneService?: TombstoneServicePort | undefined;
  readonly coveragePort?: CoveragePort | undefined;
  readonly collectionStatePort?: CollectionStatePort | undefined;
  readonly resolveTargetPolicy?: OpsRouteOptions['resolveTargetPolicy'];
  readonly discoveryStatePort?: DiscoveryStatePort | undefined;
  readonly embeddingWorkPort?: EmbeddingWorkPort | undefined;
  readonly providerBudgetPort?: ProviderBudgetPort | undefined;
  readonly corsAllowedOrigins?: readonly string[] | undefined;
  readonly rateLimiter?: MemoryRateLimiter | undefined;
  readonly concurrencyLimiter?: ConcurrencyLimiter | undefined;
  readonly budgetTracker?: DailyBudgetTracker | undefined;
  readonly opsApiKey?: string | undefined;
  readonly idempotencyStore?: IdempotencyStore | undefined;
  readonly auditSink?: ((event: OpsAuditEvent) => void | Promise<void>) | undefined;
  readonly checkRedisHealth?: DependencyHealthCheck | undefined;
  readonly checkWorkerHealth?: DependencyHealthCheck | undefined;
}
export function createApp(options: AppOptions = {}) {
  const logger = options.logger ?? createStructuredLogger({ service: 'api' });
  const checkDatabaseHealth =
    options.checkDatabaseHealth ??
    (options.databaseClient ? () => options.databaseClient!.checkHealth() : undefined);
  const sourceRepository =
    options.sourceRepository ??
    (options.databaseClient ? createSourceRepository(options.databaseClient.db) : undefined);
  const topicRepository =
    options.topicRepository ??
    (options.databaseClient ? createTopicRepository(options.databaseClient.db) : undefined);
  const collectionRunRepository =
    options.collectionRunRepository ??
    (options.databaseClient ? createCollectionRunRepository(options.databaseClient.db) : undefined);
  const collectionStatePort =
    options.collectionStatePort ??
    (options.databaseClient
      ? createCollectionStateRepository(options.databaseClient.db)
      : undefined);
  const coveragePort =
    options.coveragePort ??
    (options.databaseClient ? createCoverageRepository(options.databaseClient.db) : undefined);
  const discoveryStatePort =
    options.discoveryStatePort ??
    (options.databaseClient
      ? createDiscoveryStateRepository(options.databaseClient.db)
      : undefined);
  const embeddingWorkPort =
    options.embeddingWorkPort ??
    (options.databaseClient ? createEmbeddingWorkRepository(options.databaseClient.db) : undefined);
  const providerBudgetPort =
    options.providerBudgetPort ??
    (options.databaseClient
      ? createProviderBudgetRepository(options.databaseClient.db)
      : undefined);
  const replayService =
    options.replayService ??
    (options.databaseClient && typeof createDatabaseReplayPorts === 'function'
      ? createReplayService(createDatabaseReplayPorts(options.databaseClient.db))
      : undefined);
  const corsAllowedOrigins = options.corsAllowedOrigins ?? [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:4173',
  ];
  const rateLimiter = options.rateLimiter ?? new MemoryRateLimiter();
  const concurrencyLimiter = options.concurrencyLimiter ?? new ConcurrencyLimiter();
  const budgetTracker = options.budgetTracker ?? new DailyBudgetTracker();

  const applySecurityAndCors = (
    headers: Record<string, string | undefined>,
    originHeader: string | null,
  ) => {
    // 1. Mandatory Security Headers (THR-006 & SECURITY.md §6)
    headers['x-content-type-options'] = 'nosniff';
    headers['x-frame-options'] = 'DENY';
    headers['referrer-policy'] = 'strict-origin-when-cross-origin';
    headers['content-security-policy'] = "default-src 'none'; frame-ancestors 'none'";
    headers['cross-origin-opener-policy'] = 'same-origin';
    headers['cross-origin-resource-policy'] = 'same-origin';
    headers['permissions-policy'] = 'camera=(), microphone=(), geolocation=()';

    // 2. CORS Allowlist Validation (SEC-001)
    if (originHeader) {
      const isAllowed =
        corsAllowedOrigins.includes(originHeader) || corsAllowedOrigins.includes('*');
      if (isAllowed) {
        headers['access-control-allow-origin'] = originHeader;
        headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
        headers['access-control-allow-headers'] = 'Content-Type, Authorization, x-request-id';
        headers['access-control-max-age'] = '86400';
      }
    }
  };

  return new Elysia({ adapter: node(), normalize: false })
    .state('requestId', '')
    .onRequest(({ request, store, set }) => {
      const correlation = resolveRequestCorrelation(request);
      store.requestId = correlation.requestId;
      logger.withContext(correlation.context).info('api.request.received', {
        method: request.method,
        url: request.url,
      });

      // Handle OPTIONS preflight requests
      if (request.method === 'OPTIONS') {
        const origin = request.headers.get('origin');
        applySecurityAndCors(set.headers as Record<string, string | undefined>, origin);
        set.status = 204;
        return new Response(null, {
          status: 204,
          headers: set.headers as HeadersInit,
        });
      }
    })
    .onAfterHandle(({ set, store, request }) => {
      const requestId = store.requestId || resolveRequestCorrelation(request).requestId;
      set.headers['x-request-id'] = requestId;
      applySecurityAndCors(
        set.headers as Record<string, string | undefined>,
        request.headers.get('origin'),
      );
    })
    .onError(({ error, set, store, request }) => {
      const requestId = store.requestId || resolveRequestCorrelation(request).requestId;
      const result = formatErrorToEnvelope(error, requestId);
      set.status = result.status;
      set.headers['x-request-id'] = requestId;
      applySecurityAndCors(
        set.headers as Record<string, string | undefined>,
        request.headers.get('origin'),
      );

      logger.withContext({ requestId }).error('api.request.error', {
        status: result.status,
        code: result.envelope.error.code,
        message: result.envelope.error.message,
      });

      return result.envelope;
    })
    .use(
      createHealthRoutes({
        checkDatabaseHealth,
        checkRedisHealth: options.checkRedisHealth,
        checkWorkerHealth: options.checkWorkerHealth,
      }),
    )
    .group('/api/v1', (v1) =>
      v1
        .onBeforeHandle(({ request, set }) => {
          const urlPath = new URL(request.url).pathname;
          const isOps = urlPath.startsWith('/api/v1/ops') || urlPath.startsWith('/ops');

          // Trusted proxies append to the right; the final XFF hop is the first
          // non-proxy hop, so reading the trailing entry defeats client forgeries.
          const xff = request.headers.get('x-forwarded-for');
          const clientIp =
            (xff
              ? xff
                  .split(',')
                  .map((hop) => hop.trim())
                  .filter(Boolean)
                  .at(-1)
              : undefined) ||
            request.headers.get('x-real-ip') ||
            'client_default';

          const limitResult = rateLimiter.check(clientIp);
          if (!limitResult.allowed && !isOps) {
            set.headers['retry-after'] = String(limitResult.reset);
            set.headers['ratelimit-limit'] = String(limitResult.limit);
            set.headers['ratelimit-remaining'] = '0';
            set.headers['ratelimit-reset'] = String(limitResult.reset);
            throw new ApiHttpError({
              code: 'RATE_LIMITED',
              status: 429,
              message: 'Rate limit exceeded. Please try again later.',
              retryable: true,
            });
          }
          if (isOps && !limitResult.allowed) {
            throw new ApiHttpError({
              code: 'RATE_LIMITED',
              status: 429,
              message: 'Rate limit exceeded. Please try again later.',
              retryable: true,
            });
          }

          set.headers['ratelimit-limit'] = String(limitResult.limit);
          set.headers['ratelimit-remaining'] = String(limitResult.remaining);
          set.headers['ratelimit-reset'] = String(limitResult.reset);
        })
        .use(createSourceRoutes({ sourceRepository }))
        .use(createTopicRoutes({ topicRepository }))
        .use(createCoverageRoutes({ coveragePort }))
        .use(
          createAnswerRoutes({
            answerService: options.answerService,
            concurrencyLimiter,
            budgetTracker,
          }),
        )
        .use(
          createOpsRoutes({
            opsApiKey: options.opsApiKey,
            sourceRepository,
            collectionRunRepository,
            collectionDispatcher: options.collectionDispatcher,
            replayService,
            tombstoneService: options.tombstoneService,
            logger,
            auditSink: options.auditSink,
            idempotencyStore: options.idempotencyStore,
            collectionStatePort,
            resolveTargetPolicy: options.resolveTargetPolicy,
            discoveryStatePort,
            embeddingWorkPort,
            providerBudgetPort,
            coveragePort,
          }),
        ),
    );
}
