import {
  Queue,
  UnrecoverableError,
  Worker,
  type Job,
  type QueueOptions,
  type WorkerOptions,
} from 'bullmq';
import { Redis } from 'ioredis';
import type { CollectionJobPayload, SourceKey } from '@techpulse/contracts';
import {
  COLLECTION_JOB_NAME,
  createCollectionJobData,
  MAX_JOB_ATTEMPTS,
  parseCollectionJobData,
  retryBackoffMs,
  WorkerJobValidationError,
  type CollectionJobData,
  type ScheduleWindow,
} from './jobs.js';
import {
  InMemorySourceConcurrencyLimiter,
  RedisSourceConcurrencyLimiter,
  type RedisSourceConcurrencyLimiterOptions,
  type SourceConcurrency,
  type SourceConcurrencyLimiter,
} from './concurrency.js';
export const DEFAULT_QUEUE_NAME = 'techpulse-collection' as const;

export type DeliveryResult = 'committed' | 'already_committed';
export type CollectionOperation = (payload: CollectionJobPayload) => Promise<void>;
export type DeliveryBoundary = (
  data: CollectionJobData,
  operation: CollectionOperation,
) => Promise<DeliveryResult>;

/**
 * The callback is the PostgreSQL transaction boundary in production. Redis
 * only transports the job; it is never treated as the business completion
 * store. A retry after commit must return already_committed from this layer.
 */
export const directDeliveryBoundary: DeliveryBoundary = async (_data, operation) => {
  await operation(_data.payload);
  return 'committed';
};

/**
 * Deterministic test boundary. A real adapter must replace this with a
 * PostgreSQL unique-natural-key insert/upsert in the same transaction as the
 * business completion; this map intentionally does not claim restart safety.
 */
export class InMemoryIdempotentDeliveryBoundary {
  private readonly committedKeys = new Set<string>();

  async deliver(data: CollectionJobData, operation: CollectionOperation): Promise<DeliveryResult> {
    if (this.committedKeys.has(data.naturalKey)) return 'already_committed';
    await operation(data.payload);
    this.committedKeys.add(data.naturalKey);
    return 'committed';
  }
}

export interface EnqueueOptions {
  readonly now?: Date;
  readonly attempts?: number;
  readonly delayMs?: number;
}

export interface EnqueueResult {
  readonly job: Job<CollectionJobData>;
  readonly duplicate: boolean;
}

export async function enqueueCollectionJob(
  queue: Queue<CollectionJobData>,
  payloadInput: unknown,
  scheduleWindowInput: unknown,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const data = createCollectionJobData(payloadInput, scheduleWindowInput);
  const attempts = options.attempts ?? MAX_JOB_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_JOB_ATTEMPTS) {
    throw new RangeError(`attempts must be an integer between 1 and ${MAX_JOB_ATTEMPTS}`);
  }
  const existing = await queue.getJob(data.naturalKey);
  if (existing) return { job: existing as Job<CollectionJobData>, duplicate: true };

  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new RangeError('now must be a valid Date');
  const from = new Date(data.scheduleWindow.from);
  const delayMs = options.delayMs ?? Math.max(0, from.getTime() - now.getTime());
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new RangeError('delayMs must be a non-negative safe integer');
  }
  const job = await queue.add(COLLECTION_JOB_NAME, data, {
    jobId: data.naturalKey,
    delay: delayMs,
    attempts,
    backoff: { type: 'bounded-exponential', delay: 1_000 },
    removeOnComplete: false,
    removeOnFail: false,
  });
  return { job, duplicate: false };
}

export async function processCollectionJob(
  rawData: unknown,
  limiter: SourceConcurrencyLimiter,
  handle: CollectionOperation,
  deliveryBoundary: DeliveryBoundary = directDeliveryBoundary,
): Promise<DeliveryResult> {
  const data = parseCollectionJobData(rawData);
  return limiter.run(data.payload.sourceKey, () => deliveryBoundary(data, handle));
}

export interface CollectionWorkerOptions {
  readonly connection: WorkerOptions['connection'];
  readonly queueName?: string;
  readonly concurrency?: number;
  readonly sourceLimiter?: SourceConcurrencyLimiter;
  readonly deliveryBoundary?: DeliveryBoundary;
  readonly handle: CollectionOperation;
}

export function createCollectionWorker(
  options: CollectionWorkerOptions,
): Worker<CollectionJobData> {
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new RangeError('concurrency must be an integer between 1 and 100');
  }
  const limiter = options.sourceLimiter ?? new InMemorySourceConcurrencyLimiter(concurrency);
  const worker = new Worker<CollectionJobData>(
    options.queueName ?? DEFAULT_QUEUE_NAME,
    async (job) => {
      try {
        return await processCollectionJob(
          job.data,
          limiter,
          options.handle,
          options.deliveryBoundary ?? directDeliveryBoundary,
        );
      } catch (error) {
        if (error instanceof WorkerJobValidationError) {
          throw new UnrecoverableError(error.message);
        }
        throw error;
      }
    },
    {
      connection: options.connection,
      concurrency,
      maxStalledCount: 1,
      settings: {
        backoffStrategy: (attemptsMade, type) => {
          if (type !== 'bounded-exponential') {
            throw new Error(`unsupported backoff strategy: ${type ?? 'missing'}`);
          }
          return retryBackoffMs(attemptsMade);
        },
      },
    },
  );
  return worker;
}

export interface CollectionScheduler {
  readonly queue: Queue<CollectionJobData>;
  readonly worker: Worker<CollectionJobData>;
  close(): Promise<void>;
}

export interface CreateSchedulerOptions {
  readonly redisUrl: string;
  readonly queueName?: string;
  readonly concurrency?: number;
  readonly sourceConcurrency?: SourceConcurrency;
  readonly handle: CollectionOperation;
  readonly deliveryBoundary?: DeliveryBoundary;
  readonly redisLimiterOptions?: RedisSourceConcurrencyLimiterOptions;
}

export function createCollectionScheduler(options: CreateSchedulerOptions): CollectionScheduler {
  const queueName = options.queueName ?? DEFAULT_QUEUE_NAME;
  const queueRedis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const workerRedis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const limiterRedis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const queueOptions: QueueOptions = { connection: queueRedis };
  const queue = new Queue<CollectionJobData>(queueName, queueOptions);
  const sourceLimiter = new RedisSourceConcurrencyLimiter(
    limiterRedis,
    options.sourceConcurrency ?? options.concurrency ?? 1,
    options.concurrency ?? 1,
    options.redisLimiterOptions,
  );
  const worker = createCollectionWorker({
    connection: workerRedis,
    queueName,
    concurrency: options.concurrency ?? 1,
    sourceLimiter,
    deliveryBoundary: options.deliveryBoundary ?? directDeliveryBoundary,
    handle: options.handle,
  });
  return {
    queue,
    worker,
    async close() {
      await worker.close();
      await queue.close();
      await sourceLimiter.close?.();
      await workerRedis.quit();
      await queueRedis.quit();
    },
  };
}

export type { CollectionJobData, ScheduleWindow, SourceKey };
