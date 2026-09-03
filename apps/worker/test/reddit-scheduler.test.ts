import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { Queue } from 'bullmq';
import {
  createRedditCollector,
  REDDIT_COLLECTION_SCHEDULE,
  createRedditScheduleWindow,
  enqueueRedditScheduleJob,
  type CollectionJobData,
  InMemoryJobClaimStore,
} from '../src/index.js';

describe('Reddit Collection Scheduler & Job Generation', () => {
  test('defines 6-hour interval and cron expression for Reddit schedule', () => {
    assert.equal(REDDIT_COLLECTION_SCHEDULE.intervalHours, 6);
    assert.equal(REDDIT_COLLECTION_SCHEDULE.intervalMs, 6 * 60 * 60 * 1000);
    assert.equal(REDDIT_COLLECTION_SCHEDULE.cron, '0 */6 * * *');
    assert.equal(REDDIT_COLLECTION_SCHEDULE.jobName, 'reddit-schedule');
  });

  test('generates valid 6-hour UTC schedule window', () => {
    const fixedTime = new Date('2026-09-01T08:30:00.000Z');
    const window = createRedditScheduleWindow(fixedTime);

    assert.equal(window.from, '2026-09-01T06:00:00.000Z');
    assert.equal(window.to, '2026-09-01T12:00:00.000Z');

    const durationMs = new Date(window.to).getTime() - new Date(window.from).getTime();
    assert.equal(durationMs, 6 * 60 * 60 * 1000);
  });

  test('creates Reddit collection job named reddit-schedule with 6-hour repeat options', async () => {
    const jobs = new Map<string, object>();
    const calls: Array<{
      name: string;
      data: CollectionJobData;
      options: Record<string, unknown>;
    }> = [];

    const mockQueue = {
      async getJob(id: string) {
        return jobs.get(id);
      },
      async add(name: string, data: CollectionJobData, options: Record<string, unknown>) {
        const job = { id: data.naturalKey, name, data, options };
        jobs.set(data.naturalKey, job);
        calls.push({ name, data, options });
        return job;
      },
    } as unknown as Queue<CollectionJobData>;

    const claimStore = new InMemoryJobClaimStore();
    const now = new Date('2026-09-01T00:00:00.000Z');

    const result = await enqueueRedditScheduleJob(mockQueue, {
      now,
      claimStore,
      repeat: true,
      subreddit: 'typescript',
    });

    assert.equal(calls.length, 1);
    const added = calls[0]!;

    // Verify job name is strictly 'reddit-schedule'
    assert.equal(added.name, 'reddit-schedule');
    assert.equal(added.data.payload.sourceKey, 'reddit');

    // Verify 6-hour schedule window
    assert.equal(added.data.scheduleWindow.from, '2026-09-01T00:00:00.000Z');
    assert.equal(added.data.scheduleWindow.to, '2026-09-01T06:00:00.000Z');

    // Verify 6-hour repeat configuration
    const repeatConfig = added.options['repeat'] as { every: number; pattern: string };
    assert.ok(repeatConfig);
    assert.equal(repeatConfig.every, 21_600_000);
    assert.equal(repeatConfig.pattern, '0 */6 * * *');

    // Verify naturalKey contains reddit and the schedule window
    assert.ok(result.naturalKey.includes('reddit'));
    assert.equal(result.job.name, 'reddit-schedule');
  });

  test('exports Reddit collector instance with default and custom options', () => {
    const defaultCollector = createRedditCollector();
    assert.equal(defaultCollector.sourceKey, 'reddit');
    assert.equal(defaultCollector.config.subreddit, 'typescript');

    const customCollector = createRedditCollector({
      config: { subreddit: 'rust', timeoutMs: 15000 },
    });
    assert.equal(customCollector.config.subreddit, 'rust');
    assert.equal(customCollector.config.timeoutMs, 15000);
  });
});
