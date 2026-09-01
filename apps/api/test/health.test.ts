import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createApp } from '../src/app.js';
import { parseHealthLiveResponse, parseHealthReadyResponse } from '@techpulse/contracts';

describe('health endpoints', () => {
  test('GET /health/live succeeds without database dependency', async () => {
    let dbChecked = false;
    const app = createApp({
      checkDatabaseHealth: async () => {
        dbChecked = true;
        return true;
      },
    });

    const response = await app.handle(
      new Request('http://localhost/health/live', {
        headers: { 'x-request-id': 'req_custom_123' },
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req_custom_123');
    assert.equal(dbChecked, false, 'Liveness must not invoke database health checks');

    const body = await response.json();
    const parsed = parseHealthLiveResponse(body);
    assert.equal(parsed.status, 'ok');
    assert.ok(!Number.isNaN(Date.parse(parsed.timestamp)));
  });

  test('GET /health/ready returns 200 when database is healthy', async () => {
    let dbChecked = false;
    const app = createApp({
      checkDatabaseHealth: async () => {
        dbChecked = true;
        return true;
      },
    });

    const response = await app.handle(
      new Request('http://localhost/health/ready', {
        headers: { 'x-request-id': 'req_ready_ok' },
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req_ready_ok');
    assert.equal(dbChecked, true);

    const body = await response.json();
    const parsed = parseHealthReadyResponse(body);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.dependencies.database, 'ok');
  });

  test('GET /health/ready returns 503 without leaking credentials when database fails', async () => {
    const sensitiveError =
      'FATAL: password authentication failed for user secret_user postgres://secret_user:super_secret@db.host/prod';
    const app = createApp({
      checkDatabaseHealth: async () => {
        throw new Error(sensitiveError);
      },
    });

    const response = await app.handle(new Request('http://localhost/health/ready'));

    assert.equal(response.status, 503);
    const requestId = response.headers.get('x-request-id');
    assert.ok(requestId !== null && requestId.startsWith('req_'));

    const rawText = await response.text();
    assert.doesNotMatch(rawText, /secret_user/);
    assert.doesNotMatch(rawText, /super_secret/);
    assert.doesNotMatch(rawText, /FATAL/);

    const parsed = parseHealthReadyResponse(JSON.parse(rawText));
    assert.equal(parsed.status, 'unavailable');
    assert.equal(parsed.dependencies.database, 'unavailable');
  });

  test('generates valid requestId when client requestId is invalid or absent', async () => {
    const app = createApp();

    const response = await app.handle(
      new Request('http://localhost/health/live', {
        headers: { 'x-request-id': 'invalid space and characters!' },
      }),
    );

    assert.equal(response.status, 200);
    const requestId = response.headers.get('x-request-id');
    assert.ok(requestId !== null);
    assert.ok(requestId.startsWith('req_'));
    assert.notEqual(requestId, 'invalid space and characters!');
  });
});
