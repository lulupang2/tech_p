export {
  DELIVERY_JOB_SCHEMA_VERSION,
  DELIVERY_JOB_NAME,
  PARTITION_COLLECTION_JOB_NAME,
  NORMALIZATION_JOB_NAME,
  DEDUPLICATION_JOB_NAME,
  MAX_JOB_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  retryBackoffMs,
  WorkerJobValidationError,
  createCollectionDeliveryJobData,
  parseCollectionDeliveryJobData,
  type CollectionDeliveryJobData,
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
  DEFAULT_DELIVERY_QUEUE_NAME,
  DEFAULT_INCREMENTAL_QUEUE_NAME,
  DEFAULT_BACKFILL_QUEUE_NAME,
  createDeliveryWorker,
  createDualLaneScheduler,
  type DeliveryWorkerOptions,
  type DualLaneScheduler,
  type CreateDualLaneSchedulerOptions,
} from './scheduler.js';
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
export {
  createPartitionCollectionService,
  createPartitionCollectionJobHandler,
  type PartitionCollectionServicePort,
  type PartitionCollectionServiceOptions,
  type ExecutePartitionPageRequest,
  type ExecutePartitionPageResult,
  type TargetCollectorResolver,
} from './ingestion.js';
export {
  createNormalizationDeliveryHandler,
  type NormalizationJobHandlerOptions,
  type NormalizationExecutionResult,
  type NormalizationDeliveryOperation,
  type NormalizationDeliveryRequest,
} from './normalization.js';
export {
  createDeduplicationJobHandler,
  type DeduplicationJobHandlerOptions,
  type DeduplicationExecutionResult,
  type DeduplicationOperation,
} from './deduplication.js';
export {
  createWorkerEmbeddingService,
  createWorkerEmbeddingHandler,
  type CreateWorkerEmbeddingServiceOptions,
  type WorkerEmbeddingHandlerOptions,
} from './embedding.js';
export { WorkerLifecycle, type WorkerHealthInfo, type WorkerHealthStatus } from './health.js';
export {
  loadWorkerConfig,
  WorkerConfigError,
  type Environment,
  type WorkerConfig,
  type WorkerEmbeddingConfig,
} from './config.js';
import {
  createChunkRepository,
  createCollectionStateRepository,
  createDatabaseClient,
  createDocumentRepository,
  createDuplicateClusterRepository,
  createEmbeddingWorkRepository,
  createMetricObservationRepository,
  createPipelineEventRepository,
  createProviderBudgetRepository,
  createRawItemRepository,
  createSourceRepository,
  createSearchReadinessRepository,
  createTopicRepository,
  type DatabaseClient,
} from '@techpulse/database';
import { createCollectorPageAdapter } from '@techpulse/collectors';
import type { CollectionStatePort, EmbeddingService, ModelProfile } from '@techpulse/domain';
import {
  createEnrichmentService,
  createNormalizationService,
  createDeduplicationService,
} from '@techpulse/domain';
import { createPartitionRuntime, type PartitionRuntime } from './partition-runtime.js';
import { createDeduplicationJobHandler } from './deduplication.js';
import { createPartitionCollectionService, type TargetCollectorResolver } from './ingestion.js';
import { createNormalizationDeliveryHandler } from './normalization.js';
import { createWorkerEmbeddingHandler, createWorkerEmbeddingService } from './embedding.js';
import { createDualLaneScheduler, type DualLaneScheduler } from './scheduler.js';
import { loadWorkerConfig, type Environment, type WorkerConfig } from './config.js';
import { WorkerLifecycle, type WorkerHealthInfo } from './health.js';
import { createCollectionDeliveryJobData } from './jobs.js';
import {
  createStructuredLogger,
  isValidCorrelationId,
  normalizeCorrelationContext,
  type CorrelationContext,
  type StructuredEvent,
} from '@techpulse/observability';
import { createServer, type Server } from 'node:http';
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

/** Worker boundary IDs are read without coupling to a specific job package. */
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

export const workerEntrypoint = '@techpulse/worker';

export function start(env: Environment = process.env): WorkerConfig {
  const config = loadWorkerConfig(env);
  workerLogger.info('worker.starting');
  return config;
}

export interface WorkerRuntime {
  readonly config: WorkerConfig;
  readonly databaseClient: DatabaseClient;
  readonly runtime: PartitionRuntime;
  readonly dualLaneScheduler?: DualLaneScheduler | undefined;
  readonly lifecycle: WorkerLifecycle;
  readonly healthServer?: Server | undefined;
  getHealth(): WorkerHealthInfo;
  stop(): Promise<void>;
}

