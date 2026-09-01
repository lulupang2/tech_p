import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { WorkerConfigError, loadWorkerConfig } from '../src/config.js';

describe('worker runtime configuration', () => {
  test('fails when required connection values are missing', () => {
    assert.throws(
      () => loadWorkerConfig({}),
      (error: unknown) => {
        assert(error instanceof WorkerConfigError);
        assert.match(error.message, /DATABASE_URL is required/u);
        assert.match(error.message, /REDIS_URL is required/u);
        return true;
      },
    );
  });

  test('rejects invalid values without exposing supplied connection values', () => {
    const databaseValue = 'mysql://user:worker-value-must-not-leak@db.test/app';
    const redisValue = 'redis://:worker-redis-value-must-not-leak';

    assert.throws(
      () =>
        loadWorkerConfig({
          DATABASE_URL: databaseValue,
          REDIS_URL: redisValue,
          WORKER_CONCURRENCY: '0',
        }),
      (error: unknown) => {
        assert(error instanceof WorkerConfigError);
        assert.match(error.message, /REDIS_URL must be a valid Redis URL/u);
        assert.match(error.message, /DATABASE_URL must be a valid PostgreSQL URL/u);
        assert.match(error.message, /WORKER_CONCURRENCY must be an integer/u);
        assert.doesNotMatch(error.message, /worker-value-must-not-leak/u);
        assert.doesNotMatch(error.message, /worker-redis-value-must-not-leak/u);
        assert.doesNotMatch(error.message, new RegExp(databaseValue, 'u'));
        assert.doesNotMatch(error.message, new RegExp(redisValue, 'u'));
        return true;
      },
    );
  });

  test('loads valid values and applies the safe concurrency default', () => {
    const config = loadWorkerConfig({
      DATABASE_URL: 'postgresql://db.test:5432/techpulse',
      REDIS_URL: 'rediss://cache.test:6380',
    });

    assert.deepEqual(config, {
      databaseUrl: 'postgresql://db.test:5432/techpulse',
      redisUrl: 'rediss://cache.test:6380',
      concurrency: 1,
    });
  });
});
