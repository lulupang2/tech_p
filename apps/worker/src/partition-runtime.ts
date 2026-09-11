import {
  assertCollectableTarget,
  CollectionStateError,
  type CollectionMode,
  type CollectionDelivery,
  type CollectionPartition,
  type CollectionStatePort,
  type CollectionTargetRevision,
  type CollectionWindow,
  type PartitionPlan,
} from '@techpulse/domain';
import {
  createPartitionCollectionService,
  type PartitionCollectionServicePort,
  type TargetCollectorResolver,
} from './ingestion.js';
import type {
  NormalizationDeliveryOperation,
  NormalizationJobHandlerOptions,
} from './normalization.js';
import { createNormalizationDeliveryHandler } from './normalization.js';
export interface PartitionPlanningOptions {
  readonly stateRepository: CollectionStatePort;
  readonly now?: (() => Date) | undefined;
  readonly defaultSliceDurationMs?: number | undefined;
}

export interface PlanTargetPartitionsRequest {
  readonly target: CollectionTargetRevision;
  readonly mode: CollectionMode;
  readonly window?: CollectionWindow | undefined;
  readonly scopeKey?: string | undefined;
  readonly workflowVersion?: string | undefined;
  readonly sliceDurationMs?: number | undefined;
}

/**
 * Plans partitions for a target revision based on mode, capability, and time basis.
 * Rejects disabled sources/targets and unsupported history modes for backfill.
 */
export async function planTargetPartitions(
  options: PartitionPlanningOptions,
  request: PlanTargetPartitionsRequest,
): Promise<readonly CollectionPartition[]> {
  const getNow = options.now ?? (() => new Date());
  const now = getNow();
  const target = request.target;

  assertCollectableTarget(target);

  const scopeKey = request.scopeKey ?? 'default';
  const workflowVersion = request.workflowVersion ?? '1';
  const timeBasis = target.capability.timeBasis;

  if (request.mode === 'backfill') {
    if (
      target.capability.historyMode === 'feed_only' ||
      target.capability.historyMode === 'snapshot_only'
    ) {
      throw new CollectionStateError('invalid_window');
    }

    if (!request.window) {
      throw new CollectionStateError('invalid_window');
    }

    const fromTime = request.window.from.getTime();
    const toTime = request.window.to.getTime();
    if (fromTime >= toTime) {
      throw new CollectionStateError('invalid_window');
    }

    const sliceDurationMs =
      request.sliceDurationMs ?? options.defaultSliceDurationMs ?? 7 * 24 * 60 * 60 * 1000;

    const partitions: CollectionPartition[] = [];
    let currentFrom = fromTime;

    while (currentFrom < toTime) {
      const currentTo = Math.min(currentFrom + sliceDurationMs, toTime);
      const plan: PartitionPlan = {
        targetRevisionId: target.id,
        mode: 'backfill',
        scopeKey,
        window: {
          from: new Date(currentFrom),
          to: new Date(currentTo),
        },
        timeBasis,
        workflowVersion,
      };

      const partition = await options.stateRepository.planPartition(plan, now);
      partitions.push(partition);
      currentFrom = currentTo;
    }

    return partitions;
  }

  if (request.mode === 'incremental') {
    const cadenceMs = target.cadenceMs ?? 60 * 60 * 1000;
    const overlapMs = target.overlapMs ?? 60 * 1000;

    const windowTo = request.window?.to ?? now;
    const windowFrom = request.window?.from ?? new Date(windowTo.getTime() - cadenceMs - overlapMs);

    if (windowFrom.getTime() >= windowTo.getTime()) {
      throw new CollectionStateError('invalid_window');
    }

    const plan: PartitionPlan = {
      targetRevisionId: target.id,
      mode: 'incremental',
      scopeKey,
      window: {
        from: windowFrom,
        to: windowTo,
      },
      timeBasis,
      workflowVersion,
    };

    const partition = await options.stateRepository.planPartition(plan, now);
    return [partition];
  }

  // on_demand mode
  if (!request.window) {
    throw new CollectionStateError('invalid_window');
  }

  const plan: PartitionPlan = {
    targetRevisionId: target.id,
    mode: 'on_demand',
    scopeKey,
    window: request.window,
    timeBasis,
    workflowVersion,
  };

  const partition = await options.stateRepository.planPartition(plan, now);
  return [partition];
}

export type EmbeddingDeliveryHandler = (delivery: {
  deliveryId: string;
  revisionId: string;
}) => Promise<void>;

