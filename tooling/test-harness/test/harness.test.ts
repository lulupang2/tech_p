import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  FixtureValidationError,
  buildFixture,
  createFakeChatProvider,
  createFakeEmbeddingProvider,
  createFakeClock,
  createIdGenerator,
  createTestHarness,
  parseFixtureMetadata,
} from '../src/index.js';

const redaction = {
  status: 'not_required' as const,
  fields: [],
  reason: 'Fixture contains no personal or secret data.',
  reviewedAt: '2026-09-01T00:00:00.000Z',
};

const provenance = {
  acquiredAt: '2026-09-01T00:00:00.000Z',
  sourceUrl: 'https://example.test/source/item-1',
  rightsReview: 'approved' as const,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clock and ID injection', () => {
  test('returns fresh dates while preserving deterministic time', () => {
    const clock = createFakeClock('2026-09-01T03:00:00.000Z');
    const first = clock.now();
    clock.advance(7 * 24 * 60 * 60 * 1000);

    expect(first.toISOString()).toBe('2026-09-01T03:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-09-08T03:00:00.000Z');
    expect(first).not.toBe(clock.now());
    clock.reset();
    expect(clock.nowMs()).toBe(Date.parse('2026-09-01T03:00:00.000Z'));
  });

  test('ID sequences reset to the same output', () => {
    const ids = createIdGenerator({ prefix: 'req', seed: 'test' });
    const first = [ids.next(), ids.next('job')];
    ids.reset();

    expect([ids.next(), ids.next('job')]).toEqual(first);
    expect(ids.count).toBe(2);
  });
});

describe('deterministic provider fakes', () => {
  test('chat and embedding output repeats without external services', async () => {
    const chat = createFakeChatProvider({ response: 'fixed answer' });
    const embedding = createFakeEmbeddingProvider({ dimensions: 4 });
    const request = { prompt: 'same prompt', model: 'test-model' };

    const firstChat = await chat.complete(request);
    const firstEmbedding = await embedding.embed('same text');
    chat.reset();
    embedding.reset();
    const secondChat = await chat.complete(request);
    const secondEmbedding = await embedding.embed('same text');

    expect(secondChat).toEqual(firstChat);
    expect(secondEmbedding).toEqual(firstEmbedding);
    expect(embedding.calls).toEqual(['same text']);
  });

  test('configured responses, usage, calls, and errors are observable', async () => {
    const chat = createFakeChatProvider({
      responses: { 'user:known': 'mapped answer' },
      response: 'fallback',
      model: 'fake-model',
    });
    expect(await chat.complete({ messages: [{ role: 'user', content: 'known' }] })).toMatchObject({
      content: 'mapped answer',
      model: 'fake-model',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    expect(chat.calls).toHaveLength(1);

    const failure = new Error('deterministic provider failure');
    const embedding = createFakeEmbeddingProvider({ failWith: failure });
    await expect(embedding.embed('input')).rejects.toBe(failure);
    expect(embedding.calls).toEqual(['input']);
  });
});

describe('fixture provenance and redaction metadata', () => {
  test('builds a fixture and validates metadata at the boundary', () => {
    const fixture = buildFixture({ id: 'source-1', payload: { value: 42 }, provenance, redaction });
    expect(fixture.metadata).toEqual({ provenance, redaction });
    expect(parseFixtureMetadata(fixture.metadata)).toEqual(fixture.metadata);
  });

  test('rejects missing provenance and redaction metadata', () => {
    expect(() => parseFixtureMetadata({})).toThrow(FixtureValidationError);
    expect(() =>
      buildFixture({ id: 'source-1', payload: {}, provenance, redaction: undefined as never }),
    ).toThrow(/redaction metadata is required/u);
    expect(() =>
      parseFixtureMetadata({
        provenance,
        redaction,
        unexpected: true,
      }),
    ).toThrow(/metadata.unexpected is not allowed/u);
  });
  test('requires fields for redacted and no fields for not-required fixtures', () => {
    expect(() =>
      parseFixtureMetadata({
        provenance,
        redaction: { ...redaction, status: 'redacted', fields: [] },
      }),
    ).toThrow(/at least one field/u);
    expect(() =>
      parseFixtureMetadata({
        provenance,
        redaction: { ...redaction, fields: ['author.email'] },
      }),
    ).toThrow(/cannot list redacted fields/u);

    expect(
      parseFixtureMetadata({
        provenance,
        redaction: {
          status: 'redacted',
          fields: ['author.email'],
          reason: 'Removed personal contact information.',
          reviewedAt: redaction.reviewedAt,
        },
      }).redaction.status,
    ).toBe('redacted');
  });
});

test('providers perform no network access', async () => {
  const fetch = vi.fn(() => {
    throw new Error('network access is forbidden in unit tests');
  });
  vi.stubGlobal('fetch', fetch);
  const harness = createTestHarness({ now: '2026-09-01T00:00:00.000Z' });

  await harness.chat.complete({ prompt: 'offline' });
  await harness.embedding.embed('offline');

  expect(fetch).not.toHaveBeenCalled();
});
