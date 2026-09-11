import { Queue, Worker, type WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { parseCollectionDeliveryJobData, type CollectionDeliveryJobData } from './jobs.js';

export const DEFAULT_DELIVERY_QUEUE_NAME = 'techpulse-delivery' as const;
export const DEFAULT_INCREMENTAL_QUEUE_NAME = 'techpulse-incremental' as const;
export const DEFAULT_BACKFILL_QUEUE_NAME = 'techpulse-backfill' as const;

export interface DeliveryWorkerOptions {
  readonly connection: WorkerOptions['connection'];
  readonly queueName?: string | undefined;
  readonly concurrency?: number | undefined;
  readonly handle: (deliveryId: string) => Promise<void>;
}

export function createDeliveryWorker(
  options: DeliveryWorkerOptions,
): Worker<CollectionDeliveryJobData> {
  const concurrency = options.concurrency ?? 1;
  return new Worker<CollectionDeliveryJobData>(
    options.queueName ?? DEFAULT_DELIVERY_QUEUE_NAME,
    async (job) => {
      const data = parseCollectionDeliveryJobData(job.data);
      await options.handle(data.deliveryId);
    },
    {
      connection: options.connection,
      concurrency,
      maxStalledCount: 1,
    },
  );
}

export interface DualLaneScheduler {
  readonly incrementalQueue: Queue<CollectionDeliveryJobData>;
  readonly backfillQueue: Queue<CollectionDeliveryJobData>;
  readonly incrementalWorker: Worker<CollectionDeliveryJobData>;
  readonly backfillWorker: Worker<CollectionDeliveryJobData>;
  close(): Promise<void>;
}

export interface CreateDualLaneSchedulerOptions {
  readonly redisUrl: string;
  readonly incrementalConcurrency?: number | undefined;
  readonly backfillConcurrency?: number | undefined;
  readonly incrementalQueueName?: string | undefined;
  readonly backfillQueueName?: string | undefined;
  readonly handle: (deliveryId: string) => Promise<void>;
}

export function createDualLaneScheduler(
  options: CreateDualLaneSchedulerOptions,
): DualLaneScheduler {
  const incQueueRedis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const backQueueRedis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const incWorkerRedis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const backWorkerRedis = new Redis(options.redisUrl, { maxRetriesPerRequest: null });

  const incrementalQueue = new Queue<CollectionDeliveryJobData>(
    options.incrementalQueueName ?? DEFAULT_INCREMENTAL_QUEUE_NAME,
    {
      connection: incQueueRedis,
    },
  );
  const backfillQueue = new Queue<CollectionDeliveryJobData>(
    options.backfillQueueName ?? DEFAULT_BACKFILL_QUEUE_NAME,
    {
      connection: backQueueRedis,
    },
  );

  const incrementalWorker = createDeliveryWorker({
    connection: incWorkerRedis,
    queueName: options.incrementalQueueName ?? DEFAULT_INCREMENTAL_QUEUE_NAME,
    concurrency: options.incrementalConcurrency ?? 5,
    handle: options.handle,
  });

  const backfillWorker = createDeliveryWorker({
    connection: backWorkerRedis,
    queueName: options.backfillQueueName ?? DEFAULT_BACKFILL_QUEUE_NAME,
    concurrency: options.backfillConcurrency ?? 2,
    handle: options.handle,
  });

  return {
    incrementalQueue,
    backfillQueue,
    incrementalWorker,
    backfillWorker,
    async close() {
      await incrementalWorker.close();
      await backfillWorker.close();
      await incrementalQueue.close();
      await backfillQueue.close();
      await incWorkerRedis.quit();
      await backWorkerRedis.quit();
      await incQueueRedis.quit();
      await backQueueRedis.quit();
    },
  };
}

export {
  OutboxDispatcher,
  PartitionRuntime,
  createPartitionRuntime,
  planTargetPartitions,
  type DispatchCycleResult,
  type EmbeddingDeliveryHandler,
  type OutboxDispatcherOptions,
  type PartitionPlanningOptions,
  type PartitionRuntimeOptions,
  type PartitionRuntimeStatus,
  type PlanTargetPartitionsRequest,
} from './partition-runtime.js';

export type { CollectionDeliveryJobData };
