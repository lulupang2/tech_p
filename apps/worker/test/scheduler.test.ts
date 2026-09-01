import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { Queue } from 'bullmq';
import type { CollectionJobPayload } from '@techpulse/contracts';
import {
  COLLECTION_JOB_NAME,
  InMemoryIdempotentDeliveryBoundary,
  InMemoryJobClaimStore,
  InMemorySourceConcurrencyLimiter,
  WorkerJobValidationError,
  collectionJobNaturalKey,
  createCollectionJobData,
  enqueueCollectionJob,
  normalizeScheduleWindow,
  parseCollectionJobData,
  processCollectionJob,
  retryBackoffMs,
} from '../src/index.js';
import type { CollectionJobData } from '../src/index.js';

const payload: CollectionJobPayload = {
  schemaVersion: 1,
  collectionRunId: 'run-001',
  sourceKey: 'github_releases',
  cursor: null,
};
const window = { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' };

describe('versioned collection delivery', () => {
  test('normalizes only UTC schedule windows and derives the natural key', () => {
    const data = createCollectionJobData(payload, {
      from: '2026-09-01T00:00:00.123Z',
      to: '2026-09-01T01:00:00Z',
    });
    assert.deepEqual(data.scheduleWindow, {
      from: '2026-09-01T00:00:00.123Z',
      to: '2026-09-01T01:00:00.000Z',
    });
    assert.equal(data.naturalKey, collectionJobNaturalKey(payload.sourceKey, data.scheduleWindow));
    assert.throws(
      () => normalizeScheduleWindow({ from: '2026-09-01T00:00:00+09:00', to: window.to }),
      WorkerJobValidationError,
    );
    assert.throws(
      () => normalizeScheduleWindow({ from: '2026-02-30T00:00:00Z', to: window.to }),
      /valid timestamp/u,
    );
    assert.throws(() => normalizeScheduleWindow({ ...window, extra: true }), /unknown field/u);
  });

  test('rejects malformed, unknown, stale-version, and mismatched job data before handling', () => {
    const valid = createCollectionJobData(payload, window);
    assert.deepEqual(parseCollectionJobData(valid), valid);
    assert.throws(() => parseCollectionJobData({ ...valid, unknown: true }), /unknown field/u);
    assert.throws(() => parseCollectionJobData({ ...valid, schemaVersion: 99 }), /unsupported/u);
    assert.throws(() => parseCollectionJobData({ ...valid, naturalKey: 'wrong' }), /naturalKey/u);
    assert.throws(
      () => createCollectionJobData({ ...payload, unexpected: true }, window),
      WorkerJobValidationError,
    );
  });
  test('never invokes a handler for malformed delivery data', async () => {
    const valid = createCollectionJobData(payload, window);
    let calls = 0;
    await assert.rejects(
      processCollectionJob(
        { ...valid, payload: { ...payload, unknown: true } },
        new InMemorySourceConcurrencyLimiter(1),
        async () => {
          calls += 1;
        },
      ),
      WorkerJobValidationError,
    );
    assert.equal(calls, 0);
  });

  test('uses bounded exponential retry backoff', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 20].map(retryBackoffMs),
      [1_000, 2_000, 4_000, 8_000, 16_000, 16_000],
    );
    assert.throws(() => retryBackoffMs(0), RangeError);
  });

  test('suppresses duplicate source/window jobs atomically at queue boundary', async () => {
    const jobs = new Map<string, object>();
    const calls: Array<{
      name: string;
      data: CollectionJobData;
      options: Record<string, unknown>;
    }> = [];
    const queue = {
      async getJob(id: string) {
        return jobs.get(id);
      },
      async add(name: string, data: CollectionJobData, options: Record<string, unknown>) {
        const job = { id: data.naturalKey, name, data };
        jobs.set(data.naturalKey, job);
        calls.push({ name, data, options });
        return job;
      },
    } as unknown as Queue<CollectionJobData>;
    const claimStore = new InMemoryJobClaimStore();
    const [first, second] = await Promise.all([
      enqueueCollectionJob(queue, payload, window, {
        claimStore,
        now: new Date('2026-08-31T00:00:00Z'),
      }),
      enqueueCollectionJob(queue, payload, window, { claimStore }),
    ]);
    assert.notEqual(first.duplicate, second.duplicate);
    assert.equal([first, second].filter((result) => !result.duplicate).length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, COLLECTION_JOB_NAME);
    assert.equal(calls[0]?.options['jobId'], first.job.id);
    assert.equal(calls[0]?.options['delay'], 86_400_000);
    assert.equal(calls[0]?.options['removeOnComplete'], false);
    assert.equal(calls[0]?.options['attempts'], 5);
    assert.deepEqual(calls[0]?.options['backoff'], {
      type: 'bounded-exponential',
      delay: 1_000,
    });
  });
  test('executes a concurrent natural key once and shares the result', async () => {
    const boundary = new InMemoryIdempotentDeliveryBoundary();
    const data = createCollectionJobData(payload, window);
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = async (jobPayload: CollectionJobPayload): Promise<void> => {
      assert.equal(jobPayload.collectionRunId, payload.collectionRunId);
      calls += 1;
      await held;
    };
    const first = boundary.deliver(data, operation);
    const second = boundary.deliver(data, operation);
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await Promise.all([first, second]), ['committed', 'committed']);
    assert.equal(calls, 1);
    assert.equal(await boundary.deliver(data, operation), 'already_committed');
  });

  test('shares concurrent operation errors without a second execution', async () => {
    const boundary = new InMemoryIdempotentDeliveryBoundary();
    const data = createCollectionJobData(payload, window);
    const failure = new Error('delivery failed');
    let calls = 0;
    const operation = async (): Promise<void> => {
      calls += 1;
      throw failure;
    };
    const [first, second] = await Promise.allSettled([
      boundary.deliver(data, operation),
      boundary.deliver(data, operation),
    ]);
    assert.equal(first.status, 'rejected');
    assert.equal(second.status, 'rejected');
    assert.equal(first.reason, failure);
    assert.equal(second.reason, failure);
    assert.equal(calls, 1);
  });
});

describe('source concurrency', () => {
  test('caps each source independently and releases capacity after failure', async () => {
    const limiter = new InMemorySourceConcurrencyLimiter(2);
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = async (): Promise<void> => {
      active += 1;
      maximum = Math.max(maximum, active);
      await blocked;
      active -= 1;
    };
    const pending = Promise.all(
      Array.from({ length: 8 }, () => limiter.run('github_releases', operation)),
    );
    await Promise.resolve();
    assert.equal(maximum, 2);
    release();
    await pending;
    assert.equal(maximum, 2);
    await assert.rejects(
      limiter.run('github_releases', async () => {
        throw new Error('failure');
      }),
      /failure/u,
    );
    await limiter.run('github_releases', operation);
  });
});
