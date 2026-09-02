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
  UNBOUNDED_START,
  createAnswerService,
  detectIntent,
  resolveTimeRange,
  InvalidTimeRangeError,
  ModelProviderError,
  DatabaseRetrievalError,
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

  test('resolves time range with valid custom bounds and unbounded/latest fallback when omitted', () => {
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
    expect(fallback.from).toBe(UNBOUNDED_START);
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

  test("regression: natural-language question '최근 Playwright 릴리스의 주요 변경점을 알려줘.' finds Playwright chunk via fallback", async () => {
    const playwrightChunk: SearchHit = {
      chunkId: 'chunk-playwright-1',
      documentId: 'doc-playwright-1',
      documentRevisionId: 'rev-playwright-1',
      title: 'Playwright v1.62.1 Release Notes',
      content: 'Playwright v1.62.1 introduces new assertions and enhanced locator timeouts.',
      headingPath: ['Releases', 'v1.62.1'],
      score: 0.95,
      publishedAt: new Date('2026-08-25T10:00:00.000Z'),
    };

    const queriesExecuted: string[] = [];
    const searchService: SearchServicePort = {
      searchFts: async (params) => {
        queriesExecuted.push(params.query);
        // Strict exact match on the full Korean question fails (0 hits)
        if (params.query === '최근 Playwright 릴리스의 주요 변경점을 알려줘.') {
          return [];
        }
        // Fallback with normalized query or tech keyword 'Playwright' matches
        if (params.query.includes('Playwright')) {
          return [playwrightChunk];
        }
        return [];
      },
      searchExactVector: async () => [],
    };

    const chatPort = createDeterministicChatPort({
      response: 'Playwright v1.62.1의 주요 변경점은 새 어설션과 로케이터 타임아웃 개선입니다 [C1].',
    });

    const service = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: '최근 Playwright 릴리스의 주요 변경점을 알려줘.',
      requestId: 'req_playwright_regression',
    });

    expect(response.status).toBe('answered');
    expect(response.answer).toContain('[C1]');
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.documentRevisionId).toBe('rev-playwright-1');
    expect(response.coverage.documentsConsidered).toBe(1);
    expect(queriesExecuted.length).toBeGreaterThan(1);
    expect(queriesExecuted[0]).toBe('최근 Playwright 릴리스의 주요 변경점을 알려줘.');
  });

  test('regression: unrelated natural-language query returns insufficient_evidence with zero documents considered', async () => {
    const queriesExecuted: string[] = [];
    const searchService: SearchServicePort = {
      searchFts: async (params) => {
        queriesExecuted.push(params.query);
        // Unrelated query matches nothing in technical corpus
        return [];
      },
      searchExactVector: async () => [],
    };

    const chatPort = createDeterministicChatPort({
      response: '응답 [C1]',
    });

    const service = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: '오늘 서울 날씨 어때?',
      requestId: 'req_unrelated_weather',
    });

    expect(response.status).toBe('insufficient_evidence');
    expect(response.answer).toBeNull();
    expect(response.citations).toHaveLength(0);
    expect(response.coverage.documentsConsidered).toBe(0);
  });

  test('regression: preserves publishedAt and status filters during natural query fallback retrieval', async () => {
    const filterSnapshots: Array<Record<string, unknown>> = [];
    const searchService: SearchServicePort = {
      searchFts: async (params) => {
        filterSnapshots.push({
          query: params.query,
          status: params.filter?.status,
          publishedAfter: params.filter?.publishedAfter?.toISOString(),
          publishedBefore: params.filter?.publishedBefore?.toISOString(),
        });
        if (
          params.query.includes('Playwright') &&
          params.query !== '최근 Playwright 릴리스의 주요 변경점을 알려줘.'
        ) {
          return [
            {
              chunkId: 'chunk-p1',
              documentId: 'doc-p1',
              documentRevisionId: 'rev-p1',
              title: 'Playwright Release',
              content: 'Playwright features',
              headingPath: [],
              score: 0.9,
              publishedAt: new Date('2026-08-25T00:00:00.000Z'),
            },
          ];
        }
        return [];
      },
      searchExactVector: async () => [],
    };

    const chatPort = createDeterministicChatPort({
      response: 'Playwright 내용입니다 [C1].',
    });

    const service = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    await service.generateAnswer({
      question: '최근 Playwright 릴리스의 주요 변경점을 알려줘.',
      timeRange: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' },
    });

    expect(filterSnapshots.length).toBeGreaterThan(1);
    for (const snap of filterSnapshots) {
      expect(snap['status']).toBe('searchable');
      expect(snap['publishedAfter']).toBe('2026-08-01T00:00:00.000Z');
      expect(snap['publishedBefore']).toBe('2026-08-31T00:00:00.000Z');
    }
  });

  test('regression: maps database search failure to DatabaseRetrievalError (distinct from ModelProviderError)', async () => {
    const searchService: SearchServicePort = {
      searchFts: async () => {
        throw new Error('Database connection pool exhausted');
      },
      searchExactVector: async () => [],
    };

    const chatPort = createDeterministicChatPort({
      response: '답변 [C1]',
    });

    const service = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    let caughtError: unknown;
    try {
      await service.generateAnswer({
        question: 'Playwright 변경점',
        requestId: 'req_db_err',
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(DatabaseRetrievalError);
    expect(caughtError).not.toBeInstanceOf(ModelProviderError);
    expect((caughtError as DatabaseRetrievalError).code).toBe('DATABASE_RETRIEVAL_ERROR');
    expect((caughtError as DatabaseRetrievalError).retryable).toBe(true);
  });

  test('policy: omitted timeRange retrieves latest searchable data even if older than old 30-day default window', async () => {
    // Hit published on 2026-01-15, which is ~7.5 months before fixedNow (2026-09-01).
    // Under the old 30-day default window, this hit would have been excluded.
    const olderHit: SearchHit = {
      chunkId: 'chunk-ancient-1',
      documentId: 'doc-ancient-1',
      documentRevisionId: 'rev-ancient-1',
      title: 'Legacy Framework Architecture in Early 2026',
      content: 'Legacy framework achieved initial stable release with unified runtime support.',
      headingPath: ['Architecture', 'Release'],
      score: 0.92,
      publishedAt: new Date('2026-01-15T00:00:00.000Z'),
    };

    let receivedFilter: Record<string, unknown> | undefined;
    const searchService: SearchServicePort = {
      searchFts: async (params) => {
        receivedFilter = params.filter as Record<string, unknown> | undefined;
        return [olderHit];
      },
      searchExactVector: async () => [],
    };

    const chatPort = createDeterministicChatPort({
      response:
        'Legacy framework는 통합 런타임 지원과 함께 초기 안정화 릴리스를 달성했습니다 [C1].',
    });

    const service = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: 'Legacy framework의 초기 릴리스 내용',
      requestId: 'req_test_ancient_hit',
      // Note: timeRange is omitted
    });

    // Must be answered using the older hit without an implicit recent-date filter
    expect(response.status).toBe('answered');
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.documentRevisionId).toBe('rev-ancient-1');
    expect(response.citations[0]?.publishedAt).toBe('2026-01-15T00:00:00.000Z');

    // Search filter must NOT have publishedAfter or publishedBefore
    expect(receivedFilter).toBeDefined();
    expect(receivedFilter?.['status']).toBe('searchable');
    expect(receivedFilter?.['publishedAfter']).toBeUndefined();
    expect(receivedFilter?.['publishedBefore']).toBeUndefined();

    // resolvedTimeRange clearly represents unbounded/latest mode
    expect(response.resolvedTimeRange.from).toBe(UNBOUNDED_START);
    expect(response.resolvedTimeRange.to).toBe('2026-09-01T12:00:00.000Z');
    expect(response.resolvedTimeRange.timezone).toBe('UTC');

    // coverage reflects actual considered data freshness
    expect(response.coverage.dataFreshThrough).toBe('2026-01-15T00:00:00.000Z');
    expect(response.coverage.documentsConsidered).toBe(1);
    expect(response.coverage.sourcesUsed).toBe(1);
  });

  test('policy: explicit timeRange strictly excludes hits published outside the specified bounds', async () => {
    const olderHit: SearchHit = {
      chunkId: 'chunk-ancient-2',
      documentId: 'doc-ancient-2',
      documentRevisionId: 'rev-ancient-2',
      title: 'Legacy Framework Architecture in Early 2026',
      content: 'Early 2026 details.',
      headingPath: ['History'],
      score: 0.9,
      publishedAt: new Date('2026-01-15T00:00:00.000Z'),
    };

    const inRangeHit: SearchHit = {
      chunkId: 'chunk-inrange-1',
      documentId: 'doc-inrange-1',
      documentRevisionId: 'rev-inrange-1',
      title: 'Framework August 2026 Update',
      content: 'August 2026 introduces compiler optimizations.',
      headingPath: ['August', 'Optimizations'],
      score: 0.88,
      publishedAt: new Date('2026-08-10T00:00:00.000Z'),
    };

    // Search port returns both hits (simulating partial database filter or hybrid union)
    const searchService: SearchServicePort = {
      searchFts: async () => [olderHit, inRangeHit],
      searchExactVector: async () => [],
    };

    const chatPort = createDeterministicChatPort({
      response: '8월 업데이트에서 컴파일러 최적화가 도입되었습니다 [C1].',
    });

    const service = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    // Explicit timeRange: 2026-08-01 to 2026-08-31 strictly excludes 2026-01-15
    const response = await service.generateAnswer({
      question: '8월 업데이트 내용',
      requestId: 'req_test_strict_range',
      timeRange: {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-31T00:00:00.000Z',
      },
      timezone: 'Asia/Seoul',
    });

    expect(response.status).toBe('answered');
    expect(response.resolvedTimeRange.from).toBe('2026-08-01T00:00:00.000Z');
    expect(response.resolvedTimeRange.to).toBe('2026-08-31T00:00:00.000Z');
    expect(response.resolvedTimeRange.timezone).toBe('Asia/Seoul');

    // Only inRangeHit should be considered (documentsConsidered = 1)
    expect(response.coverage.documentsConsidered).toBe(1);
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.documentRevisionId).toBe('rev-inrange-1');
    expect(response.citations[0]?.publishedAt).toBe('2026-08-10T00:00:00.000Z');
  });

  test('policy: explicit timeRange returns insufficient_evidence when all hits are outside bounds', async () => {
    const olderHit: SearchHit = {
      chunkId: 'chunk-ancient-3',
      documentId: 'doc-ancient-3',
      documentRevisionId: 'rev-ancient-3',
      title: 'Legacy Framework in Early 2026',
      content: 'Early 2026 details only.',
      headingPath: ['History'],
      score: 0.9,
      publishedAt: new Date('2026-01-15T00:00:00.000Z'),
    };

    const searchService: SearchServicePort = {
      searchFts: async () => [olderHit],
      searchExactVector: async () => [],
    };

    const chatPort = createDeterministicChatPort();
    const service = createAnswerService({
      chatPort,
      searchService,
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: '2026년 8월 변경사항',
      requestId: 'req_test_strict_empty',
      timeRange: {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-31T00:00:00.000Z',
      },
    });

    // All hits were strictly outside explicit range -> insufficient_evidence
    expect(response.status).toBe('insufficient_evidence');
    expect(response.answer).toBeNull();
    expect(response.citations).toHaveLength(0);
    expect(response.coverage.documentsConsidered).toBe(0);
  });
});
