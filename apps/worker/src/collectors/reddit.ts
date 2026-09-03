import type { Queue, Job } from 'bullmq';
import {
  RedditCollector,
  DEFAULT_REDDIT_BYPASS_HEADERS,
  type RedditCollectorOptions,
  type RedditCollectorConfig,
  type RedditBypassConfig,
} from '@techpulse/collectors';
import {
  createCollectionJobData,
  WORKER_JOB_SCHEMA_VERSION,
  type CollectionJobData,
  type ScheduleWindow,
} from '../jobs.js';
import { InMemoryJobClaimStore, type JobClaimStore } from '../scheduler.js';

// ============================================================================
// Schedule Constants & Types
// ============================================================================

export const REDDIT_COLLECTION_SCHEDULE = {
  intervalHours: 6,
  intervalMs: 6 * 60 * 60 * 1000,
  cron: '0 */6 * * *',
  jobName: 'reddit-schedule' as const,
  defaultSubreddit: 'typescript',
} as const;

export interface EnqueueRedditJobOptions {
  now?: Date | undefined;
  collectionRunId?: string | undefined;
  cursor?: string | null | undefined;
  subreddit?: string | undefined;
  scheduleWindow?: ScheduleWindow | undefined;
  claimStore?: JobClaimStore | undefined;
  repeat?: boolean | undefined;
}

export interface EnqueueRedditJobResult {
  job: Job<CollectionJobData>;
  naturalKey: string;
  scheduleWindow: ScheduleWindow;
}

// ============================================================================
// Factory & Scheduler Helper
// ============================================================================

/**
 * Resolves worker environment bypass configurations (proxy, UA, cookies, lor2 fallback).
 */
export function resolveWorkerRedditBypassConfig(
  env: NodeJS.ProcessEnv = process.env,
): RedditBypassConfig {
  return {
    proxyUrl: env['REDDIT_PROXY_URL'] || undefined,
    userAgent: env['REDDIT_USER_AGENT'] || undefined,
    cookie: env['REDDIT_COOKIE'] || undefined,
    referer: env['REDDIT_REFERER'] || 'https://www.google.com/',
    allowRobotsBypass: env['REDDIT_ALLOW_ROBOTS_BYPASS'] !== 'false',
    fallbackToOldRedditOnLor2: env['REDDIT_FALLBACK_OLD_ON_LOR2'] !== 'false',
  };
}

/**
 * Exports Reddit collector instance configured for worker ingestion, injecting bypass settings.
 */
export function createRedditCollector(options?: RedditCollectorOptions): RedditCollector {
  const envBypass = resolveWorkerRedditBypassConfig();
  const mergedConfig: RedditCollectorConfig = {
    subreddit: REDDIT_COLLECTION_SCHEDULE.defaultSubreddit,
    ...options?.config,
    bypass: {
      ...envBypass,
      ...options?.config?.bypass,
    },
  };

  return new RedditCollector({
    ...options,
    config: mergedConfig,
  });
}

/**
 * Generates a standard 6-hour UTC schedule window for Reddit collection.
 */
export function createRedditScheduleWindow(baseTime: Date = new Date()): ScheduleWindow {
  const fromMs =
    Math.floor(baseTime.getTime() / REDDIT_COLLECTION_SCHEDULE.intervalMs) *
    REDDIT_COLLECTION_SCHEDULE.intervalMs;
  const toMs = fromMs + REDDIT_COLLECTION_SCHEDULE.intervalMs;

  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  };
}

/**
 * Enqueues a Redis collection job for Reddit under the 6-hour schedule.
 * Generates the job named 'reddit-schedule'.
 */
export async function enqueueRedditScheduleJob(
  queue: Queue<CollectionJobData>,
  options?: EnqueueRedditJobOptions,
): Promise<EnqueueRedditJobResult> {
  const now = options?.now ?? new Date();
  const scheduleWindow = options?.scheduleWindow ?? createRedditScheduleWindow(now);
  const collectionRunId = options?.collectionRunId ?? `reddit-run-${Date.now()}`;

  const payload = {
    schemaVersion: WORKER_JOB_SCHEMA_VERSION,
    collectionRunId,
    sourceKey: 'reddit' as const,
    cursor: options?.cursor ?? null,
  };

  const jobData = createCollectionJobData(payload, scheduleWindow);
  const claimStore = options?.claimStore ?? new InMemoryJobClaimStore();

  const isClaimed = await claimStore.claim(jobData.naturalKey);
  if (!isClaimed) {
    const existing = await queue.getJob(jobData.naturalKey);
    if (existing) {
      return {
        job: existing as Job<CollectionJobData>,
        naturalKey: jobData.naturalKey,
        scheduleWindow,
      };
    }
  }

  const jobOptions: Record<string, unknown> = {
    jobId: jobData.naturalKey,
    removeOnComplete: false,
    removeOnFail: false,
    attempts: 5,
    backoff: { type: 'bounded-exponential', delay: 1000 },
  };

  if (options?.repeat) {
    jobOptions['repeat'] = {
      every: REDDIT_COLLECTION_SCHEDULE.intervalMs,
      pattern: REDDIT_COLLECTION_SCHEDULE.cron,
    };
  }

  const job = await queue.add(REDDIT_COLLECTION_SCHEDULE.jobName, jobData, jobOptions);

  return {
    job,
    naturalKey: jobData.naturalKey,
    scheduleWindow,
  };
}

export {
  RedditCollector,
  DEFAULT_REDDIT_BYPASS_HEADERS,
  type RedditCollectorOptions,
  type RedditCollectorConfig,
  type RedditBypassConfig,
};
