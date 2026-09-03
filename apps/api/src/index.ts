import {
  COLLECTION_QUEUE_JOB_NAME,
  createCollectionQueueJobData,
  type CollectionQueueJobData,
} from '@techpulse/contracts';
import { createDatabaseClient, createSearchService } from '@techpulse/database';
import {
  createOpenAiCompatibleChatPort,
  createOpenAiCompatibleEmbeddingPort,
} from '@techpulse/domain';
import { createAnswerService, type AnswerServicePort } from '@techpulse/rag';
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
import { createApp, type AppOptions } from './app.js';
import { ConcurrencyLimiter, DailyBudgetTracker, MemoryRateLimiter } from './abuse-controls.js';

export { createApp, type AppOptions };
export {
  createOpsRoutes,
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

export function start(env: Environment = process.env) {
  const config = loadApiConfig(env);
  const databaseClient = createDatabaseClient(config.databaseUrl);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const collectionQueue = new Queue<CollectionQueueJobData>('techpulse-collection', {
    connection: redis,
  });
  const collectionDispatcher = {
    dispatch: async (request: {
      readonly collectionRunId: string;
      readonly sourceKey: string;
      readonly cursor: string | null;
      readonly scheduledAt: Date;
    }): Promise<void> => {
      const windowEnd = new Date(request.scheduledAt.getTime() + 60 * 60 * 1000);
      const data = createCollectionQueueJobData(
        {
          schemaVersion: 1,
          collectionRunId: request.collectionRunId,
          sourceKey: request.sourceKey,
          cursor: request.cursor,
        },
        {
          from: request.scheduledAt.toISOString(),
          to: windowEnd.toISOString(),
        },
      );
      await collectionQueue.add(COLLECTION_QUEUE_JOB_NAME, data, {
        jobId: data.naturalKey,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: true,
      });
    },
  };

  let answerService: AnswerServicePort | undefined;
  if (config.aiChatApiKey) {
    const chatPort = createOpenAiCompatibleChatPort({
      apiKey: config.aiChatApiKey,
      ...(config.aiChatBaseUrl ? { baseUrl: config.aiChatBaseUrl } : {}),
      ...(config.aiChatModel ? { model: config.aiChatModel } : {}),
      ...(config.aiChatTimeoutMs !== undefined ? { defaultTimeoutMs: config.aiChatTimeoutMs } : {}),
    });
    const embeddingPort = config.aiEmbeddingApiKey
      ? createOpenAiCompatibleEmbeddingPort({
          apiKey: config.aiEmbeddingApiKey,
          ...(config.aiEmbeddingBaseUrl ? { baseUrl: config.aiEmbeddingBaseUrl } : {}),
          ...(config.aiEmbeddingModel ? { model: config.aiEmbeddingModel } : {}),
          ...(config.aiEmbeddingDimensions !== undefined
            ? { dimensions: config.aiEmbeddingDimensions }
            : {}),
        })
      : undefined;
    const searchService = createSearchService(databaseClient.db);
    answerService = createAnswerService({
      chatPort,
      searchService,
      embeddingPort,
      logger: apiLogger,
      defaultTimeoutMs: 60000,
      githubPat: env['GITHUB_PAT'],
      enableLiveSearch: true,
    });
  }

  const serverApp = createApp({
    databaseClient,
    answerService,
    collectionDispatcher,
    logger: apiLogger,
    rateLimiter:
      config.rateLimitWindowMs !== undefined || config.rateLimitMaxRequests !== undefined
        ? new MemoryRateLimiter(
            config.rateLimitWindowMs !== undefined || config.rateLimitMaxRequests !== undefined
              ? {
                  ...(config.rateLimitWindowMs !== undefined
                    ? { windowMs: config.rateLimitWindowMs }
                    : {}),
                  ...(config.rateLimitMaxRequests !== undefined
                    ? { maxRequests: config.rateLimitMaxRequests }
                    : {}),
                }
              : {},
          )
        : new MemoryRateLimiter(),
    ...(config.maxConcurrentAnswers !== undefined
      ? {
          concurrencyLimiter: new ConcurrencyLimiter({
            maxConcurrent: config.maxConcurrentAnswers,
          }),
        }
      : {}),
    ...(config.maxDailyAnswerBudget !== undefined
      ? { budgetTracker: new DailyBudgetTracker({ maxDailyQueries: config.maxDailyAnswerBudget }) }
      : {}),
    ...(config.opsApiKey ? { opsApiKey: config.opsApiKey } : {}),
    ...(config.corsAllowedOrigins ? { corsAllowedOrigins: config.corsAllowedOrigins } : {}),
  });
  logApiStartup(config.port);
  return serverApp.listen(config.port);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