export interface CreateWorkerRuntimeOptions {
  readonly env?: Environment | undefined;
  readonly config?: WorkerConfig | undefined;
  readonly databaseClient?: DatabaseClient | undefined;
  readonly stateRepository?: CollectionStatePort | undefined;
  readonly embeddingService?: EmbeddingService | undefined;
  readonly embeddingProfile?: ModelProfile | undefined;
  readonly collectorResolver?: TargetCollectorResolver | undefined;
  readonly now?: (() => Date) | undefined;
  readonly enableDualLaneScheduler?: boolean | undefined;
  readonly enableHealthServer?: boolean | undefined;
  readonly healthPort?: number | undefined;
}

/**
 * Assembles the durable worker runtime with PostgreSQL completion authority,
 * Redis-loss recovery via PartitionRuntime/OutboxDispatcher, fail-closed model/budget gates,
 * and observable health lifecycle.
 */
export async function createWorkerRuntime(
  options: CreateWorkerRuntimeOptions = {},
): Promise<WorkerRuntime> {
  const config = options.config ?? loadWorkerConfig(options.env ?? process.env);
  const databaseClient = options.databaseClient ?? createDatabaseClient(config.databaseUrl);
  const getNow = options.now ?? (() => new Date());

  const stateRepository =
    options.stateRepository ?? createCollectionStateRepository(databaseClient.db);
  const sourceRepository = createSourceRepository(databaseClient.db);
  const rawItemRepository = createRawItemRepository(databaseClient.db);
  const documentRepository = createDocumentRepository(databaseClient.db);
  const metricObservationRepository = createMetricObservationRepository(databaseClient.db);
  const pipelineEventRepository = createPipelineEventRepository(databaseClient.db);
  const topicRepository = createTopicRepository(databaseClient.db);
  const chunkRepository = createChunkRepository(databaseClient.db);
  const providerBudgetRepository = createProviderBudgetRepository(databaseClient.db);
  const embeddingWorkRepository = createEmbeddingWorkRepository(databaseClient.db);
  const readinessRepository = createSearchReadinessRepository(databaseClient.db);

  const enrichmentService = createEnrichmentService({ topicRepository, chunkRepository });
  const deduplicate = createDeduplicationJobHandler({
    deduplicationService: createDeduplicationService(),
    documentRepository,
    duplicateClusterRepository: createDuplicateClusterRepository(databaseClient.db),
    rawItemRepository,
    pipelineEventRepository,
  });
  const normalizationService = createNormalizationService();

  const defaultCollectorPageAdapter = createCollectorPageAdapter();
  const collectorResolver: TargetCollectorResolver =
    options.collectorResolver ?? (() => defaultCollectorPageAdapter);

  let embeddingService = options.embeddingService;
  let embeddingProfile = options.embeddingProfile;

  if (!embeddingService) {
    const embeddingSetup = createWorkerEmbeddingService({
      config: config.embedding,
      allowFixtureProviders: config.allowFixtureProviders,
      workPort: embeddingWorkRepository,
      budgetPort: providerBudgetRepository,
      now: getNow,
    });
    if (embeddingSetup) {
      embeddingService = embeddingSetup.embeddingService;
      embeddingProfile = embeddingProfile ?? embeddingSetup.profile;
    }
  }

  const embeddingHandler = createWorkerEmbeddingHandler({
    stateRepository,
    embeddingService,
    chunkRepository,
    documentRepository,
    profile: embeddingProfile,
    logger: workerLogger,
    now: getNow,
  });

  const normalizationHandler = createNormalizationDeliveryHandler({
    normalizationService,
    rawItemRepository,
    documentRepository,
    metricObservationRepository,
    pipelineEventRepository,
    sourceRepository,
    collectionStateRepository: stateRepository,
    enrichmentService,
    readinessRepository,
    deduplicate,
  });

  const runtime = createPartitionRuntime({
    stateRepository,
    collectorResolver,
    normalizationOptions: {
      normalizationService,
      rawItemRepository,
      documentRepository,
      metricObservationRepository,
      pipelineEventRepository,
      sourceRepository,
      collectionStateRepository: stateRepository,
      enrichmentService,
      readinessRepository,
      deduplicate,
    },
    embeddingHandler,
    enqueue: async (delivery) => {
      if (!dualLaneScheduler) throw new Error('Delivery transport unavailable');
      const partition = await stateRepository.getPartition(delivery.partitionId);
      if (!partition) throw new Error('Delivery partition missing');
      const queue =
        partition.mode === 'backfill'
          ? dualLaneScheduler.backfillQueue
          : dualLaneScheduler.incrementalQueue;
      await queue.add('delivery', createCollectionDeliveryJobData(delivery.id), {
        jobId: delivery.id,
        removeOnComplete: true,
        removeOnFail: true,
      });
    },
    now: getNow,
    leaseMs: config.leaseMs,
    incrementalConcurrency: config.incrementalConcurrency,
    backfillConcurrency: config.backfillConcurrency,
    pollIntervalMs: config.pollIntervalMs,
    onTick: (success, err) => {
      lifecycle.recordTick(success, err instanceof Error ? err : err ? String(err) : null);
    },
  });

  const lifecycle = new WorkerLifecycle(getNow());

  let dualLaneScheduler: DualLaneScheduler | undefined = undefined;
  if (options.enableDualLaneScheduler !== false && config.redisUrl) {
    try {
      const partitionService = createPartitionCollectionService({
        stateRepository,
        collectorResolver,
        now: getNow,
        leaseMs: config.leaseMs,
      });

      dualLaneScheduler = createDualLaneScheduler({
        redisUrl: config.redisUrl,
        incrementalConcurrency: config.incrementalConcurrency,
        backfillConcurrency: config.backfillConcurrency,
        handle: async (deliveryId: string) => {
          await stateRepository.markSent(deliveryId, 0, getNow()).catch(() => {});
          const delivery = await stateRepository.getDelivery(deliveryId);
          // Idempotency: skip if missing or already completed in PostgreSQL
          if (!delivery || delivery.completedAt !== null) {
            return;
          }

          if (delivery.kind === 'collection') {
            const res = await partitionService.executePartitionPage({
              partitionId: delivery.partitionId,
              pageSequence: delivery.pageSequence,
            });
            if (res.disposition === 'deferred' && res.errorSummary) {
              throw new Error(`Collection page deferred: ${res.errorSummary}`);
            }
          } else if (delivery.kind === 'normalization' && delivery.rawItemId) {
            const result = await normalizationHandler({
              deliveryId: delivery.id,
              rawItemId: delivery.rawItemId,
            });
            if (result.status !== 'succeeded') throw new Error('Normalization delivery failed');
          } else if (delivery.kind === 'embedding' && delivery.revisionId) {
            await embeddingHandler({
              deliveryId: delivery.id,
              revisionId: delivery.revisionId,
            });
          }
        },
      });
    } catch (err) {
      await runtime.stop();
      if (!options.databaseClient) await databaseClient.close();
      throw err;
    }
  }
  if (!dualLaneScheduler) {
    if (!options.databaseClient) await databaseClient.close();
    throw new Error('Redis delivery transport is required');
  }
  await Promise.all([
    dualLaneScheduler.incrementalWorker.waitUntilReady(),
    dualLaneScheduler.backfillWorker.waitUntilReady(),
  ]);
  runtime.start();
  lifecycle.setRunning();

  let healthServer: Server | undefined = undefined;
  const healthPort = options.healthPort ?? config.healthPort;
  if (healthPort !== undefined && options.enableHealthServer !== false) {
    healthServer = createServer((req, res) => {
      const url = req.url?.split('?')[0] ?? '/';
      if (url === '/health/live' || url === '/live') {
        const health = lifecycle.getHealth(runtime.getStatus());
        const isLive = health.status !== 'stopped';
        res.writeHead(isLive ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: isLive ? 'ok' : 'unavailable',
            timestamp: new Date().toISOString(),
          }),
        );
      } else if (url === '/health/ready' || url === '/ready' || url === '/health') {
        const health = lifecycle.getHealth(runtime.getStatus());
        const isReady = health.isHealthy && runtime.getStatus().running;
        res.writeHead(isReady ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: isReady ? 'ok' : 'unavailable',
            timestamp: new Date().toISOString(),
            worker: health,
          }),
        );
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      }
    });

    healthServer.listen(healthPort, '0.0.0.0', () => {
      workerLogger.info('worker.healthServer.started', { port: healthPort });
    });
  }

  const stop = async () => {
    lifecycle.setStopped();
    if (healthServer) {
      await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
    }
    await runtime.stop();
    if (dualLaneScheduler) {
      await dualLaneScheduler.close();
    }
    if (!options.databaseClient) {
      await databaseClient.close();
    }
  };

  return {
    config,
    databaseClient,
    runtime,
    dualLaneScheduler,
    lifecycle,
    ...(healthServer ? { healthServer } : {}),
    getHealth: () => lifecycle.getHealth(runtime.getStatus()),
    stop,
  };
}

async function runWorkerProcess(env: Environment = process.env): Promise<WorkerRuntime> {
  const config = loadWorkerConfig(env);
  const healthPort = config.healthPort ?? 3001;
  const runtime = await createWorkerRuntime({
    env,
    healthPort,
    enableHealthServer: true,
  });
  const shutdown = async () => {
    await runtime.stop();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  return runtime;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorkerProcess();
}
