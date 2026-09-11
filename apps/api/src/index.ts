import { type CollectionDeliveryPayload } from '@techpulse/contracts';
import {
  createCollectionStateRepository,
  createCoverageRepository,
  createDatabaseClient,
  createDatabaseReplayPorts,
  createDiscoveryStateRepository,
  createEmbeddingWorkRepository,
  createProviderBudgetRepository,
  createSearchService,
} from '@techpulse/database';
import { MemoryRateLimiter, ConcurrencyLimiter, DailyBudgetTracker } from './abuse-controls.js';
import { createBudgetedApiModels, type ApiModelBindings } from './runtime-models.js';
import { createAnswerService, type AnswerServicePort } from '@techpulse/rag';
import { collectionHash, createReplayService } from '@techpulse/domain';
import {
  correlationContextFromHeaders,
  createStructuredLogger,
  type CorrelationContext,
  type StructuredEvent,
} from '@techpulse/observability';
import { node } from '@elysiajs/node';
import { Elysia } from 'elysia';
import { pathToFileURL } from 'node:url';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { loadApiConfig, type Environment } from './config.js';
import { createApprovedApiModelBindings } from './approved-models.js';
import { createApp, type AppOptions } from './app.js';
import type { OpsRouteOptions } from './routes/ops.js';

export { createApp, type AppOptions };
export {
  createBudgetedApiModels,
  type ApiModelBindings,
  type RuntimeModelBinding,
} from './runtime-models.js';
export {
  createApprovedApiModelBindings,
  DEC007_CHAT_MODEL,
  DEC007_EMBEDDING_MODEL,
  DEC012_SCOPE_ID,
} from './approved-models.js';
export {
  createOpsRoutes,
  defaultResolveTargetPolicy,
  MemoryIdempotencyStore,
  type OpsRouteOptions,
  type IdempotencyStore,
  type OpsAuditEvent,
} from './routes/ops.js';
export { runOpsCli, type OpsCliOptions, type CliExecutionResult } from './cli.js';

export const apiLogger = createStructuredLogger({ service: 'api' });

/** Extract and validate inbound correlation IDs at the HTTP boundary. */
export function requestCorrelationContext(request: Request): CorrelationContext {
  return correlationContextFromHeaders(request.headers);
}

/** Node-runtime API default shell instance. */
export const app = new Elysia({ adapter: node() }).use(createApp({ logger: apiLogger }));

export function logApiStartup(port: number): StructuredEvent {
  return apiLogger.info('api.starting', { port });
}

export interface StartOptions {
  readonly env?: Environment | undefined;
  readonly models?: ApiModelBindings | undefined;
  readonly resolveTargetPolicy?: OpsRouteOptions['resolveTargetPolicy'] | undefined;
}

export function start(
  envOrOptions?: Environment | StartOptions,
  models?: ApiModelBindings,
  resolveTargetPolicy?: OpsRouteOptions['resolveTargetPolicy'],
) {
  let env: Environment = process.env;
  let resolvedModels = models;
  let resolvedTargetPolicy = resolveTargetPolicy;

  if (envOrOptions) {
    if (
      'models' in envOrOptions ||
      'resolveTargetPolicy' in envOrOptions ||
      ('env' in envOrOptions && typeof (envOrOptions as StartOptions).env === 'object')
    ) {
      const opts = envOrOptions as StartOptions;
      if (opts.env) env = opts.env;
      if (opts.models) resolvedModels = opts.models;
      if (opts.resolveTargetPolicy) resolvedTargetPolicy = opts.resolveTargetPolicy;
    } else {
      env = envOrOptions as Environment;
    }
  }

  const config = loadApiConfig(env);
  resolvedModels = resolvedModels ?? createApprovedApiModelBindings(config);
  const databaseClient = createDatabaseClient(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const collectionQueue = new Queue<CollectionDeliveryPayload>('techpulse-delivery', {
    connection: redis,
  });
  const collectionDispatcher = {
    dispatch: async (request: { readonly collectionRunId: string }): Promise<void> => {
      const data: CollectionDeliveryPayload = {
        schemaVersion: 2,
        deliveryId: request.collectionRunId,
      };
      await collectionQueue.add('delivery', data, {
        jobId: data.deliveryId,
        removeOnComplete: true,
      });
    },
  };
  const coveragePort = createCoverageRepository(databaseClient.db, {
    ...(resolvedModels?.embedding ? { embeddingProfile: resolvedModels.embedding.profile } : {}),
  });
  const collectionStatePort = createCollectionStateRepository(databaseClient.db);
  const discoveryStatePort = createDiscoveryStateRepository(databaseClient.db);
  const embeddingWorkPort = createEmbeddingWorkRepository(databaseClient.db);
  const providerBudgetPort = createProviderBudgetRepository(databaseClient.db);
  const replayService = createReplayService(createDatabaseReplayPorts(databaseClient.db));
  let answerService: AnswerServicePort | undefined;
  if (resolvedModels) {
    const { chatPort, embeddingPort } = createBudgetedApiModels(databaseClient.db, resolvedModels);
    answerService = createAnswerService({
      chatPort,
      searchService: createSearchService(databaseClient.db),
      embeddingPort,
      logger: apiLogger,
      defaultTimeoutMs: 60000,
      coveragePort,
      embeddingProvider: resolvedModels.embedding?.profile.provider,
      embeddingProfileHash: resolvedModels.embedding
        ? collectionHash(resolvedModels.embedding.profile)
        : undefined,
      enableLiveSearch: false,
    });
  }
  const serverApp = createApp({
    databaseClient,
    answerService,
    coveragePort,
    collectionStatePort,
    resolveTargetPolicy: resolvedTargetPolicy,
    discoveryStatePort,
    embeddingWorkPort,
    providerBudgetPort,
    replayService,
    rateLimiter: new MemoryRateLimiter({
      ...(config.rateLimitWindowMs !== undefined ? { windowMs: config.rateLimitWindowMs } : {}),
      ...(config.rateLimitMaxRequests !== undefined
        ? { maxRequests: config.rateLimitMaxRequests }
        : {}),
    }),
    concurrencyLimiter: new ConcurrencyLimiter(
      config.maxConcurrentAnswers !== undefined
        ? { maxConcurrent: config.maxConcurrentAnswers }
        : {},
    ),
    budgetTracker: new DailyBudgetTracker(
      config.maxDailyAnswerBudget !== undefined
        ? { maxDailyQueries: config.maxDailyAnswerBudget }
        : {},
    ),
    collectionDispatcher,
    checkRedisHealth: async () => {
      await redis.ping();
      return true;
    },
    checkWorkerHealth: env['WORKER_HEALTH_URL']
      ? async () => {
          try {
            const res = await fetch(env['WORKER_HEALTH_URL']!, {
              signal: AbortSignal.timeout(3000),
            });
            return res.ok;
          } catch {
            return false;
          }
        }
      : undefined,
    logger: apiLogger,
    ...(config.opsApiKey ? { opsApiKey: config.opsApiKey } : {}),
    ...(config.corsAllowedOrigins ? { corsAllowedOrigins: config.corsAllowedOrigins } : {}),
  });
  logApiStartup(config.port);
  serverApp.listen(config.port, (server) => {
    // The Node adapter exposes its listener through this callback, not app.server.
    serverApp.stop = async () => {
      await server.stop();
      await collectionQueue.close();
      await redis.quit();
      await databaseClient.close();
      return serverApp;
    };
  });
  return serverApp;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
