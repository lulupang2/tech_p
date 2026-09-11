import { describe, expect, test } from 'vitest';

import {
  ContractValidationError,
  mapValidationFailureTo400,
  parseAnswerRequest,
  parseAnswerResponse,
  parseCollectionDelivery,
  parseHealthLiveResponse,
  parseHealthReadyResponse,
  parseSourceDetailResponse,
  parseSourceListResponse,
  parseSourceSummary,
  parseTopicListResponse,
  parseTopicSearchQuery,
  parseTopicSummary,
  safeParseAnswerRequest,
  safeParseErrorEnvelope,
  safeParseHealthLiveResponse,
  safeParseHealthReadyResponse,
  safeParseSourceDetailResponse,
  safeParseSourceListQuery,
  safeParseSourceListResponse,
  safeParseSourceSummary,
  safeParseTopicListResponse,
  safeParseTopicSearchQuery,
  safeParseTopicSummary,
  sanitizeAnswerResponse,
  sanitizeSourceDetailResponse,
  sanitizeSourceListResponse,
  sanitizeTopicListResponse,
} from '../src/index.js';
import {
  jobWithUnknownField,
  malformedAnswerResponse,
  requestWithUnknownField,
  responseWithUndeclaredFields,
  validAnswerRequest,
  validAnswerResponse,
  validCollectionJobPayload,
  validErrorEnvelope,
} from './fixtures/contracts.js';

describe('answer request contract', () => {
  test('accepts required and optional fields', () => {
    expect(parseAnswerRequest({ question: '기술 동향을 요약해줘.' })).toEqual({
      question: '기술 동향을 요약해줘.',
    });
    expect(parseAnswerRequest(validAnswerRequest)).toEqual(validAnswerRequest);
  });

  test('rejects unknown request fields instead of stripping them', () => {
    const result = safeParseAnswerRequest(requestWithUnknownField);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ContractValidationError);
    expect(result.error.issues.length).toBeGreaterThan(0);
  });
});

describe('answer response contract', () => {
  test('sanitizes undeclared response fields explicitly', () => {
    const sanitized = sanitizeAnswerResponse(responseWithUndeclaredFields);

    expect(sanitized).toEqual(validAnswerResponse);
    expect('_internalScore' in sanitized).toBe(false);
    expect('rawPayload' in sanitized.coverage).toBe(false);
  });

  test('keeps optional citation fields optional and validates required fields', () => {
    const result = sanitizeAnswerResponse({
      ...validAnswerResponse,
      answer: null,
      observations: [],
      citations: [
        {
          ...validAnswerResponse.citations[0],
          publishedAt: null,
          excerpt: 'verbatim excerpt',
          license: {
            id: 'cc-by-4.0',
            name: 'CC BY 4.0',
            url: 'https://creativecommons.org/licenses/by/4.0/',
            attribution: 'Author',
          },
        },
      ],
    });

    expect(result.answer).toBeNull();
    expect(result.citations[0]?.license?.id).toBe('cc-by-4.0');
  });

  test('rejects malformed response values', () => {
    expect(() => parseAnswerResponse(malformedAnswerResponse)).toThrow(ContractValidationError);
  });
});

describe('collection job contract', () => {
  test('accepts a versioned identifier-only job payload', () => {
    expect(parseCollectionDelivery(validCollectionJobPayload)).toEqual(validCollectionJobPayload);
  });

  test('rejects large/raw undeclared payload fields', () => {
    expect(() => parseCollectionDelivery(jobWithUnknownField)).toThrow(ContractValidationError);
  });
});

describe('error envelope contract', () => {
  test('accepts the documented validation error envelope', () => {
    expect(safeParseErrorEnvelope(validErrorEnvelope)).toMatchObject({ success: true });
  });

  test('rejects undeclared error fields', () => {
    const result = safeParseErrorEnvelope({
      ...validErrorEnvelope,
      error: { ...validErrorEnvelope.error, internal: 'must be rejected' },
    });

    expect(result.success).toBe(false);
  });
});

test('maps validation failures to deterministic HTTP 400 response', () => {
  const parsed = safeParseAnswerRequest(requestWithUnknownField);
  expect(parsed.success).toBe(false);
  if (parsed.success) return;

  expect(mapValidationFailureTo400(parsed.error, 'req_test')).toEqual({
    status: 400,
    body: {
      requestId: 'req_test',
      error: {
        code: 'INVALID_REQUEST',
        message: 'Request validation failed',
        details: parsed.error.issues,
        retryable: false,
      },
    },
  });
});

