import type { CollectionJobPayload } from './schemas.js';
import { parseCollectionJobPayload } from './validation.js';

export const COLLECTION_QUEUE_JOB_SCHEMA_VERSION = 1 as const;
export const COLLECTION_QUEUE_JOB_NAME = 'collection' as const;

export interface CollectionScheduleWindow {
  readonly from: string;
  readonly to: string;
}

export interface CollectionQueueJobData {
  readonly schemaVersion: typeof COLLECTION_QUEUE_JOB_SCHEMA_VERSION;
  readonly payload: CollectionJobPayload;
  readonly scheduleWindow: CollectionScheduleWindow;
  readonly naturalKey: string;
}

function parseUtcTimestamp(value: unknown, field: string): Date {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
  ) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return parsed;
}

export function createCollectionQueueJobData(
  payloadInput: unknown,
  windowInput: CollectionScheduleWindow,
): CollectionQueueJobData {
  const payload = parseCollectionJobPayload(payloadInput);
  const from = parseUtcTimestamp(windowInput.from, 'scheduleWindow.from');
  const to = parseUtcTimestamp(windowInput.to, 'scheduleWindow.to');
  if (from.getTime() >= to.getTime())
    throw new Error('scheduleWindow.from must be before scheduleWindow.to');
  const scheduleWindow = { from: from.toISOString(), to: to.toISOString() };
  return {
    schemaVersion: COLLECTION_QUEUE_JOB_SCHEMA_VERSION,
    payload,
    scheduleWindow,
    naturalKey: `${payload.sourceKey}|${scheduleWindow.from}|${scheduleWindow.to}`.replaceAll(
      ':',
      '_',
    ),
  };
}
