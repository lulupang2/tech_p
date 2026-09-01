import { describe, expect, test } from 'vitest';

import {
  ContractValidationError,
  mapValidationFailureTo400,
  parseAnswerRequest,
  parseAnswerResponse,
  parseCollectionJobPayload,
  parseHealthLiveResponse,
  parseHealthReadyResponse,
  sanitizeAnswerResponse,
  safeParseAnswerRequest,
  safeParseCollectionJobPayload,
  safeParseErrorEnvelope,
  safeParseHealthLiveResponse,
  safeParseHealthReadyResponse,
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
    expect(parseCollectionJobPayload(validCollectionJobPayload)).toEqual(validCollectionJobPayload);
  });

  test('rejects large/raw undeclared payload fields', () => {
    const result = safeParseCollectionJobPayload(jobWithUnknownField);

    expect(result.success).toBe(false);
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
