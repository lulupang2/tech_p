import type { CollectionJobPayload } from '@techpulse/contracts';
import type { RawIngestionServicePort } from '@techpulse/domain';
import type { CollectionOperation } from './scheduler.js';

export interface IngestionJobHandlerOptions {
  readonly service: RawIngestionServicePort;
  /**
   * Optional custom handler for non-transient failures (e.g. policy violations).
   * Default behavior is to resolve successfully so BullMQ does not endlessly retry non-retryable errors.
   */
  readonly onPermanentFailure?: (errorSummary: string | null) => void;
}

/**
 * Bridges the worker scheduler's CollectionOperation contract with the domain's RawIngestionServicePort.
 * Ensures transient errors trigger retry/backoff while policy/permanent errors are quarantined without retries.
 */
export function createIngestionJobHandler(
  serviceOrOptions: RawIngestionServicePort | IngestionJobHandlerOptions,
): CollectionOperation {
  const service = 'service' in serviceOrOptions ? serviceOrOptions.service : serviceOrOptions;
  const onPermanentFailure =
    'onPermanentFailure' in serviceOrOptions ? serviceOrOptions.onPermanentFailure : undefined;

  return async (payload: CollectionJobPayload): Promise<void> => {
    const result = await service.executeIngestion({
      collectionRunId: payload.collectionRunId,
      sourceKey: payload.sourceKey,
      ...(payload.cursor !== undefined ? { cursor: payload.cursor } : {}),
    });

    if (result.status === 'failed') {
      if (result.isTransientError) {
        throw new Error(
          `Collection run '${result.runId}' failed transiently: ${result.errorSummary ?? 'Unknown error'}`,
        );
      } else {
        onPermanentFailure?.(result.errorSummary);
      }
    }
  };
}
