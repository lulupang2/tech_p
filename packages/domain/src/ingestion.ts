import type { CollectedRawItem, CollectorPort, SourceKey } from './collector.js';
import {
  CollectionStateError,
  type ClaimedCollectionPage,
  type CollectionPageRequest,
  type CollectionStatePort,
  type CollectionTargetRevision,
  type CollectorPagePort,
  type PageDisposition,
} from './collection-state.js';
import type {
  CollectionRunRepositoryPort,
  CollectionRunStatus,
  PipelineEventRepositoryPort,
  RawItemRecord,
  RawItemRepositoryPort,
  SourceRecord,
  SourceRepositoryPort,
} from './repository.js';

/**
 * Base domain error for raw ingestion failures.
 */
export class IngestionError extends Error {
  readonly isTransient: boolean;
  readonly code: string;

  constructor(message: string, options: { isTransient: boolean; code?: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.isTransient = options.isTransient;
    this.code = options.code ?? 'INGESTION_ERROR';
  }
}

/**
 * Controlled policy violation error (SSRF, PII, Content policy, licensing violation).
 * Non-retryable / permanent policy failure.
 */
export class PolicyViolationError extends IngestionError {
  constructor(message: string, cause?: unknown) {
    super(message, { isTransient: false, code: 'POLICY_VIOLATION', cause });
  }
}

/**
 * Transient error (HTTP 429, 5xx, timeout, network failure).
 * Retryable by scheduler / queue.
 */
export class TransientIngestionError extends IngestionError {
  constructor(message: string, cause?: unknown) {
    super(message, { isTransient: true, code: 'TRANSIENT_ERROR', cause });
  }
}

/**
 * Source configuration or non-retryable source error.
 */
export class PermanentIngestionError extends IngestionError {
  constructor(message: string, cause?: unknown) {
    super(message, { isTransient: false, code: 'PERMANENT_ERROR', cause });
  }
}

export class SourceNotFoundError extends IngestionError {
  constructor(sourceKey: string) {
    super(`Source '${sourceKey}' not found`, { isTransient: false, code: 'SOURCE_NOT_FOUND' });
  }
}

export class SourceDisabledError extends IngestionError {
  constructor(sourceKey: string) {
    super(`Source '${sourceKey}' is disabled`, { isTransient: false, code: 'SOURCE_DISABLED' });
  }
}

/**
 * Stage job payload emitted for subsequent processing stages (e.g. normalization).
 */
export interface StageJobPayload {
  readonly stage: 'normalization';
  readonly rawItemId: string;
  readonly sourceKey: SourceKey;
  readonly runId: string;
  readonly externalId: string;
  readonly payloadHash: string;
}

/**
 * Port for dispatching downstream stage jobs.
 */
export interface StageJobPublisherPort {
  publishStageJob(payload: StageJobPayload): Promise<void>;
}

/**
 * Inbound collection request for raw ingestion orchestration.
 */
export interface RawIngestionRequest {
  readonly collectionRunId: string;
  readonly sourceKey: SourceKey;
  readonly cursor?: string | null;
  readonly scheduledAt?: Date;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/**
 * Ingestion metric counts.
 */
export interface RawIngestionCounts {
  readonly itemsFetched: number;
  readonly itemsPersisted: number;
  readonly duplicatesSkipped: number;
  readonly stageJobsPublished: number;
  readonly bytesFetched: number;
}

/**
 * Final ingestion execution result.
 */
export interface RawIngestionResult {
  readonly runId: string;
  readonly sourceKey: SourceKey;
  readonly status: CollectionRunStatus;
  readonly counts: RawIngestionCounts;
  readonly nextCursor: string | null;
  readonly errorSummary: string | null;
  readonly isTransientError?: boolean;
}

export type CollectorResolver = (
  sourceKey: SourceKey,
  source?: SourceRecord,
) => CollectorPort | undefined;

export interface StructuredEventLoggerLike {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

export interface RawIngestionServiceOptions {
  readonly sourceRepository: SourceRepositoryPort;
  readonly collectionRunRepository: CollectionRunRepositoryPort;
  readonly rawItemRepository: RawItemRepositoryPort;
  readonly pipelineEventRepository?: PipelineEventRepositoryPort;
  readonly collectorResolver: CollectorResolver;
  readonly stageJobPublisher?: StageJobPublisherPort;
  readonly logger?: StructuredEventLoggerLike;
  readonly processorVersion?: string;
  readonly now?: () => Date;
}

export interface RawIngestionServicePort {
  executeIngestion(request: RawIngestionRequest): Promise<RawIngestionResult>;
}

function extractCanonicalUrl(item: CollectedRawItem, source: SourceRecord): string {
  if (
    item.metadata &&
    typeof item.metadata['canonicalUrl'] === 'string' &&
    item.metadata['canonicalUrl'].length > 0
  ) {
    return item.metadata['canonicalUrl'];
  }
  if (typeof item.payload['canonicalUrl'] === 'string' && item.payload['canonicalUrl'].length > 0) {
    return item.payload['canonicalUrl'];
  }
  if (typeof item.payload['html_url'] === 'string' && item.payload['html_url'].length > 0) {
    return item.payload['html_url'];
  }
  if (typeof item.payload['link'] === 'string' && item.payload['link'].length > 0) {
    return item.payload['link'];
  }
  if (typeof item.payload['url'] === 'string' && item.payload['url'].length > 0) {
    return item.payload['url'];
  }
  const cleanBase = source.baseUrl.replace(/\/+$/u, '');
  return `${cleanBase}/${encodeURIComponent(item.externalId)}`;
}

export function createRawIngestionService(
  options: RawIngestionServiceOptions,
): RawIngestionServicePort {
  const getNow = options.now ?? (() => new Date());
  const processorVersion = options.processorVersion ?? '1.0.0';

  return {
    async executeIngestion(request: RawIngestionRequest): Promise<RawIngestionResult> {
      const startTime = getNow();

      // 1. Source verification
      const source = await options.sourceRepository.findByKey(request.sourceKey);
      if (!source) {
        throw new SourceNotFoundError(request.sourceKey);
      }

      if (!source.enabled) {
        options.logger?.warn('collection.run.source_disabled', {
          sourceKey: request.sourceKey,
          runId: request.collectionRunId,
        });

        // Ensure collection run record reflects cancelled status if existing or created
        let existingRun = await options.collectionRunRepository.findById(request.collectionRunId);
        if (!existingRun) {
          existingRun = await options.collectionRunRepository.create({
            id: request.collectionRunId,
            sourceId: source.id,
            scheduledAt: request.scheduledAt ?? startTime,
            startedAt: startTime,
            status: 'cancelled',
            ...(request.cursor !== undefined && request.cursor !== null
              ? { cursorBefore: request.cursor }
              : {}),
            counts: {
              itemsFetched: 0,
              itemsPersisted: 0,
              duplicatesSkipped: 0,
              stageJobsPublished: 0,
            },
          });
        } else {
          await options.collectionRunRepository.update(existingRun.id, {
            status: 'cancelled',
            endedAt: startTime,
            errorSummary: 'Source is disabled',
          });
        }

        return {
          runId: request.collectionRunId,
          sourceKey: request.sourceKey,
          status: 'cancelled',
          counts: {
            itemsFetched: 0,
            itemsPersisted: 0,
            duplicatesSkipped: 0,
            stageJobsPublished: 0,
            bytesFetched: 0,
          },
          nextCursor: null,
          errorSummary: 'Source is disabled',
          isTransientError: false,
        };
      }

      // 2. Transition / Create CollectionRun -> running
      let run = await options.collectionRunRepository.findById(request.collectionRunId);
      if (!run) {
        run = await options.collectionRunRepository.create({
          id: request.collectionRunId,
          sourceId: source.id,
          scheduledAt: request.scheduledAt ?? startTime,
          startedAt: startTime,
          status: 'running',
          ...(request.cursor !== undefined && request.cursor !== null
            ? { cursorBefore: request.cursor }
            : {}),
          counts: {},
        });
      } else if (run.status === 'succeeded') {
        // Idempotent re-execution of an already succeeded run: return existing state without duplicate jobs
        options.logger?.info('collection.run.already_succeeded', {
          runId: run.id,
          sourceKey: request.sourceKey,
        });
        const counts = {
          itemsFetched: run.counts['itemsFetched'] ?? 0,
          itemsPersisted: run.counts['itemsPersisted'] ?? 0,
          duplicatesSkipped: run.counts['duplicatesSkipped'] ?? 0,
          stageJobsPublished: run.counts['stageJobsPublished'] ?? 0,
          bytesFetched: run.counts['bytesFetched'] ?? 0,
        };
        return {
          runId: run.id,
          sourceKey: request.sourceKey,
          status: 'succeeded',
          counts,
          nextCursor: run.cursorAfter,
          errorSummary: null,
        };
      } else {
        const cursorBefore = request.cursor ?? run.cursorBefore;
        run = await options.collectionRunRepository.update(run.id, {
          status: 'running',
          startedAt: startTime,
          ...(cursorBefore !== undefined && cursorBefore !== null ? { cursorBefore } : {}),
        });
      }

      options.logger?.info('collection.run.started', {
        runId: run.id,
        sourceKey: request.sourceKey,
        cursor: request.cursor,
      });

      // 3. Resolve Collector and collect items
      const collector = options.collectorResolver(request.sourceKey, source);
      if (!collector) {
        const errorMsg = `No collector registered for source '${request.sourceKey}'`;
        await options.collectionRunRepository.update(run.id, {
          status: 'failed',
          endedAt: getNow(),
          errorSummary: errorMsg,
        });
        throw new PermanentIngestionError(errorMsg);
      }

      let collectionResult;
      try {
        const collectionCursor = request.cursor ?? run.cursorBefore;
        collectionResult = await collector.collect({
          sourceKey: request.sourceKey,
          cursor: collectionCursor ?? null,
          ...(request.limit !== undefined ? { limit: request.limit } : {}),
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        });
      } catch (err: unknown) {
        const endedAt = getNow();
        const errorMessage = err instanceof Error ? err.message : String(err);

        // Distinguish policy failures from transient network / server errors
        const isPolicyViolation =
          err instanceof PolicyViolationError ||
          (err instanceof Error &&
            /content policy|policy violation|ssrf|forbidden host|unauthorized host|pii violation/i.test(
              err.message,
            ));

        if (isPolicyViolation) {
          await options.collectionRunRepository.update(run.id, {
            status: 'failed',
            endedAt,
            errorSummary: `Policy violation: ${errorMessage}`,
          });
          options.logger?.error('collection.run.policy_violation', {
            runId: run.id,
            sourceKey: request.sourceKey,
            error: errorMessage,
          });
          if (err instanceof PolicyViolationError) throw err;
          throw new PolicyViolationError(errorMessage, err);
        } else {
          await options.collectionRunRepository.update(run.id, {
            status: 'failed',
            endedAt,
            errorSummary: `Transient collection error: ${errorMessage}`,
          });
          options.logger?.error('collection.run.transient_error', {
            runId: run.id,
            sourceKey: request.sourceKey,
            error: errorMessage,
          });
          if (err instanceof TransientIngestionError) throw err;
          throw new TransientIngestionError(errorMessage, err);
        }
      }

      // 4. Invariant: Persist raw items idempotently before emitting stage jobs
      const items = collectionResult.items;
      let itemsPersisted = 0;
      let duplicatesSkipped = 0;
      let stageJobsPublished = 0;
      const newlyPersistedItems: RawItemRecord[] = [];

      try {
        for (const item of items) {
          const canonicalUrl = extractCanonicalUrl(item, source);
          const rawItemNow = getNow();

          const httpMetadata =
            item.metadata &&
            typeof item.metadata['httpMetadata'] === 'object' &&
            item.metadata['httpMetadata'] !== null
              ? (item.metadata['httpMetadata'] as Record<string, unknown>)
              : undefined;
          const rightsMetadata =
            item.metadata &&
            typeof item.metadata['rightsMetadata'] === 'object' &&
            item.metadata['rightsMetadata'] !== null
              ? (item.metadata['rightsMetadata'] as Record<string, unknown>)
              : undefined;

          const upsertResult = await options.rawItemRepository.upsert({
            sourceId: source.id,
            runId: run.id,
            externalId: item.externalId,
            canonicalUrl,
            payload: item.payload,
            payloadHash: item.rawHash,
            publishedAt: item.publishedAt,
            collectedAt: rawItemNow,
            ...(httpMetadata !== undefined ? { httpMetadata } : {}),
            ...(rightsMetadata !== undefined ? { rightsMetadata } : {}),
          });

          if (upsertResult.isNew) {
            itemsPersisted++;
            newlyPersistedItems.push(upsertResult.item);

            if (options.pipelineEventRepository) {
              await options.pipelineEventRepository.create({
                rawItemId: upsertResult.item.id,
                stage: 'raw_saved',
                processorVersion,
                status: 'succeeded',
                attempt: 1,
                occurredAt: rawItemNow,
              });
            }
          } else {
            duplicatesSkipped++;

            if (options.pipelineEventRepository) {
              await options.pipelineEventRepository.create({
                rawItemId: upsertResult.item.id,
                stage: 'raw_saved',
                processorVersion,
                status: 'skipped',
                attempt: 1,
                occurredAt: rawItemNow,
              });
            }
          }
        }
      } catch (persistenceError: unknown) {
        const endedAt = getNow();
        const errorMessage =
          persistenceError instanceof Error ? persistenceError.message : String(persistenceError);

        await options.collectionRunRepository.update(run.id, {
          status: 'failed',
          endedAt,
          errorSummary: `Raw persistence error: ${errorMessage}`,
        });

        options.logger?.error('collection.run.persistence_error', {
          runId: run.id,
          sourceKey: request.sourceKey,
          error: errorMessage,
        });

        // Invariant: Do NOT publish downstream jobs on persistence failure
        throw new TransientIngestionError(errorMessage, persistenceError);
      }

      // 5. Invariant: Publish downstream stage jobs ONLY after raw persistence succeeds
      if (options.stageJobPublisher && newlyPersistedItems.length > 0) {
        for (const rawItem of newlyPersistedItems) {
          await options.stageJobPublisher.publishStageJob({
            stage: 'normalization',
            rawItemId: rawItem.id,
            sourceKey: request.sourceKey,
            runId: run.id,
            externalId: rawItem.externalId,
            payloadHash: rawItem.payloadHash,
          });
          stageJobsPublished++;
        }
      }

      // 6. Transition CollectionRun -> succeeded with final counts and cursor
      const endedAt = getNow();
      const bytesFetched = collectionResult.metrics?.bytesFetched ?? 0;
      const counts: RawIngestionCounts = {
        itemsFetched: items.length,
        itemsPersisted,
        duplicatesSkipped,
        stageJobsPublished,
        bytesFetched,
      };

      await options.collectionRunRepository.update(run.id, {
        status: 'succeeded',
        endedAt,
        ...(collectionResult.nextCursor !== undefined && collectionResult.nextCursor !== null
          ? { cursorAfter: collectionResult.nextCursor }
          : {}),
        counts: counts as unknown as Record<string, number>,
        errorSummary: null,
      });

      options.logger?.info('collection.run.succeeded', {
        runId: run.id,
        sourceKey: request.sourceKey,
        counts,
      });

      return {
        runId: run.id,
        sourceKey: request.sourceKey,
        status: 'succeeded',
        counts,
        nextCursor: collectionResult.nextCursor,
        errorSummary: null,
      };
    },
  };
}

/**
 * Target collector resolver mapping source key and target revision to CollectorPagePort.
 */
export type TargetCollectorResolver = (
  sourceKey: SourceKey,
  target: CollectionTargetRevision,
) => CollectorPagePort | undefined;

export interface PartitionCollectionServiceOptions {
  readonly stateRepository: CollectionStatePort;
  readonly collectorResolver: TargetCollectorResolver;
  readonly now?: (() => Date) | undefined;
  readonly leaseMs?: number | undefined;
  readonly pageLimit?: number | undefined;
  readonly maxRequests?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly logger?: StructuredEventLoggerLike | undefined;
}

export interface ExecutePartitionPageRequest {
  readonly partitionId: string;
  readonly pageSequence: number;
  readonly signal?: AbortSignal | undefined;
}

export interface ExecutePartitionPageResult {
  readonly partitionId: string;
  readonly pageSequence: number;
  readonly disposition: PageDisposition | 'skipped' | 'fenced_out';
  readonly itemsPersisted: number;
  readonly nextDueAt?: Date | null;
  readonly errorSummary?: string | null;
}

export interface PartitionCollectionServicePort {
  executePartitionPage(request: ExecutePartitionPageRequest): Promise<ExecutePartitionPageResult>;
}

export function createPartitionCollectionService(
  options: PartitionCollectionServiceOptions,
): PartitionCollectionServicePort {
  const getNow = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? 30_000;
  const pageLimit = options.pageLimit ?? 100;
  const maxRequests = options.maxRequests ?? 10;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const renewalIntervalMs = Math.max(100, Math.floor(leaseMs / 3));

  return {
    async executePartitionPage(
      request: ExecutePartitionPageRequest,
    ): Promise<ExecutePartitionPageResult> {
      const startTime = getNow();
      let claim: ClaimedCollectionPage | null = null;
      try {
        claim = await options.stateRepository.claimPage(
          request.partitionId,
          request.pageSequence,
          startTime,
          leaseMs,
        );
      } catch (err: unknown) {
        if (err instanceof CollectionStateError && err.code === 'policy_blocked') {
          options.logger?.warn('partition.collection.policy_blocked', {
            partitionId: request.partitionId,
            pageSequence: request.pageSequence,
          });
          return {
            partitionId: request.partitionId,
            pageSequence: request.pageSequence,
            disposition: 'skipped',
            itemsPersisted: 0,
            errorSummary: 'Target policy blocked or disabled',
          };
        }
      }

      if (!claim) {
        return {
          partitionId: request.partitionId,
          pageSequence: request.pageSequence,
          disposition: 'skipped',
          itemsPersisted: 0,
        };
      }

      const abortController = new AbortController();
      let renewTimer: NodeJS.Timeout | number | null = null;
      let renewalFailed = false;

      if (request.signal) {
        request.signal.addEventListener(
          'abort',
          () => {
            abortController.abort(request.signal?.reason);
          },
          { once: true },
        );
      }

      renewTimer = setInterval(() => {
        options.stateRepository
          .renewPage(claim!, getNow(), leaseMs)
          .then((renewed) => {
            if (!renewed) {
              renewalFailed = true;
              abortController.abort(new Error('lease_expired'));
            }
          })
          .catch((err: unknown) => {
            renewalFailed = true;
            abortController.abort(err);
          });
      }, renewalIntervalMs);

      const cleanupTimer = () => {
        if (renewTimer !== null) {
          clearInterval(renewTimer);
          renewTimer = null;
        }
      };

      try {
        const collector = options.collectorResolver(claim.target.sourceKey, claim.target);
        if (!collector) {
          cleanupTimer();
          const errorMsg = `No collector registered for sourceKey '${claim.target.sourceKey}'`;
          try {
            await options.stateRepository.failPage(claim, errorMsg, null, getNow());
          } catch (failErr: unknown) {
            if (failErr instanceof CollectionStateError && failErr.code === 'stale_lease') {
              return {
                partitionId: request.partitionId,
                pageSequence: request.pageSequence,
                disposition: 'fenced_out',
                itemsPersisted: 0,
                errorSummary: 'stale_lease',
              };
            }
          }
          return {
            partitionId: request.partitionId,
            pageSequence: request.pageSequence,
            disposition: 'deferred',
            itemsPersisted: 0,
            errorSummary: errorMsg,
          };
        }

        const pageRequest: CollectionPageRequest = {
          target: claim.target,
          partition: claim.partition,
          limit: pageLimit,
          maxRequests,
          maxBytes,
          now: getNow,
          signal: abortController.signal,
        };

        const result = await collector.collectPage(pageRequest);
        cleanupTimer();

        const commitTime = getNow();
        try {
          await options.stateRepository.commitPage({
            claim,
            result,
            now: commitTime,
          });
        } catch (commitErr: unknown) {
          if (commitErr instanceof CollectionStateError) {
            if (commitErr.code === 'stale_lease') {
              options.logger?.warn('partition.collection.stale_lease', {
                partitionId: request.partitionId,
                pageSequence: request.pageSequence,
              });
              return {
                partitionId: request.partitionId,
                pageSequence: request.pageSequence,
                disposition: 'fenced_out',
                itemsPersisted: 0,
                errorSummary: 'stale_lease',
              };
            }
            if (commitErr.code === 'policy_blocked') {
              options.logger?.warn('partition.collection.policy_blocked_on_commit', {
                partitionId: request.partitionId,
                pageSequence: request.pageSequence,
              });
              return {
                partitionId: request.partitionId,
                pageSequence: request.pageSequence,
                disposition: 'deferred',
                itemsPersisted: 0,
                errorSummary: 'policy_blocked',
              };
            }
          }
          throw commitErr;
        }

        return {
          partitionId: request.partitionId,
          pageSequence: request.pageSequence,
          disposition: result.disposition,
          itemsPersisted: result.items.length,
          nextDueAt: result.retryAt,
          errorSummary: result.reason,
        };
      } catch (collectErr: unknown) {
        cleanupTimer();
        const errorTime = getNow();
        const errorMessage = collectErr instanceof Error ? collectErr.message : String(collectErr);

        const isPolicyViolation =
          collectErr instanceof PolicyViolationError ||
          (collectErr instanceof Error &&
            /content policy|policy violation|ssrf|forbidden host|unauthorized host|pii violation/i.test(
              collectErr.message,
            ));

        const isTransient = !isPolicyViolation && !renewalFailed;
        const retryAt = isTransient ? new Date(errorTime.getTime() + 5_000) : null;

        try {
          await options.stateRepository.failPage(claim, errorMessage, retryAt, errorTime);
        } catch (failErr: unknown) {
          if (failErr instanceof CollectionStateError && failErr.code === 'stale_lease') {
            return {
              partitionId: request.partitionId,
              pageSequence: request.pageSequence,
              disposition: 'fenced_out',
              itemsPersisted: 0,
              errorSummary: 'stale_lease',
            };
          }
        }

        return {
          partitionId: request.partitionId,
          pageSequence: request.pageSequence,
          disposition: 'deferred',
          itemsPersisted: 0,
          nextDueAt: retryAt,
          errorSummary: errorMessage,
        };
      } finally {
        cleanupTimer();
      }
    },
  };
}
