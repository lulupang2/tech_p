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
      port: 4310,
    });
  });
});
