import { parseCollectionDelivery, type CollectionDeliveryPayload } from '@techpulse/contracts';

export const DELIVERY_JOB_SCHEMA_VERSION = 2 as const;
export const DELIVERY_JOB_NAME = 'delivery' as const;
export const PARTITION_COLLECTION_JOB_NAME = 'partition_collection' as const;
export const NORMALIZATION_JOB_NAME = 'normalization' as const;
export const DEDUPLICATION_JOB_NAME = 'deduplication' as const;
export const MAX_JOB_ATTEMPTS = 5 as const;
export const RETRY_BACKOFF_BASE_MS = 1_000 as const;
export const RETRY_BACKOFF_MAX_MS = 16_000 as const;

export type CollectionDeliveryJobData = CollectionDeliveryPayload;

export class WorkerJobValidationError extends Error {
  constructor() {
    super('Invalid version 2 delivery payload');
    this.name = 'WorkerJobValidationError';
  }
}

export function createCollectionDeliveryJobData(deliveryId: string): CollectionDeliveryJobData {
  return parseCollectionDeliveryJobData({ schemaVersion: DELIVERY_JOB_SCHEMA_VERSION, deliveryId });
}

export function parseCollectionDeliveryJobData(value: unknown): CollectionDeliveryJobData {
  try {
    return parseCollectionDelivery(value);
  } catch {
    throw new WorkerJobValidationError();
  }
}

export function retryBackoffMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError('attempt must be a positive integer');
  }
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1), RETRY_BACKOFF_MAX_MS);
}