describe('health contracts', () => {
  test('validates live response contract', () => {
    const live = { status: 'ok' as const, timestamp: '2026-09-02T12:00:00.000Z' };
    expect(parseHealthLiveResponse(live)).toEqual(live);
    expect(safeParseHealthLiveResponse({ status: 'bad', timestamp: 'invalid' }).success).toBe(
      false,
    );
  });

  test('validates ready response contract', () => {
    const ready = {
      status: 'ok' as const,
      timestamp: '2026-09-02T12:00:00.000Z',
      dependencies: { database: 'ok' as const },
    };
    expect(parseHealthReadyResponse(ready)).toEqual(ready);
    expect(safeParseHealthReadyResponse(ready).success).toBe(true);
    expect(
      parseHealthReadyResponse({
        status: 'unavailable' as const,
        timestamp: '2026-09-02T12:00:00.000Z',
        dependencies: { database: 'unavailable' as const },
      }),
    ).toEqual({
      status: 'unavailable',
      timestamp: '2026-09-02T12:00:00.000Z',
      dependencies: { database: 'unavailable' },
    });
  });
});

describe('source contracts', () => {
  const validSource = {
    key: 'github_releases' as const,
    displayName: 'GitHub Releases',
    kind: 'releases',
    lastSuccessfulCollectionAt: '2026-09-02T00:00:00.000Z',
    freshThrough: '2026-09-02T00:00:00.000Z',
    status: 'healthy' as const,
    coverageNotes: ['Tracks approved repository releases'],
  };

  test('validates source summary contract', () => {
    expect(parseSourceSummary(validSource)).toEqual(validSource);
  });

  test('rejects undeclared fields in source summary', () => {
    const withSecret = { ...validSource, secretToken: 'leak' };
    expect(safeParseSourceSummary(withSecret).success).toBe(false);
  });

  test('validates source list response contract with pagination', () => {
    const listResponse = {
      requestId: 'req_sources_1',
      items: [validSource],
      page: {
        nextCursor: null,
        limit: 20,
      },
    };
    expect(parseSourceListResponse(listResponse)).toEqual(listResponse);
    expect(safeParseSourceListResponse(listResponse).success).toBe(true);
  });

  test('sanitizes source list response undeclared fields', () => {
    const sanitized = sanitizeSourceListResponse({
      requestId: 'req_sources_2',
      items: [{ ...validSource, internalDbId: '123' }],
      page: { nextCursor: 'cur_abc', limit: 10, extra: 'forbidden' },
      extraField: true,
    });
    expect('extraField' in sanitized).toBe(false);
    expect('internalDbId' in sanitized.items[0]!).toBe(false);
    expect(sanitized.page.nextCursor).toBe('cur_abc');
  });

  test('validates and sanitizes source detail response', () => {
    const detail = {
      requestId: 'req_detail_1',
      source: validSource,
    };
    expect(parseSourceDetailResponse(detail)).toEqual(detail);
    expect(safeParseSourceDetailResponse(detail).success).toBe(true);

    const sanitized = sanitizeSourceDetailResponse({
      ...detail,
      source: { ...validSource, internalSecret: 'hide' },
      leak: 'strip',
    });
    expect('leak' in sanitized).toBe(false);
    expect('internalSecret' in sanitized.source).toBe(false);
  });

  test('validates source list query parameters', () => {
    expect(safeParseSourceListQuery({ limit: 10, cursor: 'cur_1' }).success).toBe(true);
    expect(safeParseSourceListQuery({ limit: -1 }).success).toBe(false);
    expect(safeParseSourceListQuery({ unknownParam: 'invalid' }).success).toBe(false);
  });
});

describe('topic contracts', () => {
  const validTopic = {
    slug: 'typescript',
    displayName: 'TypeScript',
    parent: 'language-runtime',
    aliases: ['typescript', 'ts', '타입스크립트'],
    taxonomyVersion: '2026-09-01.1',
  };

  test('validates topic summary contract', () => {
    expect(parseTopicSummary(validTopic)).toEqual(validTopic);
    expect(safeParseTopicSummary(validTopic).success).toBe(true);
  });

  test('validates and sanitizes topic list response contract with pagination', () => {
    const listResponse = {
      requestId: 'req_topics_1',
      items: [validTopic],
      page: {
        nextCursor: 'cur_topic_2',
        limit: 20,
      },
    };
    expect(parseTopicListResponse(listResponse)).toEqual(listResponse);
    expect(safeParseTopicListResponse(listResponse).success).toBe(true);

    const sanitized = sanitizeTopicListResponse({
      ...listResponse,
      items: [{ ...validTopic, internalScore: 99 }],
      extraField: 'remove',
    });
    expect('extraField' in sanitized).toBe(false);
    expect('internalScore' in sanitized.items[0]!).toBe(false);
  });

  test('validates topic search query', () => {
    expect(parseTopicSearchQuery({ q: 'ts', limit: 5 })).toEqual({ q: 'ts', limit: 5 });
    expect(safeParseTopicSearchQuery({ limit: 101 }).success).toBe(false);
    expect(safeParseTopicSearchQuery({ invalidProp: 'bad' }).success).toBe(false);
  });
});
