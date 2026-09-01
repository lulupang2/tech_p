import assert from 'node:assert/strict';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { describe, test } from 'vitest';
import type { CollectionJobPayload } from '@techpulse/contracts';
import {
  COLLECTION_JOB_NAME,
  InMemoryIdempotentDeliveryBoundary,
  createCollectionWorker,
  enqueueCollectionJob,
} from '../src/index.js';
import type { CollectionJobData } from '../src/index.js';

const redisUrl = process.env['REDIS_URL'];
const payload: CollectionJobPayload = {
  schemaVersion: 1,
  collectionRunId: 'redis-integration-run',
  sourceKey: 'github_releases',
  cursor: null,
};
const scheduleWindow = { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' };

describe.skipIf(!redisUrl)('real Redis BullMQ integration', () => {
  test('delivers a queued job once and suppresses its duplicate', async () => {
    const queueName = `techpulse-integration-${process.pid}-${Date.now()}`;
    const queueRedis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const workerRedis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const queue = new Queue<CollectionJobData>(queueName, { connection: queueRedis });
    const boundary = new InMemoryIdempotentDeliveryBoundary();
    let handled = 0;
    const worker = createCollectionWorker({
      connection: workerRedis,
      queueName,
      concurrency: 1,
      handle: async () => {
        handled += 1;
      },
      deliveryBoundary: boundary.deliver.bind(boundary),
    });
    try {
      await worker.waitUntilReady();
      await queue.waitUntilReady();
      const first = await enqueueCollectionJob(queue, payload, scheduleWindow, { delayMs: 0 });
      const completed = new Promise<void>((resolve, reject) => {
        const onCompleted = (job: { id?: string }) => {
          if (job.id === first.job.id) {
            worker.off('failed', onFailed);
            resolve();
          }
        };
        const onFailed = (job: { id?: string } | undefined, error: Error) => {
          if (job?.id === first.job.id) {
            worker.off('completed', onCompleted);
            reject(error);
          }
        };
        worker.on('completed', onCompleted);
        worker.on('failed', onFailed);
      });
      const second = await enqueueCollectionJob(queue, payload, scheduleWindow, { delayMs: 0 });
      await completed;
      assert.equal(first.duplicate, false);
      assert.equal(second.duplicate, true);
      assert.equal(handled, 1);
      assert.equal((await queue.getJob(first.job.id as string))?.name, COLLECTION_JOB_NAME);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await workerRedis.quit();
      await queueRedis.quit();
    }
  });
});
