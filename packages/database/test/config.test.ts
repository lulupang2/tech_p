import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  DatabaseConfigError,
  isValidDatabaseUrl,
  loadDatabaseConfig,
  maskDatabaseUrl,
  validateDatabaseConfig,
} from '../src/index.js';

describe('database configuration and URL validation', () => {
  test('validates PostgreSQL connection URLs correctly', () => {
    assert.equal(isValidDatabaseUrl('postgresql://localhost/db'), true);
    assert.equal(isValidDatabaseUrl('postgres://user:pass@127.0.0.1:5432/techpulse_dev'), true);
    assert.equal(
      isValidDatabaseUrl('postgresql://host.docker.internal:5432/app?sslmode=disable'),
      true,
    );

    assert.equal(isValidDatabaseUrl(''), false);
    assert.equal(isValidDatabaseUrl('   '), false);
    assert.equal(isValidDatabaseUrl('not a url'), false);
    assert.equal(isValidDatabaseUrl('mysql://localhost/db'), false);
    assert.equal(isValidDatabaseUrl('http://localhost:5432/db'), false);
    assert.equal(isValidDatabaseUrl('sqlite://./data.db'), false);
    assert.equal(isValidDatabaseUrl(undefined), false);
    assert.equal(isValidDatabaseUrl(null), false);
    assert.equal(isValidDatabaseUrl(123), false);
  });

  test('masks passwords and credentials from database URLs without leaking secrets', () => {
    const masked = maskDatabaseUrl(
      'postgresql://techpulse_user:superSecretPassword123@db.example.com:5432/techpulse',
    );
    assert.equal(masked, 'postgresql://techpulse_user:***@db.example.com:5432/techpulse');
    assert.doesNotMatch(masked, /superSecretPassword123/u);

    assert.equal(
      maskDatabaseUrl('postgresql://db.example.com:5432/techpulse'),
      'postgresql://db.example.com:5432/techpulse',
    );

    assert.equal(maskDatabaseUrl(''), '[EMPTY]');
    assert.equal(maskDatabaseUrl('not-a-url-with:secret@data'), '[REDACTED_INVALID_URL]');
    assert.equal(maskDatabaseUrl(undefined), '[EMPTY]');
  });

  test('validateDatabaseConfig succeeds with valid configuration', () => {
    const config = validateDatabaseConfig({
      databaseUrl: 'postgresql://techpulse:password@localhost:5432/dev',
      maxConnections: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    assert.equal(config.databaseUrl, 'postgresql://techpulse:password@localhost:5432/dev');
    assert.equal(config.maxConnections, 10);
    assert.equal(config.idleTimeoutMillis, 30000);
    assert.equal(config.connectionTimeoutMillis, 5000);
  });

  test('validateDatabaseConfig rejects missing or invalid input without leaking values', () => {
    const secretUrl = 'mysql://admin:verySecretPassword@host:3306/db';

    assert.throws(
      () => validateDatabaseConfig(null),
      (error: unknown) => {
        assert(error instanceof DatabaseConfigError);
        assert.match(error.message, /Database configuration must be an object/u);
        return true;
      },
    );

    assert.throws(
      () => validateDatabaseConfig({}),
      (error: unknown) => {
        assert(error instanceof DatabaseConfigError);
        assert.match(error.message, /DATABASE_URL is required/u);
        return true;
      },
    );

    assert.throws(
      () =>
        validateDatabaseConfig({
          databaseUrl: secretUrl,
          maxConnections: -5,
          idleTimeoutMillis: 'invalid',
        }),
      (error: unknown) => {
        assert(error instanceof DatabaseConfigError);
        assert.match(error.message, /DATABASE_URL must be a valid PostgreSQL URL/u);
        assert.match(error.message, /maxConnections must be a positive integer/u);
        assert.match(error.message, /idleTimeoutMillis must be a non-negative integer/u);
        assert.doesNotMatch(error.message, /verySecretPassword/u);
        assert.doesNotMatch(error.message, new RegExp(secretUrl, 'u'));
        return true;
      },
    );
  });

  test('loadDatabaseConfig reads and validates environment variables', () => {
    const config = loadDatabaseConfig({
      DATABASE_URL: 'postgresql://localhost:5432/techpulse_test',
      DATABASE_MAX_CONNECTIONS: '5',
      DATABASE_IDLE_TIMEOUT_MS: '15000',
      DATABASE_CONNECTION_TIMEOUT_MS: '2000',
    });

    assert.equal(config.databaseUrl, 'postgresql://localhost:5432/techpulse_test');
    assert.equal(config.maxConnections, 5);
    assert.equal(config.idleTimeoutMillis, 15000);
    assert.equal(config.connectionTimeoutMillis, 2000);
  });

  test('loadDatabaseConfig throws DatabaseConfigError when DATABASE_URL is missing', () => {
    assert.throws(
      () => loadDatabaseConfig({}),
      (error: unknown) => {
        assert(error instanceof DatabaseConfigError);
        assert.match(error.message, /DATABASE_URL is required/u);
        return true;
      },
    );
  });
});
