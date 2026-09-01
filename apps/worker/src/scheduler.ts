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
  private readonly inFlight = new Map<string, Promise<DeliveryResult>>();

  deliver(data: CollectionJobData, operation: CollectionOperation): Promise<DeliveryResult> {
    if (this.committedKeys.has(data.naturalKey)) return Promise.resolve('already_committed');
    const pending = this.inFlight.get(data.naturalKey);
    if (pending) return pending;
    const delivery = (async () => {
      await operation(data.payload);
      this.committedKeys.add(data.naturalKey);
      return 'committed' as const;
    })();
    this.inFlight.set(data.naturalKey, delivery);
    const removeInFlight = (): void => {
      if (this.inFlight.get(data.naturalKey) === delivery) this.inFlight.delete(data.naturalKey);
    };
    void delivery.then(removeInFlight, removeInFlight);
    return delivery;
  }
}
export interface JobClaimStore {
  claim(naturalKey: string): Promise<boolean>;
  release(naturalKey: string): Promise<void>;
}

export class InMemoryJobClaimStore implements JobClaimStore {
  private readonly claimed = new Set<string>();

  async claim(naturalKey: string): Promise<boolean> {
    if (this.claimed.has(naturalKey)) return false;
    this.claimed.add(naturalKey);
    return true;
  }

  async release(naturalKey: string): Promise<void> {
    this.claimed.delete(naturalKey);
  }
}

export class RedisJobClaimStore implements JobClaimStore {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = 'techpulse:worker:job-claim',
    private readonly claimTtlMs = 60_000,
  ) {
    if (!Number.isSafeInteger(claimTtlMs) || claimTtlMs < 1_000) {
      throw new RangeError('claimTtlMs must be a safe integer of at least 1000ms');
    }
  }

  async claim(naturalKey: string): Promise<boolean> {
    const result = await this.redis.set(
      `${this.keyPrefix}:${naturalKey}`,
      '1',
      'PX',
      this.claimTtlMs,
      'NX',
    );
    return result === 'OK';
  }

  async release(naturalKey: string): Promise<void> {
    await this.redis.del(`${this.keyPrefix}:${naturalKey}`);
  }
}

export interface EnqueueOptions {
  readonly claimStore: JobClaimStore;
  readonly now?: Date;
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly claimWaitMs?: number;
  readonly claimPollMs?: number;
}

export interface EnqueueResult {
  readonly job: Job<CollectionJobData>;
  readonly duplicate: boolean;
}

async function waitForExistingJob(
  queue: Queue<CollectionJobData>,
  naturalKey: string,
  waitMs: number,
  pollMs: number,
): Promise<Job<CollectionJobData> | undefined> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const existing = await queue.getJob(naturalKey);
    if (existing) return existing as Job<CollectionJobData>;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return undefined;
}

export async function enqueueCollectionJob(
  queue: Queue<CollectionJobData>,
  payloadInput: unknown,
  scheduleWindowInput: unknown,
  options: EnqueueOptions,
): Promise<EnqueueResult> {
  const data = createCollectionJobData(payloadInput, scheduleWindowInput);
  const attempts = options.attempts ?? MAX_JOB_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_JOB_ATTEMPTS) {
    throw new RangeError(`attempts must be an integer between 1 and ${MAX_JOB_ATTEMPTS}`);
  }
  const claimWaitMs = options.claimWaitMs ?? 5_000;
  const claimPollMs = options.claimPollMs ?? 10;
  if (
    !Number.isSafeInteger(claimWaitMs) ||
    !Number.isSafeInteger(claimPollMs) ||
    claimWaitMs < claimPollMs ||
    claimPollMs < 1
  ) {
    throw new RangeError('claim wait and poll values are invalid');
  }

  const claimed = await options.claimStore.claim(data.naturalKey);
  if (!claimed) {
    const existing = await waitForExistingJob(queue, data.naturalKey, claimWaitMs, claimPollMs);
    if (!existing) {
      throw new Error('natural-key claim exists but the BullMQ job is not visible');
    }
    return { job: existing, duplicate: true };
  }

  try {
    const existing = await queue.getJob(data.naturalKey);
    if (existing) {
      await options.claimStore.release(data.naturalKey);
      return { job: existing as Job<CollectionJobData>, duplicate: true };
    }
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
  } catch (error) {
    try {
      await options.claimStore.release(data.naturalKey);
    } catch (releaseError) {
      if (error instanceof Error && error.cause === undefined) error.cause = releaseError;
    }
    throw error;
  }
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
