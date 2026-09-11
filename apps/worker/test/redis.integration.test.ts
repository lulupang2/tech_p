import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { describe, test } from 'vitest';
import {
  DELIVERY_JOB_NAME,
  createCollectionDeliveryJobData,
  type CollectionDeliveryJobData,
} from '../src/jobs.js';
import { createDeliveryWorker } from '../src/scheduler.js';
import { RedisSourceConcurrencyLimiter } from '../src/concurrency.js';

const redisUrl = process.env['REDIS_URL'];
const validDeliveryId = '11111111-1111-4111-8111-111111111111';

describe.skipIf(!redisUrl)('real Redis BullMQ integration', () => {
  test('delivers a queued UUID delivery job once and deduplicates by jobId in BullMQ', async () => {
    const queueName = `techpulse-integration-delivery-${process.pid}-${Date.now()}`;
    const queueRedis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const workerRedis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const queue = new Queue<CollectionDeliveryJobData>(queueName, { connection: queueRedis });
    const handled: string[] = [];
    const worker = createDeliveryWorker({
      connection: workerRedis,
      queueName,
      concurrency: 1,
      handle: async (deliveryId: string) => {
        handled.push(deliveryId);
      },
    });

    try {
      await worker.waitUntilReady();
      await queue.waitUntilReady();

      const jobData = createCollectionDeliveryJobData(validDeliveryId);

      const { promise: completed, resolve, reject } = Promise.withResolvers<void>();
      const timer = setTimeout(() => {
        worker.off('completed', onCompleted);
        worker.off('failed', onFailed);
        reject(new Error('timeout waiting for delivery job completion'));
      }, 10_000);

      const onCompleted = (job: { id?: string }) => {
        if (job.id === validDeliveryId) {
          clearTimeout(timer);
          worker.off('completed', onCompleted);
          worker.off('failed', onFailed);
          resolve();
        }
      };
      const onFailed = (job: { id?: string } | undefined, error: Error) => {
        if (job?.id === validDeliveryId) {
          clearTimeout(timer);
          worker.off('completed', onCompleted);
          worker.off('failed', onFailed);
          reject(error);
        }
      };
      worker.on('completed', onCompleted);
      worker.on('failed', onFailed);

      // Enqueue job with deliveryId as jobId
      const first = await queue.add(DELIVERY_JOB_NAME, jobData, {
        jobId: validDeliveryId,
        removeOnComplete: true,
      });

      // Enqueue duplicate job with identical jobId (BullMQ deduplicates and returns existing job)
      const second = await queue.add(DELIVERY_JOB_NAME, jobData, {
        jobId: validDeliveryId,
        removeOnComplete: true,
      });

      await completed;
      assert.equal(first.id, validDeliveryId);
      assert.equal(second.id, validDeliveryId);
      // Queue deduplication ensures single delivery execution; DB outbox/fencing ensures database exactly-once
      assert.equal(handled.length, 1);
      assert.equal(handled[0], validDeliveryId);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await workerRedis.quit();
      await queueRedis.quit();
    }
  }, 30_000);

  test('rejects malformed and stale v1 payloads before invoking handle', async () => {
    const queueName = `techpulse-integration-rejection-${process.pid}-${Date.now()}`;
    const queueRedis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const workerRedis = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
    const queue = new Queue<CollectionDeliveryJobData>(queueName, { connection: queueRedis });
    let handledCalls = 0;
    const worker = createDeliveryWorker({
      connection: workerRedis,
      queueName,
      concurrency: 1,
      handle: async () => {
        handledCalls += 1;
      },
    });

    try {
      await worker.waitUntilReady();
      await queue.waitUntilReady();

      const {
        promise: failed,
        resolve: resolveFailed,
        reject: rejectFailed,
      } = Promise.withResolvers<{ id?: string; error: Error }>();
      const timer = setTimeout(() => {
        rejectFailed(new Error('timeout waiting for job rejection'));
      }, 10_000);

      worker.once('failed', (job, error) => {
        clearTimeout(timer);
        resolveFailed({ id: job?.id, error });
      });
      // Add malformed v1 payload to queue
      await queue.add(
        DELIVERY_JOB_NAME,
        {
          schemaVersion: 1,
          collectionRunId: 'run-v1',
          sourceKey: 'github_releases',
        } as unknown as CollectionDeliveryJobData,
        { attempts: 1 },
      );

      const failure = await failed;
      assert.ok(failure.error);
      assert.equal(handledCalls, 0); // Handler must never be invoked for invalid payload
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await workerRedis.quit();
      await queueRedis.quit();
    }
  }, 30_000);

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
    const { promise: firstHeld, resolve: releaseFirst } = Promise.withResolvers<void>();
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
  }, 30_000);

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
    const {
      promise: acquired,
      resolve: resolveAcquired,
      reject: rejectAcquired,
    } = Promise.withResolvers<void>();
    child.stdout.on('data', (chunk: string) => {
      if (chunk.includes('acquired')) resolveAcquired();
    });
    child.stderr.on('data', (chunk: string) => {
      if (chunk.includes('Error')) rejectAcquired(new Error('crash child failed before acquire'));
    });
    child.once('error', rejectAcquired);
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
  }, 30_000);
});