export interface OutboxDispatcherOptions {
  readonly stateRepository: CollectionStatePort;
  readonly partitionService: PartitionCollectionServicePort;
  readonly normalizationHandler?: NormalizationDeliveryOperation | undefined;
  readonly embeddingHandler?: EmbeddingDeliveryHandler | undefined;
  readonly enqueue?:
    ((delivery: CollectionDelivery, mode?: CollectionMode) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly leaseMs?: number | undefined;
  readonly batchLimit?: number | undefined;
}

export interface DispatchCycleResult {
  readonly claimedCount: number;
  readonly processedCount: number;
  readonly failures: readonly { deliveryId: string; error: string }[];
}

/**
 * Dispatches deliveries from the PostgreSQL delivery outbox.
 * Supports Redis message loss recovery by re-claiming pending/expired outbox rows.
 */
export class OutboxDispatcher {
  private readonly stateRepository: CollectionStatePort;
  private readonly partitionService: PartitionCollectionServicePort;
  private readonly normalizationHandler: NormalizationDeliveryOperation | undefined;
  private readonly embeddingHandler: EmbeddingDeliveryHandler | undefined;
  private readonly enqueue: OutboxDispatcherOptions['enqueue'];
  private readonly getNow: () => Date;
  private readonly leaseMs: number;
  private readonly batchLimit: number;

  constructor(options: OutboxDispatcherOptions) {
    this.stateRepository = options.stateRepository;
    this.partitionService = options.partitionService;
    this.normalizationHandler = options.normalizationHandler;
    this.embeddingHandler = options.embeddingHandler;
    this.enqueue = options.enqueue;
    this.getNow = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 30_000;
    this.batchLimit = options.batchLimit ?? 20;
  }

  async dispatchBatch(mode?: CollectionMode): Promise<DispatchCycleResult> {
    const now = this.getNow();
    const deliveries = await this.stateRepository.claimDeliveries(
      now,
      this.batchLimit,
      this.leaseMs,
      mode,
    );

    let processedCount = 0;
    const failures: { deliveryId: string; error: string }[] = [];

    for (const delivery of deliveries) {
      try {
        if (this.enqueue) {
          await this.enqueue(delivery, mode);
          processedCount++;
          continue;
        }
        await this.stateRepository.markSent(delivery.id, delivery.leaseEpoch, this.getNow());

        if (delivery.kind === 'collection') {
          await this.partitionService.executePartitionPage({
            partitionId: delivery.partitionId,
            pageSequence: delivery.pageSequence,
          });
          processedCount++;
        } else if (delivery.kind === 'normalization' && delivery.rawItemId) {
          if (this.normalizationHandler) {
            await this.normalizationHandler({
              deliveryId: delivery.id,
              rawItemId: delivery.rawItemId,
            });
            processedCount++;
          }
        } else if (delivery.kind === 'embedding' && delivery.revisionId) {
          if (this.embeddingHandler) {
            await this.embeddingHandler({
              deliveryId: delivery.id,
              revisionId: delivery.revisionId,
            });
            processedCount++;
          }
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        failures.push({ deliveryId: delivery.id, error: errorMsg });
      }
    }

    return {
      claimedCount: deliveries.length,
      processedCount,
      failures,
    };
  }
}

export interface PartitionRuntimeOptions {
  readonly stateRepository: CollectionStatePort;
  readonly collectorResolver: TargetCollectorResolver;
  readonly normalizationOptions?: NormalizationJobHandlerOptions | undefined;
  readonly embeddingHandler?: EmbeddingDeliveryHandler | undefined;
  readonly enqueue?: OutboxDispatcherOptions['enqueue'];
  readonly now?: (() => Date) | undefined;
  readonly leaseMs?: number | undefined;
  readonly incrementalConcurrency?: number | undefined;
  readonly backfillConcurrency?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly onTick?: ((success: boolean, error?: unknown) => void) | undefined;
}

export interface PartitionRuntimeStatus {
  readonly running: boolean;
  readonly activeIncrementalTasks: number;
  readonly activeBackfillTasks: number;
  readonly totalDispatched: number;
}
/**
 * Runtime coordinator managing dual-lane execution (incremental vs backfill)
 * to prevent incremental starvation, executing page collection, normalization,
 * and recovery of downstream deliveries from PostgreSQL.
 */
export class PartitionRuntime {
  private readonly stateRepository: CollectionStatePort;
  private readonly partitionService: PartitionCollectionServicePort;
  private readonly outboxDispatcher: OutboxDispatcher;
  private readonly normalizationHandler: NormalizationDeliveryOperation | undefined;
  private readonly embeddingHandler: EmbeddingDeliveryHandler | undefined;
  private readonly getNow: () => Date;
  private readonly leaseMs: number;
  private readonly incrementalConcurrency: number;
  private readonly backfillConcurrency: number;
  private readonly pollIntervalMs: number;

