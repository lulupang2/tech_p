import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { ApiConfigError, loadApiConfig } from '../src/config.js';

describe('API runtime configuration', () => {
  test('fails when DATABASE_URL is missing', () => {
    assert.throws(
      () => loadApiConfig({}),
      (error: unknown) => {
        assert(error instanceof ApiConfigError);
        assert.match(error.message, /DATABASE_URL is required/u);
        return true;
      },
    );
  });

  test('rejects invalid values without exposing the supplied value', () => {
    const secretValue = 'mysql://user:api-value-must-not-leak@db.test/app';

    assert.throws(
      () =>
        loadApiConfig({
          DATABASE_URL: secretValue,
          PORT: 'not-a-port',
        }),
      (error: unknown) => {
        assert(error instanceof ApiConfigError);
        assert.match(error.message, /DATABASE_URL must be a valid PostgreSQL URL/u);
        assert.match(error.message, /PORT must be an integer/u);
        assert.doesNotMatch(error.message, /api-value-must-not-leak/u);
        assert.doesNotMatch(error.message, new RegExp(secretValue, 'u'));
        return true;
      },
    );
  });

  test('loads valid values and applies only non-secret defaults', () => {
    const config = loadApiConfig({
      DATABASE_URL: 'postgresql://db.test:5432/techpulse',
      PORT: '4310',
    });

    assert.deepEqual(config, {
      databaseUrl: 'postgresql://db.test:5432/techpulse',
      redisUrl: 'redis://127.0.0.1:6379',
      port: 4310,
    });
  });

  test('loads optional AI configuration when provided in environment', () => {
    const config = loadApiConfig({
      DATABASE_URL: 'postgresql://db.test:5432/techpulse',
      AI_CHAT_API_KEY: 'test-chat-key',
      AI_CHAT_BASE_URL: 'https://api.runinfra.com/v1',
      AI_CHAT_MODEL: 'custom-chat-model',
      AI_CHAT_TIMEOUT_MS: '20000',
      AI_EMBEDDING_API_KEY: 'test-embed-key',
      AI_EMBEDDING_MODEL: 'perplexity/pplx-embed-v1-0.6b',
      AI_EMBEDDING_DIMENSIONS: '1024',
    });

    assert.equal(config.aiChatApiKey, 'test-chat-key');
    assert.equal(config.aiChatBaseUrl, 'https://api.runinfra.com/v1');
    assert.equal(config.aiChatModel, 'custom-chat-model');
    assert.equal(config.aiChatTimeoutMs, 20000);
    assert.equal(config.aiEmbeddingApiKey, 'test-embed-key');
    assert.equal(config.aiEmbeddingModel, 'perplexity/pplx-embed-v1-0.6b');
    assert.equal(config.aiEmbeddingDimensions, 1024);
  });

  test('loads the approved provider variable names used by deployment env files', () => {
    const config = loadApiConfig({
      DATABASE_URL: 'postgresql://db.test:5432/techpulse',
      OPENAI_API_KEY: 'runinfra-key',
      OPENAI_BASE_URL: 'https://api.runinfra.ai/v1',
      OPENAI_CHAT_MODEL: 'nemotron-3-5-lightning-30b',
      EMBEDDING_API_KEY: 'openrouter-key',
      EMBEDDING_BASE_URL: 'https://openrouter.ai/api/v1',
      EMBEDDING_MODEL: 'perplexity/pplx-embed-v1-0.6b',
      EMBEDDING_DIMENSIONS: '1024',
    });

    assert.equal(config.aiChatApiKey, 'runinfra-key');
    assert.equal(config.aiChatBaseUrl, 'https://api.runinfra.ai/v1');
    assert.equal(config.aiChatModel, 'nemotron-3-5-lightning-30b');
    assert.equal(config.aiEmbeddingApiKey, 'openrouter-key');
    assert.equal(config.aiEmbeddingBaseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(config.aiEmbeddingModel, 'perplexity/pplx-embed-v1-0.6b');
    assert.equal(config.aiEmbeddingDimensions, 1024);
  });
});
