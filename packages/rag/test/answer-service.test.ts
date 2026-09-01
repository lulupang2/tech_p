import { describe, expect, test } from 'vitest';
import {
  AiProviderError,
  AiTimeoutError,
  createDeterministicChatPort,
  createDeterministicEmbeddingPort,
  type SearchHit,
  type SearchServicePort,
} from '@techpulse/domain';
import {
  createAnswerService,
  detectIntent,
  resolveTimeRange,
  InvalidTimeRangeError,
  ModelProviderError,
  AnswerTimeoutError,
} from '../src/index.js';

function createFakeSearchService(hits: readonly SearchHit[]): SearchServicePort {
  return {
    searchFts: async () => hits,
    searchExactVector: async () => hits,
  };
}

describe('RAG Answer Service (API-003)', () => {
  const fixedNow = new Date('2026-09-01T12:00:00.000Z');
  const nowFn = () => fixedNow;

  test('intent detection correctly identifies question intents', () => {
    expect(detectIntent('Bun과 Node.js 성능 비교해줘')).toBe('compare_interest');
    expect(detectIntent('Playwright 최신 릴리스 및 업데이트 사항 알려줘')).toBe('recent_updates');
    expect(detectIntent('최근 AI 분야에서 주목받는 부상 기술')).toBe('emerging_topics');
    expect(detectIntent('TypeScript 백엔드 트렌드 요약')).toBe('trend_summary');
  });

  test('resolves time range with valid custom bounds and default 30-day window', () => {
    const custom = resolveTimeRange(
      { from: '2026-08-01T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z' },
      'Asia/Seoul',
      nowFn,
    );
    expect(custom).toEqual({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-15T00:00:00.000Z',
      timezone: 'Asia/Seoul',
    });

    const fallback = resolveTimeRange(undefined, undefined, nowFn);
    expect(fallback.timezone).toBe('UTC');
    expect(fallback.to).toBe('2026-09-01T12:00:00.000Z');
    expect(fallback.from).toBe(
      new Date(fixedNow.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  test('rejects invalid timeRange where to <= from', () => {
    expect(() =>
      resolveTimeRange(
        { from: '2026-08-15T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
        'UTC',
        nowFn,
      ),
    ).toThrow(InvalidTimeRangeError);

    expect(() =>
      resolveTimeRange(
        { from: '2026-08-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
        'UTC',
        nowFn,
      ),
    ).toThrow(InvalidTimeRangeError);
  });

  test('generates valid answered response with grounded citations and coverage', async () => {
    const sampleHits: SearchHit[] = [
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        documentRevisionId: 'rev-1',
        title: 'Bun 1.1 Release Notes',
        content: 'Bun 1.1 includes Windows support and new Node.js compatibility APIs.',
        headingPath: ['Release', 'Features'],
        score: 0.95,
        publishedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    ];

    const chatPort = createDeterministicChatPort({
      response: 'Bun 1.1은 Windows 지원과 향상된 Node.js 호환성을 제공합니다 [C1].',
    });
    const searchService = createFakeSearchService(sampleHits);

    const service = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: 'Bun 1.1의 주요 변경점은 무엇인가요?',
      requestId: 'req_test_valid_1',
    });

    expect(response.status).toBe('answered');
    expect(response.requestId).toBe('req_test_valid_1');
    expect(response.answer).toBe(
      'Bun 1.1은 Windows 지원과 향상된 Node.js 호환성을 제공합니다 [C1].',
    );
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]).toMatchObject({
      id: 'C1',
      documentRevisionId: 'rev-1',
      title: 'Bun 1.1 Release Notes',
      excerptIsVerbatim: true,
    });
    expect(response.coverage.documentsConsidered).toBe(1);
    expect(response.coverage.sourcesUsed).toBe(1);
    expect(response.coverage.limitations).toEqual([]);
  });

  test('rejects fabricated citation IDs and falls back to insufficient_evidence', async () => {
    const sampleHits: SearchHit[] = [
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        documentRevisionId: 'rev-1',
        title: 'Bun 1.1 Release Notes',
        content: 'Bun 1.1 released with Windows support.',
        headingPath: [],
        score: 0.9,
        publishedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    ];

    // Model hallucinates/fabricates [C99] which does not exist in context
    const chatPort = createDeterministicChatPort({
      response: 'Bun은 매우 빠릅니다 [C99].',
    });
    const searchService = createFakeSearchService(sampleHits);

    const service = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: 'Bun의 속도는?',
      requestId: 'req_test_fabricated_1',
    });

    expect(response.status).toBe('insufficient_evidence');
    expect(response.answer).toBeNull();
    expect(response.citations).toEqual([]);
    expect(response.coverage.limitations[0]).toContain('인용 검증 실패');
  });

  test('rejects answers lacking citations and returns insufficient_evidence', async () => {
    const sampleHits: SearchHit[] = [
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        documentRevisionId: 'rev-1',
        title: 'Release Notes',
        content: 'Release information.',
        headingPath: [],
        score: 0.8,
        publishedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    ];

    // Model returns answer without any [C1] marker
    const chatPort = createDeterministicChatPort({
      response: '일반적인 지식에 기반한 답변입니다.',
    });
    const searchService = createFakeSearchService(sampleHits);

    const service = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: '정보 요청',
      requestId: 'req_test_missing_cite_1',
    });

    expect(response.status).toBe('insufficient_evidence');
    expect(response.answer).toBeNull();
    expect(response.citations).toEqual([]);
    expect(response.coverage.limitations[0]).toContain('근거 인용이 포함되지 않았습니다');
  });

  test('returns insufficient_evidence when no search hits match the time window', async () => {
    const chatPort = createDeterministicChatPort({
      response: 'should not be called',
    });
    const searchService = createFakeSearchService([]);

    const service = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: '알 수 없는 비공개 라이브러리 정보',
      requestId: 'req_test_empty_1',
    });

    expect(response.status).toBe('insufficient_evidence');
    expect(response.answer).toBeNull();
    expect(response.citations).toEqual([]);
    expect(response.coverage.documentsConsidered).toBe(0);
    expect(response.coverage.sourcesUsed).toBe(0);
    expect(response.coverage.limitations).toEqual(['요청 기간의 근거가 충분하지 않습니다.']);
  });

  test('maps chat provider timeout to AnswerTimeoutError', async () => {
    const sampleHits: SearchHit[] = [
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        documentRevisionId: 'rev-1',
        title: 'Title',
        content: 'Content',
        headingPath: [],
        score: 0.9,
        publishedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    ];

    const chatPort = {
      complete: async () => {
        throw new AiTimeoutError('Request timed out');
      },
    };
    const searchService = createFakeSearchService(sampleHits);

    const service = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    await expect(
      service.generateAnswer({
        question: '테스트 질문',
        requestId: 'req_timeout',
      }),
    ).rejects.toBeInstanceOf(AnswerTimeoutError);
  });

  test('maps chat provider error to ModelProviderError', async () => {
    const sampleHits: SearchHit[] = [
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        documentRevisionId: 'rev-1',
        title: 'Title',
        content: 'Content',
        headingPath: [],
        score: 0.9,
        publishedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    ];

    const chatPort = {
      complete: async () => {
        throw new AiProviderError('Provider 500 internal error');
      },
    };
    const searchService = createFakeSearchService(sampleHits);

    const service = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    await expect(
      service.generateAnswer({
        question: '테스트 질문',
        requestId: 'req_error',
      }),
    ).rejects.toBeInstanceOf(ModelProviderError);
  });

  test('supports hybrid search with embedding port when available', async () => {
    const sampleHits: SearchHit[] = [
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        documentRevisionId: 'rev-1',
        title: 'Hybrid Hit',
        content: 'Hybrid content chunk.',
        headingPath: [],
        score: 0.88,
        publishedAt: new Date('2026-08-25T00:00:00.000Z'),
      },
    ];

    const chatPort = createDeterministicChatPort({
      response: '하이브리드 검색 결과 답변 [C1]',
    });
    const embeddingPort = createDeterministicEmbeddingPort({ dimensions: 8 });
    const searchService = createFakeSearchService(sampleHits);

    const service = createAnswerService({
      chatPort,
      searchService,
      embeddingPort,
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: '하이브리드 검색 테스트',
      requestId: 'req_hybrid',
    });

    expect(response.status).toBe('answered');
    expect(response.citations).toHaveLength(1);
    expect(embeddingPort.calls).toHaveLength(1);
  });
});
