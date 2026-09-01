import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { describe, test } from 'vitest';
import type { CollectionJobPayload } from '@techpulse/contracts';
import {
  COLLECTION_JOB_NAME,
  InMemoryIdempotentDeliveryBoundary,
  RedisJobClaimStore,
  RedisSourceConcurrencyLimiter,
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
    const claimRedis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const queue = new Queue<CollectionJobData>(queueName, { connection: queueRedis });
    const claimStore = new RedisJobClaimStore(
      claimRedis,
      `techpulse:worker:integration:${queueName}`,
    );
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
      const first = await enqueueCollectionJob(queue, payload, scheduleWindow, {
        claimStore,
        delayMs: 0,
      });
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
      const second = await enqueueCollectionJob(queue, payload, scheduleWindow, {
        claimStore,
        delayMs: 0,
      });
      await completed;
      assert.equal(first.duplicate, false);
      assert.equal(second.duplicate, true);
      assert.equal(handled, 1);
      assert.equal((await queue.getJob(first.job.id as string))?.name, COLLECTION_JOB_NAME);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await claimRedis.quit();
      await queue.close();
      await workerRedis.quit();
      await queueRedis.quit();
    }
  });
  test('reports the Redis claim winner and loser under concurrent enqueue', async () => {
    const queueName = `techpulse-integration-concurrent-${process.pid}-${Date.now()}`;
    const queueRedis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const claimRedis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const queue = new Queue<CollectionJobData>(queueName, { connection: queueRedis });
    const claimStore = new RedisJobClaimStore(
      claimRedis,
      `techpulse:worker:integration:${queueName}`,
    );
    try {
      await queue.waitUntilReady();
      const results = await Promise.all([
        enqueueCollectionJob(queue, payload, scheduleWindow, {
          claimStore,
          delayMs: 10_000,
        }),
        enqueueCollectionJob(queue, payload, scheduleWindow, {
          claimStore,
          delayMs: 10_000,
        }),
      ]);
      assert.equal(results.filter((result) => !result.duplicate).length, 1);
      assert.equal(results.filter((result) => result.duplicate).length, 1);
      assert.equal((await queue.getJob(results[0].job.id as string)) !== undefined, true);
    } finally {
      await queue.obliterate({ force: true });
      await claimRedis.quit();
      await queue.close();
      await queueRedis.quit();
    }
  });
  test('acquires on an empty hash, blocks duplicate leases, and releases capacity', async () => {
    const keyPrefix = `techpulse-integration-cap-${process.pid}-${Date.now()}`;
    const firstRedis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const secondRedis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const limiterOptions = {
      leaseMs: 1_000,
      pollMs: 10,
      acquireTimeoutMs: 5_000,
      keyPrefix,
    };
    const firstLimiter = new RedisSourceConcurrencyLimiter(firstRedis, 1, 1, limiterOptions);
    const secondLimiter = new RedisSourceConcurrencyLimiter(secondRedis, 1, 1, limiterOptions);
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;
    try {
      const first = firstLimiter.run('github_releases', async () => firstHeld);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const second = secondLimiter.run('github_releases', async () => {
        secondStarted = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      assert.equal(secondStarted, false);
      releaseFirst();
      await first;
      await second;
      assert.equal(secondStarted, true);
    } finally {
      releaseFirst();
      await firstLimiter.close();
      await secondLimiter.close();
    }
  });
  test('recovers a bounded lease after a SIGKILL child crash', async () => {
    const keyPrefix = `techpulse-integration-crash-${process.pid}-${Date.now()}`;
    const redis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const observer = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const childCode = `
      import { Redis } from 'ioredis';
      import { RedisSourceConcurrencyLimiter } from './src/concurrency.ts';
      const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
      const limiter = new RedisSourceConcurrencyLimiter(redis, 1, 1, {
        leaseMs: 1000,
        pollMs: 10,
        acquireTimeoutMs: 3000,
        keyPrefix: process.env.LEASE_KEY_PREFIX
      });
      await limiter.run('github_releases', async () => {
        process.stdout.write('acquired\\\\n');
        await new Promise(() => {});
      });
    `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', '--input-type=module', '--eval', childCode],
      {
        cwd: process.cwd(),
        env: { ...process.env, REDIS_URL: redisUrl, LEASE_KEY_PREFIX: keyPrefix },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const output: string[] = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => output.push(chunk));
    const acquired = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: string) => {
        if (chunk.includes('acquired')) resolve();
      });
      child.stderr.on('data', (chunk: string) => {
        if (chunk.includes('Error')) reject(new Error('crash child failed before acquire'));
      });
      child.once('error', reject);
    });
    try {
      await acquired;
      const leases = await observer.hgetall(`${keyPrefix}:github_releases`);
      const expires = Number(Object.values(leases)[0]);
      assert.ok(Number.isSafeInteger(expires));
      child.kill('SIGKILL');
      await once(child, 'exit');

      const recoveryLimiter = new RedisSourceConcurrencyLimiter(redis, 1, 1, {
        leaseMs: 1_000,
        pollMs: 10,
        acquireTimeoutMs: 3_000,
        keyPrefix,
      });
      await recoveryLimiter.run('github_releases', async () => undefined);
    } finally {
      child.kill('SIGKILL');
      await redis.quit();
      await observer.quit();
    }
    assert.equal(output.join(''), 'acquired\\n');
  });
});
