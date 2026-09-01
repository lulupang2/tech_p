import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createApp } from '../src/app.js';
import { parseErrorEnvelope } from '@techpulse/contracts';
import { Elysia, t } from 'elysia';

describe('API error model and handling', () => {
  test('returns 404 with standard ErrorEnvelope on non-existent route', async () => {
    const app = createApp();

    const response = await app.handle(
      new Request('http://localhost/non-existent-route', {
        headers: { 'x-request-id': 'req_404_test' },
      }),
    );

    assert.equal(response.status, 404);
    assert.equal(response.headers.get('x-request-id'), 'req_404_test');

    const body = await response.json();
    const envelope = parseErrorEnvelope(body);
    assert.equal(envelope.requestId, 'req_404_test');
    assert.equal(envelope.error.code, 'NOT_FOUND');
    assert.equal(envelope.error.retryable, false);
  });

  test('maps Elysia validation failures to HTTP 400 with details', async () => {
    const testApp = createApp().use(
      new Elysia().post('/test/validate', ({ body }) => ({ success: true, body }), {
        body: t.Object({
          name: t.String({ minLength: 2 }),
          count: t.Number({ minimum: 1 }),
        }),
      }),
    );

    const response = await testApp.handle(
      new Request('http://localhost/test/validate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_val_test',
        },
        body: JSON.stringify({ name: 'a', count: 0 }),
      }),
    );

    assert.equal(response.status, 400);
    assert.equal(response.headers.get('x-request-id'), 'req_val_test');

    const body = await response.json();
    const envelope = parseErrorEnvelope(body);
    assert.equal(envelope.requestId, 'req_val_test');
    assert.equal(envelope.error.code, 'INVALID_REQUEST');
    assert.ok(envelope.error.details.length > 0);
  });

  test('sanitizes unexpected 500 errors and never exposes secret/stack details', async () => {
    const secretMsg =
      'DATABASE_PASSWORD=super_secret_leak; SELECT * FROM credentials WHERE token="xyz"';
    const testApp = createApp().use(
      new Elysia().get('/test/boom', () => {
        throw new Error(secretMsg);
      }),
    );

    const response = await testApp.handle(
      new Request('http://localhost/test/boom', {
        headers: { 'x-request-id': 'req_boom_test' },
      }),
    );

    assert.equal(response.status, 500);
    assert.equal(response.headers.get('x-request-id'), 'req_boom_test');

    const rawText = await response.text();
    assert.doesNotMatch(rawText, /super_secret_leak/);
    assert.doesNotMatch(rawText, /credentials/);
    assert.doesNotMatch(rawText, /DATABASE_PASSWORD/);

    const envelope = parseErrorEnvelope(JSON.parse(rawText));
    assert.equal(envelope.requestId, 'req_boom_test');
    assert.equal(envelope.error.code, 'INTERNAL_SERVER_ERROR');
    assert.equal(envelope.error.details.length, 0);
  });
});
