export {
  COLLECTION_JOB_NAME,
  NORMALIZATION_JOB_NAME,
  DEDUPLICATION_JOB_NAME,
  MAX_JOB_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  WORKER_JOB_SCHEMA_VERSION,
  collectionJobNaturalKey,
  createCollectionJobData,
  createNormalizationJobData,
  createDeduplicationJobData,
  normalizeScheduleWindow,
  parseCollectionJobData,
  parseNormalizationJobData,
  parseDeduplicationJobData,
  retryBackoffMs,
  WorkerJobValidationError,
  type CollectionJobData,
  type NormalizationJobData,
  type DeduplicationJobData,
  type ScheduleWindow,
} from './jobs.js';
export {
  InMemorySourceConcurrencyLimiter,
  LeaseOwnershipLostError,
  LeaseReleaseError,
  LeaseRenewalError,
  RedisSourceConcurrencyLimiter,
  leaseRenewalIntervalMs,
  type RedisSourceConcurrencyLimiterOptions,
  type SourceConcurrency,
  type SourceConcurrencyLimiter,
} from './concurrency.js';
export {
  createCollectionScheduler,
  createCollectionWorker,
  directDeliveryBoundary,
  enqueueCollectionJob,
  InMemoryIdempotentDeliveryBoundary,
  InMemoryJobClaimStore,
  type JobClaimStore,
  RedisJobClaimStore,
  processCollectionJob,
  type CollectionOperation,
  type CollectionScheduler,
  type CreateSchedulerOptions,
  type DeliveryBoundary,
  type DeliveryResult,
  type EnqueueOptions,
  type EnqueueResult,
} from './scheduler.js';
export { createIngestionJobHandler, type IngestionJobHandlerOptions } from './ingestion.js';
export {
  createNormalizationJobHandler,
  type NormalizationJobHandlerOptions,
  type NormalizationExecutionResult,
  type NormalizationOperation,
} from './normalization.js';
export {
  createDeduplicationJobHandler,
  type DeduplicationJobHandlerOptions,
  type DeduplicationExecutionResult,
  type DeduplicationOperation,
} from './deduplication.js';
import {
  createDatabaseClient,
  createRawItemRepository,
  createSourceRepository,
  createCollectionRunRepository,
} from '@techpulse/database';
import {
  GitHubReleasesCollector,
  GitHubSearchCollector,
  StackExchangeCollector,
} from '@techpulse/collectors';
import { createRawIngestionService } from '@techpulse/domain';
import { Redis } from 'ioredis';
import { createCollectionWorker } from './scheduler.js';
import { createIngestionJobHandler } from './ingestion.js';
import { loadWorkerConfig, type Environment, type WorkerConfig } from './config.js';
import {
  createStructuredLogger,
  isValidCorrelationId,
  normalizeCorrelationContext,
  type CorrelationContext,
  type StructuredEvent,
} from '@techpulse/observability';
import { pathToFileURL } from 'node:url';

export const workerLogger = createStructuredLogger({ service: 'worker' });

function firstValidCorrelationAlias(
  candidate: Record<string, unknown>,
  aliases: readonly string[],
): string | undefined {
  for (const alias of aliases) {
    const value = candidate[alias];
    if (isValidCorrelationId(value)) return value;
  }
  return undefined;
}

/** Worker boundary IDs are read without coupling this skeleton to a job package. */
export function jobCorrelationContext(job: unknown): CorrelationContext {
  if (typeof job !== 'object' || job === null || Array.isArray(job)) return {};
  const candidate = job as Record<string, unknown>;
  return normalizeCorrelationContext({
    requestId: candidate['requestId'],
    runId: firstValidCorrelationAlias(candidate, ['runId', 'queryRunId', 'collectionRunId']),
    jobId: candidate['jobId'],
    sourceId: candidate['sourceId'],
    queryId: candidate['queryId'],
  });
}

export function logJobStarted(job: unknown): StructuredEvent {
  return workerLogger.withContext(jobCorrelationContext(job)).info('worker.job.started');
}

export function logJobFinished(job: unknown): StructuredEvent {
  return workerLogger.withContext(jobCorrelationContext(job)).info('worker.job.finished');
}

/**
 * Worker process entrypoint. Job registration starts after QUE-001.
 */
export const workerEntrypoint = '@techpulse/worker';
export function start(env: Environment = process.env): WorkerConfig {
  const config = loadWorkerConfig(env);
  workerLogger.info('worker.starting');
  return config;
}

async function runWorkerProcess(env: Environment = process.env): Promise<void> {
  const config = start(env);
  const databaseClient = createDatabaseClient(config.databaseUrl);
  const sourceRepository = createSourceRepository(databaseClient.db);
  const collectionRunRepository = createCollectionRunRepository(databaseClient.db);
  const rawItemRepository = createRawItemRepository(databaseClient.db);
  const collectors = {
    github_releases: new GitHubReleasesCollector({ owner: 'microsoft', repo: 'playwright' }),
    github_search: new GitHubSearchCollector({ query: 'topic:typescript stars:>500' }),
    stack_exchange: new StackExchangeCollector({}),
  };
  const ingestionService = createRawIngestionService({
    sourceRepository,
    collectionRunRepository,
    rawItemRepository,
    collectorResolver: (sourceKey) => collectors[sourceKey as keyof typeof collectors],
    logger: workerLogger,
  });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const worker = createCollectionWorker({
    connection: redis,
    concurrency: config.concurrency,
    handle: createIngestionJobHandler(ingestionService),
  });
  const shutdown = async () => {
    await worker.close();
    await redis.quit();
    await databaseClient.close();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  await new Promise<void>(() => undefined);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorkerProcess();
}