  private readonly onTick: ((success: boolean, error?: unknown) => void) | undefined;
  private activeTick: Promise<void> | null = null;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | number | null = null;
  private activeIncremental = 0;
  private activeBackfill = 0;
  private totalDispatched = 0;

  constructor(options: PartitionRuntimeOptions) {
    this.stateRepository = options.stateRepository;
    this.getNow = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 30_000;
    this.incrementalConcurrency = options.incrementalConcurrency ?? 5;
    this.backfillConcurrency = options.backfillConcurrency ?? 2;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.onTick = options.onTick;

    this.partitionService = createPartitionCollectionService({
      stateRepository: this.stateRepository,
      collectorResolver: options.collectorResolver,
      now: this.getNow,
      leaseMs: this.leaseMs,
    });

    if (options.normalizationOptions) {
      this.normalizationHandler = createNormalizationDeliveryHandler({
        ...options.normalizationOptions,
        collectionStateRepository: this.stateRepository,
      });
    }

    this.embeddingHandler = options.embeddingHandler;

    this.outboxDispatcher = new OutboxDispatcher({
      stateRepository: this.stateRepository,
      partitionService: this.partitionService,
      ...(this.normalizationHandler ? { normalizationHandler: this.normalizationHandler } : {}),
      ...(this.embeddingHandler ? { embeddingHandler: this.embeddingHandler } : {}),
      now: this.getNow,
      leaseMs: this.leaseMs,
      batchLimit: Math.max(this.incrementalConcurrency, this.backfillConcurrency) * 2,
      enqueue: options.enqueue,
    });
  }

  getStatus(): PartitionRuntimeStatus {
    return {
      running: this.isRunning,
      activeIncrementalTasks: this.activeIncremental,
      activeBackfillTasks: this.activeBackfill,
      totalDispatched: this.totalDispatched,
    };
  }

  /**
   * Executes a single tick across dual lanes:
   * 1. Incremental lane is dispatched first to guarantee priority / zero starvation.
   * 2. Backfill lane is dispatched with bounded concurrency.
   * 3. Any unassigned deliveries (e.g. normalization/embedding) are dispatched.
   */
  async tick(): Promise<{
    incremental: DispatchCycleResult;
    backfill: DispatchCycleResult;
    general: DispatchCycleResult;
  }> {
    // 1. High-priority incremental lane
    this.activeIncremental++;
    let incrementalResult: DispatchCycleResult = {
      claimedCount: 0,
      processedCount: 0,
      failures: [],
    };
    try {
      incrementalResult = await this.outboxDispatcher.dispatchBatch('incremental');
    } finally {
      this.activeIncremental--;
    }

    // 2. Bounded backfill lane
    this.activeBackfill++;
    let backfillResult: DispatchCycleResult = { claimedCount: 0, processedCount: 0, failures: [] };
    try {
      backfillResult = await this.outboxDispatcher.dispatchBatch('backfill');
    } finally {
      this.activeBackfill--;
    }

    // 3. General lane (e.g. normalization, embedding, on_demand)
    const generalResult = await this.outboxDispatcher.dispatchBatch();

    this.totalDispatched +=
      incrementalResult.processedCount +
      backfillResult.processedCount +
      generalResult.processedCount;

    return {
      incremental: incrementalResult,
      backfill: backfillResult,
      general: generalResult,
    };
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const runLoop = () => {
      if (!this.isRunning) return;
      this.activeTick = (async () => {
        try {
          const tickResult = await this.tick();
          const hasFailures =
            tickResult.incremental.failures.length > 0 ||
            tickResult.backfill.failures.length > 0 ||
            tickResult.general.failures.length > 0;
          this.onTick?.(!hasFailures);
        } catch (err) {
          this.onTick?.(false, err);
        }
      })();
      void this.activeTick.finally(() => {
        if (this.isRunning) {
          this.pollTimer = setTimeout(runLoop, this.pollIntervalMs);
        }
      });
    };

    this.pollTimer = setTimeout(runLoop, 10);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    await this.activeTick;
  }
}

export function createPartitionRuntime(options: PartitionRuntimeOptions): PartitionRuntime {
  return new PartitionRuntime(options);
}
