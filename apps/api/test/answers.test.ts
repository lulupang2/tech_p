import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createApp } from '../src/app.js';
import { parseAnswerResponse, parseErrorEnvelope } from '@techpulse/contracts';
import {
  AiProviderError,
  AiTimeoutError,
  createDeterministicChatPort,
  type SearchHit,
  type SearchServicePort,
} from '@techpulse/domain';
import { createAnswerService } from '@techpulse/rag';

function createFakeSearchService(hits: readonly SearchHit[]): SearchServicePort {
  return {
    searchFts: async () => hits,
    searchExactVector: async () => hits,
  };
}

describe('API-003 answers endpoint (POST /api/v1/answers)', () => {
  const fixedNow = new Date('2026-09-01T12:00:00.000Z');
  const nowFn = () => fixedNow;

  const sampleHits: SearchHit[] = [
    {
      chunkId: 'chunk-101',
      documentId: 'doc-101',
      documentRevisionId: 'rev-101',
      title: 'Bun and Node.js Comparison 2026',
      content:
        'Bun 1.1 achieves high compatibility with Node.js APIs while maintaining faster startup times.',
      headingPath: ['Performance', 'Compatibility'],
      score: 0.95,
      publishedAt: new Date('2026-08-20T00:00:00.000Z'),
    },
  ];

  test('POST /api/v1/answers returns 200 OK with valid answered payload and citations', async () => {
    const chatPort = createDeterministicChatPort({
      response: 'Bun 1.1은 Node.js 호환성을 유지하면서 빠른 시작 속도를 제공합니다 [C1].',
    });
    const searchService = createFakeSearchService(sampleHits);
    const answerService = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    const app = createApp({ answerService });

    const response = await app.handle(
      new Request('http://localhost/api/v1/answers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'req_answers_test_1',
        },
        body: JSON.stringify({
          question: 'Bun과 Node.js의 최신 차이점을 비교해줘.',
          timeRange: {
            from: '2026-08-01T00:00:00.000Z',
            to: '2026-09-01T00:00:00.000Z',
          },
          timezone: 'Asia/Seoul',
          language: 'ko',
        }),
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req_answers_test_1');

    const body = await response.json();
    const parsed = parseAnswerResponse(body);

    assert.equal(parsed.requestId, 'req_answers_test_1');
    assert.equal(parsed.status, 'answered');
    assert.equal(parsed.intent, 'compare_interest');
    assert.ok(typeof parsed.answer === 'string' && parsed.answer.includes('[C1]'));
    assert.equal(parsed.citations.length, 1);
    assert.equal(parsed.citations[0]!.id, 'C1');
    assert.equal(parsed.citations[0]!.documentRevisionId, 'rev-101');
    assert.equal(parsed.citations[0]!.title, 'Bun and Node.js Comparison 2026');
    assert.equal(parsed.resolvedTimeRange.from, '2026-08-01T00:00:00.000Z');
    assert.equal(parsed.resolvedTimeRange.to, '2026-09-01T00:00:00.000Z');
    assert.equal(parsed.resolvedTimeRange.timezone, 'Asia/Seoul');
    assert.equal(parsed.coverage.sourcesUsed, 1);
    assert.equal(parsed.coverage.documentsConsidered, 1);
  });

  test('POST /api/v1/answers returns 200 OK with insufficient_evidence when no data matches', async () => {
    const chatPort = createDeterministicChatPort();
    const searchService = createFakeSearchService([]);
    const answerService = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    const app = createApp({ answerService });

    const response = await app.handle(
      new Request('http://localhost/api/v1/answers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'req_answers_empty_1',
        },
        body: JSON.stringify({
          question: '존재하지 않는 기술에 대한 질문',
        }),
      }),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    const parsed = parseAnswerResponse(body);

    assert.equal(parsed.status, 'insufficient_evidence');
    assert.equal(parsed.answer, null);
    assert.deepEqual(parsed.citations, []);
    assert.deepEqual(parsed.observations, []);
    assert.equal(parsed.coverage.documentsConsidered, 0);
    assert.ok(parsed.coverage.limitations.length > 0);
  });

  test('POST /api/v1/answers rejects unknown fields with 400 INVALID_REQUEST', async () => {
    const chatPort = createDeterministicChatPort();
    const searchService = createFakeSearchService([]);
    const answerService = createAnswerService({ chatPort, searchService, now: nowFn });
    const app = createApp({ answerService });

    const response = await app.handle(
      new Request('http://localhost/api/v1/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'Bun이란?',
          unexpectedField: 'forbidden',
        }),
      }),
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    const errorEnv = parseErrorEnvelope(body);
    assert.equal(errorEnv.error.code, 'INVALID_REQUEST');
  });

  test('POST /api/v1/answers rejects invalid timeRange (to <= from) with 400 INVALID_TIME_RANGE', async () => {
    const chatPort = createDeterministicChatPort();
    const searchService = createFakeSearchService(sampleHits);
    const answerService = createAnswerService({ chatPort, searchService, now: nowFn });
    const app = createApp({ answerService });

    const response = await app.handle(
      new Request('http://localhost/api/v1/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'Bun이란?',
          timeRange: {
            from: '2026-09-01T00:00:00.000Z',
            to: '2026-08-01T00:00:00.000Z',
          },
        }),
      }),
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    const errorEnv = parseErrorEnvelope(body);
    assert.equal(errorEnv.error.code, 'INVALID_TIME_RANGE');
    assert.equal(errorEnv.error.message, 'timeRange.to must be after timeRange.from');
  });

  test('POST /api/v1/answers returns 504 ANSWER_TIMEOUT on model deadline exceeded', async () => {
    const chatPort = {
      complete: async () => {
        throw new AiTimeoutError('Chat request timed out');
      },
    };
    const searchService = createFakeSearchService(sampleHits);
    const answerService = createAnswerService({ chatPort, searchService, now: nowFn });
    const app = createApp({ answerService });

    const response = await app.handle(
      new Request('http://localhost/api/v1/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'Bun 질문',
        }),
      }),
    );

    assert.equal(response.status, 504);
    const body = await response.json();
    const errorEnv = parseErrorEnvelope(body);
    assert.equal(errorEnv.error.code, 'ANSWER_TIMEOUT');
  });

  test('POST /api/v1/answers returns 502 MODEL_PROVIDER_ERROR on provider failure', async () => {
    const chatPort = {
      complete: async () => {
        throw new AiProviderError('Provider returned 500');
      },
    };
    const searchService = createFakeSearchService(sampleHits);
    const answerService = createAnswerService({ chatPort, searchService, now: nowFn });
    const app = createApp({ answerService });

    const response = await app.handle(
      new Request('http://localhost/api/v1/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'Bun 질문',
        }),
      }),
    );

    assert.equal(response.status, 502);
    const body = await response.json();
    const errorEnv = parseErrorEnvelope(body);
    assert.equal(errorEnv.error.code, 'MODEL_PROVIDER_ERROR');
  });

  test('POST /api/v1/answers returns 503 DEPENDENCY_UNAVAILABLE when answer service is not configured', async () => {
    const app = createApp(); // no answerService

    const response = await app.handle(
      new Request('http://localhost/api/v1/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: '질문',
        }),
      }),
    );

    assert.equal(response.status, 503);
    const body = await response.json();
    const errorEnv = parseErrorEnvelope(body);
    assert.equal(errorEnv.error.code, 'DEPENDENCY_UNAVAILABLE');
  });

  test('answers endpoint never leaks secrets or internal connection strings in response or errors', async () => {
    const secretKey = 'sk-super-secret-production-key-999';
    const chatPort = {
      complete: async () => {
        throw new Error(`Upstream auth failed for bearer ${secretKey}`);
      },
    };
    const searchService = createFakeSearchService(sampleHits);
    const answerService = createAnswerService({ chatPort, searchService, now: nowFn });
    const app = createApp({ answerService });

    const response = await app.handle(
      new Request('http://localhost/api/v1/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: '비밀 유출 테스트 질문',
        }),
      }),
    );

    const rawText = await response.text();
    assert.ok(!rawText.includes(secretKey), 'Response must not contain secret key');
    assert.ok(
      !rawText.includes('postgres:'),
      'Response must not contain postgres connection string',
    );
  });
});
