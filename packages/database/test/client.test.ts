import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createDatabaseClient, DatabaseConfigError } from '../src/index.js';

describe('database client factory', () => {
  test('creates a lazy client that does not connect or log at instantiation', () => {
    // Port 59999 is intentionally unused; if this connected eagerly, it would fail
    const client = createDatabaseClient({
      databaseUrl: 'postgresql://techpulse_user:testpass@127.0.0.1:59999/techpulse_test',
    });

    // Verification: pool is created, but no connection is established
    assert.equal(client.isConnected, false);
    assert.ok(client.db);
    assert.ok(client.pool);
    assert.equal(typeof client.connect, 'function');
    assert.equal(typeof client.checkHealth, 'function');
    assert.equal(typeof client.close, 'function');
    assert.equal(typeof client.migrate, 'function');
    assert.equal(typeof client.checkVector, 'function');

    // Cleanly closing an un-connected pool should succeed without error
    return client.close();
  });

  test('accepts connection string directly as single argument', async () => {
    const client = createDatabaseClient(
      'postgresql://techpulse_user:testpass@127.0.0.1:59998/techpulse_test',
    );

    assert.equal(client.isConnected, false);
    await client.close();
  });

  test('rejects invalid configuration immediately without leaking secrets', () => {
    const secretUrl = 'invalid-protocol://user:superSecretPass@localhost:5432/db';

    assert.throws(
      () => createDatabaseClient({ databaseUrl: secretUrl }),
      (error: unknown) => {
        assert(error instanceof DatabaseConfigError);
        assert.match(error.message, /DATABASE_URL must be a valid PostgreSQL URL/u);
        assert.doesNotMatch(error.message, /superSecretPass/u);
        return true;
      },
    );
  });

  test('health check returns false without throwing when database is unreachable', async () => {
    const client = createDatabaseClient({
      databaseUrl: 'postgresql://techpulse_user:testpass@127.0.0.1:59997/techpulse_test',
      connectionTimeoutMillis: 1000,
    });

    try {
      const isHealthy = await client.checkHealth();
      assert.equal(isHealthy, false);
    } finally {
      await client.close();
    }
  });

  test('connect failure sanitizes error message without leaking credentials', async () => {
    const secretPassword = 'myPrivateSecret123';
    const client = createDatabaseClient({
      databaseUrl: `postgresql://user:${secretPassword}@127.0.0.1:59996/nonexistent_db`,
      connectionTimeoutMillis: 500,
    });

    try {
      await assert.rejects(
        () => client.connect(),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.match(error.message, /Database connection failed/u);
          assert.doesNotMatch(error.message, new RegExp(secretPassword, 'u'));
          return true;
        },
      );
    } finally {
      await client.close();
    }
  });
});
