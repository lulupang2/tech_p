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

    assert.equal(config.databaseUrl, 'postgresql://db.test:5432/techpulse');
    assert.equal(config.redisUrl, 'rediss://cache.test:6380');
    assert.equal(config.concurrency, 1);
    assert.equal(config.allowFixtureProviders, false);
  });

  test('loads explicit embedding configuration without fabricating defaults', () => {
    const config = loadWorkerConfig({
      DATABASE_URL: 'postgresql://db.test:5432/techpulse',
      REDIS_URL: 'rediss://cache.test:6380',
      TECHPULSE_ALLOW_FIXTURE_PROVIDERS: 'true',
      EMBEDDING_API_KEY: 'sk-test-key',
      EMBEDDING_BASE_URL: 'https://api.example.com/v1',
      EMBEDDING_MODEL: 'text-embedding-3-small',
      EMBEDDING_DIMENSIONS: '1536',
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_SCOPE_ID: 'scope-1',
      EMBEDDING_PRICE_VERSION: 'embed-v1-standard',
      EMBEDDING_TOKENIZER_VERSION: 'cl100k-embed',
      EMBEDDING_APPROVAL_REFERENCE: 'DEC-007-EMBED',
    });

    assert.equal(config.allowFixtureProviders, true);
    assert.equal(config.embedding.apiKey, 'sk-test-key');
    assert.equal(config.embedding.baseUrl, 'https://api.example.com/v1');
    assert.equal(config.embedding.model, 'text-embedding-3-small');
    assert.equal(config.embedding.dimensions, 1536);
    assert.equal(config.embedding.provider, 'openai');
    assert.equal(config.embedding.scopeId, 'scope-1');
    assert.equal(config.embedding.priceVersion, 'embed-v1-standard');
    assert.equal(config.embedding.tokenizerVersion, 'cl100k-embed');
    assert.equal(config.embedding.approvalReference, 'DEC-007-EMBED');
  });

  test('defaults empty embedding configuration to undefined fields', () => {
    const config = loadWorkerConfig({
      DATABASE_URL: 'postgresql://db.test:5432/techpulse',
      REDIS_URL: 'rediss://cache.test:6380',
    });

    assert.equal(config.embedding.apiKey, undefined);
    assert.equal(config.embedding.baseUrl, undefined);
    assert.equal(config.embedding.model, undefined);
    assert.equal(config.embedding.version, undefined);
    assert.equal(config.embedding.dimensions, undefined);
    assert.equal(config.embedding.provider, undefined);
    assert.equal(config.embedding.scopeId, undefined);
    assert.equal(config.embedding.priceVersion, undefined);
    assert.equal(config.embedding.tokenizerVersion, undefined);
    assert.equal(config.embedding.approvalReference, undefined);
  });

  test('applies only the approved Perplexity embedding profile defaults', () => {
    const config = loadWorkerConfig({
      DATABASE_URL: 'postgresql://db.test:5432/techpulse',
      REDIS_URL: 'rediss://cache.test:6380',
      EMBEDDING_API_KEY: 'openrouter-key',
      EMBEDDING_BASE_URL: 'https://openrouter.ai/api/v1',
      EMBEDDING_MODEL: 'perplexity/pplx-embed-v1-0.6b',
    });

    assert.deepEqual(config.embedding, {
      apiKey: 'openrouter-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'perplexity/pplx-embed-v1-0.6b',
      version: '2026-03-16',
      dimensions: 1024,
      provider: 'openrouter-perplexity',
      scopeId: 'dec-012-cov009',
      priceVersion: 'openrouter-pplx-embed-2026-09-10',
      tokenizerVersion: 'provider-reported-v1',
      approvalReference: 'DEC-007-2026-09-10',
    });
  });
});
