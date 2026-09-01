export {
  COLLECTION_JOB_NAME,
  MAX_JOB_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  WORKER_JOB_SCHEMA_VERSION,
  collectionJobNaturalKey,
  createCollectionJobData,
  normalizeScheduleWindow,
  parseCollectionJobData,
  retryBackoffMs,
  WorkerJobValidationError,
  type CollectionJobData,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
