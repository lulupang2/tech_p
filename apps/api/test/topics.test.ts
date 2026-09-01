import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createApp } from '../src/app.js';
import { parseErrorEnvelope, parseTopicListResponse } from '@techpulse/contracts';

describe('API-002 topics endpoints', () => {
  test('GET /api/v1/topics returns topic list envelope with 200 OK', async () => {
    const app = createApp();

    const response = await app.handle(
      new Request('http://localhost/api/v1/topics', {
        headers: { 'x-request-id': 'req_topics_test_1' },
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req_topics_test_1');

    const body = await response.json();
    const parsed = parseTopicListResponse(body);
    assert.equal(parsed.requestId, 'req_topics_test_1');
    assert.ok(Array.isArray(parsed.items));
    assert.ok(parsed.items.length > 0);
    assert.equal(parsed.page.limit, 20);

    const first = parsed.items[0]!;
    assert.ok(typeof first.slug === 'string');
    assert.ok(typeof first.displayName === 'string');
    assert.ok(Array.isArray(first.aliases));
    assert.equal(first.taxonomyVersion, '2026-09-01.1');
  });

  test('GET /api/v1/topics?q=ts filters topics by slug, displayName, or alias', async () => {
    const app = createApp();

    const response = await app.handle(
      new Request('http://localhost/api/v1/topics?q=typescript', {
        headers: { 'x-request-id': 'req_topics_search' },
      }),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    const parsed = parseTopicListResponse(body);
    assert.ok(parsed.items.length > 0);
    assert.ok(parsed.items.some((topic) => topic.slug === 'typescript'));
  });

  test('GET /api/v1/topics supports limit and stable cursor pagination', async () => {
    const app = createApp();

    const response1 = await app.handle(
      new Request('http://localhost/api/v1/topics?limit=5', {
        headers: { 'x-request-id': 'req_topics_p1' },
      }),
    );

    assert.equal(response1.status, 200);
    const body1 = await response1.json();
    const page1 = parseTopicListResponse(body1);
    assert.equal(page1.items.length, 5);
    assert.equal(page1.page.limit, 5);
    assert.ok(page1.page.nextCursor !== null);

    // Page 2
    const response2 = await app.handle(
      new Request(`http://localhost/api/v1/topics?limit=5&cursor=${page1.page.nextCursor}`, {
        headers: { 'x-request-id': 'req_topics_p2' },
      }),
    );

    assert.equal(response2.status, 200);
    const body2 = await response2.json();
    const page2 = parseTopicListResponse(body2);
    assert.equal(page2.items.length, 5);
    assert.notEqual(page1.items[0]?.slug, page2.items[0]?.slug);
  });

  test('GET /api/v1/topics returns empty items when query matches nothing', async () => {
    const app = createApp();

    const response = await app.handle(
      new Request('http://localhost/api/v1/topics?q=non_existent_topic_xyz_123', {
        headers: { 'x-request-id': 'req_topics_empty' },
      }),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    const parsed = parseTopicListResponse(body);
    assert.equal(parsed.items.length, 0);
    assert.equal(parsed.page.nextCursor, null);
  });

  test('GET /api/v1/topics rejects unknown query parameters with 400 INVALID_REQUEST', async () => {
    const app = createApp();

    const response = await app.handle(
      new Request('http://localhost/api/v1/topics?unknownParam=xyz', {
        headers: { 'x-request-id': 'req_topics_bad_param' },
      }),
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    const envelope = parseErrorEnvelope(body);
    assert.equal(envelope.requestId, 'req_topics_bad_param');
    assert.equal(envelope.error.code, 'INVALID_REQUEST');
  });

  test('GET /api/v1/topics rejects malformed cursor with 400 INVALID_REQUEST', async () => {
    const app = createApp();

    const response = await app.handle(
      new Request('http://localhost/api/v1/topics?cursor=invalid_cursor_string', {
        headers: { 'x-request-id': 'req_topics_bad_cursor' },
      }),
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    const envelope = parseErrorEnvelope(body);
    assert.equal(envelope.requestId, 'req_topics_bad_cursor');
    assert.equal(envelope.error.code, 'INVALID_REQUEST');
  });
});
