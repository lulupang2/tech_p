import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  DELIVERY_JOB_NAME,
  DELIVERY_JOB_SCHEMA_VERSION,
  WorkerJobValidationError,
  createCollectionDeliveryJobData,
  parseCollectionDeliveryJobData,
  retryBackoffMs,
} from '../src/jobs.js';
import {
  DEFAULT_DELIVERY_QUEUE_NAME,
  DEFAULT_INCREMENTAL_QUEUE_NAME,
  DEFAULT_BACKFILL_QUEUE_NAME,
} from '../src/scheduler.js';
import { InMemorySourceConcurrencyLimiter } from '../src/concurrency.js';

const validDeliveryId = '11111111-1111-4111-8111-111111111111';

describe('versioned collection delivery', () => {
  test('creates valid version 2 delivery job data with UUID', () => {
    const data = createCollectionDeliveryJobData(validDeliveryId);
    assert.equal(data.schemaVersion, DELIVERY_JOB_SCHEMA_VERSION);
    assert.equal(data.deliveryId, validDeliveryId);
    assert.deepEqual(parseCollectionDeliveryJobData(data), data);

    assert.throws(() => createCollectionDeliveryJobData(''), WorkerJobValidationError);
    assert.throws(() => createCollectionDeliveryJobData('invalid-uuid'), WorkerJobValidationError);
    assert.throws(() => createCollectionDeliveryJobData('../../secret'), WorkerJobValidationError);
    assert.throws(
      () => createCollectionDeliveryJobData(null as unknown as string),
      WorkerJobValidationError,
    );
  });

  test('rejects malformed, unknown, stale-version, and extra fields before handling', () => {
    const valid = createCollectionDeliveryJobData(validDeliveryId);
    assert.deepEqual(parseCollectionDeliveryJobData(valid), valid);

    // Stale schema version 1
    assert.throws(
      () =>
        parseCollectionDeliveryJobData({
          schemaVersion: 1,
          collectionRunId: 'run-001',
          sourceKey: 'github_releases',
        }),
      WorkerJobValidationError,
    );

    // Invalid schemaVersion
    assert.throws(
      () => parseCollectionDeliveryJobData({ schemaVersion: 99, deliveryId: validDeliveryId }),
      WorkerJobValidationError,
    );

    // Non-UUID deliveryId
    assert.throws(
      () => parseCollectionDeliveryJobData({ schemaVersion: 2, deliveryId: 'not-a-uuid' }),
      WorkerJobValidationError,
    );

    // Extra unknown fields (e.g. naturalKey or untrusted payload)
    assert.throws(
      () =>
        parseCollectionDeliveryJobData({
          schemaVersion: 2,
          deliveryId: validDeliveryId,
          naturalKey: `delivery:${validDeliveryId}`,
        }),
      WorkerJobValidationError,
    );
    assert.throws(
      () =>
        parseCollectionDeliveryJobData({
          schemaVersion: 2,
          deliveryId: validDeliveryId,
          rawPayload: 'untrusted',
        }),
      WorkerJobValidationError,
    );

    // Non-object primitives
    assert.throws(() => parseCollectionDeliveryJobData(null), WorkerJobValidationError);
    assert.throws(() => parseCollectionDeliveryJobData(undefined), WorkerJobValidationError);
    assert.throws(() => parseCollectionDeliveryJobData('string'), WorkerJobValidationError);
    assert.throws(() => parseCollectionDeliveryJobData(123), WorkerJobValidationError);
  });

  test('never invokes a handler for malformed delivery data', async () => {
    let calls = 0;
    const invalidJobData = {
      schemaVersion: 1,
      collectionRunId: 'run-001',
      sourceKey: 'github_releases',
    };

    assert.throws(() => {
      parseCollectionDeliveryJobData(invalidJobData);
      calls += 1;
    }, WorkerJobValidationError);

    assert.equal(calls, 0);
  });

  test('uses bounded exponential retry backoff', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 20].map(retryBackoffMs),
      [1_000, 2_000, 4_000, 8_000, 16_000, 16_000],
    );
    assert.throws(() => retryBackoffMs(0), RangeError);
    assert.throws(() => retryBackoffMs(-1), RangeError);
  });

  test('exports default queue constants and job names', () => {
    assert.equal(DELIVERY_JOB_NAME, 'delivery');
    assert.equal(DEFAULT_DELIVERY_QUEUE_NAME, 'techpulse-delivery');
    assert.equal(DEFAULT_INCREMENTAL_QUEUE_NAME, 'techpulse-incremental');
    assert.equal(DEFAULT_BACKFILL_QUEUE_NAME, 'techpulse-backfill');
  });
});

describe('source concurrency', () => {
  test('caps each source independently and releases capacity after failure', async () => {
    const limiter = new InMemorySourceConcurrencyLimiter(2);
    let active = 0;
    let maximum = 0;
    const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
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

  test('isolates concurrency limits between different sources', async () => {
    const limiter = new InMemorySourceConcurrencyLimiter({
      github_releases: 1,
      reddit: 2,
    });
    let ghActive = 0;
    let ghMax = 0;
    let rdActive = 0;
    let rdMax = 0;
    const { promise: blocked, resolve: release } = Promise.withResolvers<void>();

    const ghOp = async (): Promise<void> => {
      ghActive += 1;
      ghMax = Math.max(ghMax, ghActive);
      await blocked;
      ghActive -= 1;
    };
    const rdOp = async (): Promise<void> => {
      rdActive += 1;
      rdMax = Math.max(rdMax, rdActive);
      await blocked;
      rdActive -= 1;
    };

    const pending = Promise.all([
      limiter.run('github_releases', ghOp),
      limiter.run('github_releases', ghOp),
      limiter.run('reddit', rdOp),
      limiter.run('reddit', rdOp),
      limiter.run('reddit', rdOp),
    ]);

    await Promise.resolve();
    assert.equal(ghMax, 1);
    assert.equal(rdMax, 2);

    release();
    await pending;
    assert.equal(ghMax, 1);
    assert.equal(rdMax, 2);
  });
});
