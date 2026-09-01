import {
  parseCollectionJobPayload,
  type CollectionJobPayload,
  type SourceKey,
} from '@techpulse/contracts';

export const WORKER_JOB_SCHEMA_VERSION = 1 as const;
export const COLLECTION_JOB_NAME = 'collection' as const;
export const NORMALIZATION_JOB_NAME = 'normalization' as const;
export const MAX_JOB_ATTEMPTS = 5 as const;
export const RETRY_BACKOFF_BASE_MS = 1_000 as const;
export const RETRY_BACKOFF_MAX_MS = 16_000 as const;

type UnknownRecord = Record<string, unknown>;

export interface ScheduleWindow {
  readonly from: string;
  readonly to: string;
}

export interface CollectionJobData {
  readonly schemaVersion: typeof WORKER_JOB_SCHEMA_VERSION;
  readonly payload: CollectionJobPayload;
  readonly scheduleWindow: ScheduleWindow;
  readonly naturalKey: string;
}

export interface NormalizationJobData {
  readonly schemaVersion: typeof WORKER_JOB_SCHEMA_VERSION;
  readonly stage: 'normalization';
  readonly rawItemId: string;
  readonly sourceKey: SourceKey;
  readonly runId: string;
  readonly externalId: string;
  readonly payloadHash: string;
}

export class WorkerJobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerJobValidationError';
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: UnknownRecord, keys: readonly string[], context: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new WorkerJobValidationError(`${context} contains unknown field: ${key}`);
    }
  }
}

function parseUtcDate(value: unknown, field: string): Date {
  const match =
    typeof value === 'string'
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value)
      : null;
  if (!match) {
    throw new WorkerJobValidationError(`${field} must be an ISO-8601 UTC timestamp`);
  }
  const date = new Date(value as string);
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6])
  ) {
    throw new WorkerJobValidationError(`${field} must be a valid timestamp`);
  }
  return date;
}
export function normalizeScheduleWindow(value: unknown): ScheduleWindow {
  if (!isRecord(value)) {
    throw new WorkerJobValidationError('scheduleWindow must be an object');
  }
  assertOnlyKeys(value, ['from', 'to'], 'scheduleWindow');
  const from = parseUtcDate(value['from'], 'scheduleWindow.from');
  const to = parseUtcDate(value['to'], 'scheduleWindow.to');
  if (from.getTime() >= to.getTime()) {
    throw new WorkerJobValidationError('scheduleWindow.from must be before scheduleWindow.to');
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

export function collectionJobNaturalKey(sourceKey: SourceKey, window: ScheduleWindow): string {
  return `${sourceKey}|${window.from}|${window.to}`.replaceAll(':', '_');
}

export function createCollectionJobData(
  payloadInput: unknown,
  scheduleWindowInput: unknown,
): CollectionJobData {
  let payload: CollectionJobPayload;
  try {
    payload = parseCollectionJobPayload(payloadInput);
  } catch {
    throw new WorkerJobValidationError('payload does not match the collection job contract');
  }
  const scheduleWindow = normalizeScheduleWindow(scheduleWindowInput);
  return {
    schemaVersion: WORKER_JOB_SCHEMA_VERSION,
    payload,
    scheduleWindow,
    naturalKey: collectionJobNaturalKey(payload.sourceKey, scheduleWindow),
  };
}

export function parseCollectionJobData(value: unknown): CollectionJobData {
  if (!isRecord(value)) {
    throw new WorkerJobValidationError('job data must be an object');
  }
  assertOnlyKeys(value, ['schemaVersion', 'payload', 'scheduleWindow', 'naturalKey'], 'job data');
  if (value['schemaVersion'] !== WORKER_JOB_SCHEMA_VERSION) {
    throw new WorkerJobValidationError('job data schemaVersion is unsupported');
  }
  const data = createCollectionJobData(value['payload'], value['scheduleWindow']);
  if (value['naturalKey'] !== data.naturalKey) {
    throw new WorkerJobValidationError('job data naturalKey does not match payload and window');
  }
  return data;
}

export function createNormalizationJobData(input: {
  readonly rawItemId: string;
  readonly sourceKey: SourceKey;
  readonly runId: string;
  readonly externalId: string;
  readonly payloadHash: string;
}): NormalizationJobData {
  return {
    schemaVersion: WORKER_JOB_SCHEMA_VERSION,
    stage: 'normalization',
    rawItemId: input.rawItemId,
    sourceKey: input.sourceKey,
    runId: input.runId,
    externalId: input.externalId,
    payloadHash: input.payloadHash,
  };
}

export function parseNormalizationJobData(value: unknown): NormalizationJobData {
  if (!isRecord(value)) {
    throw new WorkerJobValidationError('Normalization job data must be a non-null object');
  }

  assertOnlyKeys(
    value,
    ['schemaVersion', 'stage', 'rawItemId', 'sourceKey', 'runId', 'externalId', 'payloadHash'],
    'normalization job data',
  );

  if (value['schemaVersion'] !== WORKER_JOB_SCHEMA_VERSION) {
    throw new WorkerJobValidationError(
      `Invalid worker job schemaVersion: expected ${WORKER_JOB_SCHEMA_VERSION}, received ${String(value['schemaVersion'])}`,
    );
  }

  if (value['stage'] !== 'normalization') {
    throw new WorkerJobValidationError(
      `Invalid stage: expected 'normalization', received '${String(value['stage'])}'`,
    );
  }

  if (typeof value['rawItemId'] !== 'string' || value['rawItemId'].trim().length === 0) {
    throw new WorkerJobValidationError('rawItemId must be a non-empty string');
  }

  if (typeof value['sourceKey'] !== 'string' || value['sourceKey'].trim().length === 0) {
    throw new WorkerJobValidationError('sourceKey must be a non-empty string');
  }

  if (typeof value['runId'] !== 'string' || value['runId'].trim().length === 0) {
    throw new WorkerJobValidationError('runId must be a non-empty string');
  }

  if (typeof value['externalId'] !== 'string' || value['externalId'].trim().length === 0) {
    throw new WorkerJobValidationError('externalId must be a non-empty string');
  }

  if (
    typeof value['payloadHash'] !== 'string' ||
    !/^[0-9a-fA-F]{64}$/u.test(value['payloadHash'])
  ) {
    throw new WorkerJobValidationError('payloadHash must be a 64-character hex string');
  }

  return {
    schemaVersion: WORKER_JOB_SCHEMA_VERSION,
    stage: 'normalization',
    rawItemId: value['rawItemId'],
    sourceKey: value['sourceKey'] as SourceKey,
    runId: value['runId'],
    externalId: value['externalId'],
    payloadHash: value['payloadHash'],
  };
}

export function retryBackoffMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError('attempt must be a positive integer');
  }
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1), RETRY_BACKOFF_MAX_MS);
}
