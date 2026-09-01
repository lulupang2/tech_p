import { loadWorkerConfig, type Environment, type WorkerConfig } from './config.js';
import {
  createStructuredLogger,
  normalizeCorrelationContext,
  type CorrelationContext,
  type StructuredEvent,
} from '../../../packages/observability/src/index.js';
import { pathToFileURL } from 'node:url';

export const workerLogger = createStructuredLogger({ service: 'worker' });

/** Worker boundary IDs are read without coupling this skeleton to a job package. */
export function jobCorrelationContext(job: unknown): CorrelationContext {
  if (typeof job !== 'object' || job === null || Array.isArray(job)) return {};
  const candidate = job as Record<string, unknown>;
  return normalizeCorrelationContext({
    requestId: candidate['requestId'],
    runId: candidate['runId'] ?? candidate['queryRunId'] ?? candidate['collectionRunId'],
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
