import {
  CollectionStateError,
  type ClaimedCollectionPage,
  type CollectionPageRequest,
  type CollectionStatePort,
  type CollectionTargetRevision,
  type CollectorPagePort,
  type PageDisposition,
  type SourceKey,
} from '@techpulse/domain';

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
  readonly logger?:
    | {
        warn(event: string, context?: Record<string, unknown>): void;
        info(event: string, context?: Record<string, unknown>): void;
        error(event: string, context?: Record<string, unknown>): void;
      }
    | undefined;
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
        throw err;
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
        console.error(`COLLECT PAGE THREW: ${errorMessage}`, collectErr);
        const isPolicyViolation =
          collectErr instanceof Error &&
          /content policy|policy violation|ssrf|forbidden host|unauthorized host|pii violation/i.test(
            collectErr.message,
          );

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

export interface PartitionCollectionJobHandlerOptions {
  readonly service: PartitionCollectionServicePort;
  readonly onPermanentFailure?: ((errorSummary: string | null) => void) | undefined;
  readonly onStaleLease?: ((partitionId: string, pageSequence: number) => void) | undefined;
}

export type PartitionCollectionOperation = (request: ExecutePartitionPageRequest) => Promise<void>;
/**
 * Creates the worker execution handler for partition collection jobs.
 * Bridges BullMQ / partition execution with PartitionCollectionServicePort.
 */
export function createPartitionCollectionJobHandler(
  serviceOrOptions: PartitionCollectionServicePort | PartitionCollectionJobHandlerOptions,
): PartitionCollectionOperation {
  const service = 'service' in serviceOrOptions ? serviceOrOptions.service : serviceOrOptions;
  const onPermanentFailure =
    'onPermanentFailure' in serviceOrOptions ? serviceOrOptions.onPermanentFailure : undefined;
  const onStaleLease =
    'onStaleLease' in serviceOrOptions ? serviceOrOptions.onStaleLease : undefined;

  return async (request: ExecutePartitionPageRequest): Promise<void> => {
    const partitionId = request.partitionId;
    const pageSequence = request.pageSequence;
    const signal = 'signal' in request ? request.signal : undefined;

    const result = await service.executePartitionPage({
      partitionId,
      pageSequence,
      ...(signal !== undefined ? { signal } : {}),
    });

    if (result.disposition === 'fenced_out') {
      onStaleLease?.(partitionId, pageSequence);
      return;
    }

    if (result.errorSummary && result.disposition === 'deferred' && !result.nextDueAt) {
      onPermanentFailure?.(result.errorSummary);
    }
  };
}
