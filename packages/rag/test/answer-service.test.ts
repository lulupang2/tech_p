/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, expect, test } from 'vitest';
import {
  AiProviderError,
  AiTimeoutError,
  createDeterministicChatPort,
  createDeterministicEmbeddingPort,
  type ChatPort,
  type AcquisitionLimits,
  type AcquisitionRequest,
  type AcquisitionResult,
  type BoundedAcquisitionPort,
  type CoveragePort,
  type CoverageReport,
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

  test('uses only the newest revision when the question explicitly asks for the latest release', async () => {
    const seenPrompts: string[] = [];
    const service = createAnswerService({
      searchService: createFakeSearchService([
        {
          chunkId: 'old',
          documentId: 'doc-old',
          documentRevisionId: 'rev-old',
          title: 'v1.0.0',
          content: 'Old release details.',
          headingPath: [],
          score: 1,
          canonicalUrl: 'https://github.com/nodejs/node/releases/tag/v1.0.0',
          publishedAt: new Date('2026-08-01T00:00:00Z'),
        },
        {
          chunkId: 'irrelevant-newer',
          documentId: 'doc-irrelevant',
          documentRevisionId: 'rev-irrelevant',
          title: 'v9.0.0',
          content: 'A newer release from another repository.',
          headingPath: [],
          score: 0.8,
          canonicalUrl: 'https://github.com/microsoft/playwright/releases/tag/v9.0.0',
          publishedAt: new Date('2026-09-10T00:00:00Z'),
        },
        {
          chunkId: 'new',
          documentId: 'doc-new',
          documentRevisionId: 'rev-new',
          title: 'v2.0.0',
          content: 'Newest release details.',
          headingPath: [],
          score: 0.5,
          canonicalUrl: 'https://github.com/nodejs/node/releases/tag/v2.0.0',
          publishedAt: new Date('2026-09-01T00:00:00Z'),
        },
      ]),
      chatPort: {
        async complete(request) {
          seenPrompts.push(request.messages.find((message) => message.role === 'user')!.content);
          return {
            content: '{"answer":"최신 변경입니다 [C1]."}',
            metadata: {
              model: 'fixture',
              latencyMs: 0,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          };
        },
      },
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: 'nodejs/node 최신 릴리스 변경점',
      requestId: 'latest',
    });
    expect(response.citations.map((citation) => citation.documentRevisionId)).toEqual(['rev-new']);
    expect(seenPrompts[0]).toContain('과거 릴리스를 섞지 마세요');
    expect(seenPrompts[0]).not.toContain('Old release details.');
    expect(seenPrompts[0]).not.toContain('another repository');
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

  test('makes the allowed citation keys explicit in the model request', async () => {
    const sampleHits: SearchHit[] = [
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        documentRevisionId: 'rev-1',
        title: 'Release Notes',
        content: 'A grounded release change.',
        headingPath: [],
        score: 1,
        publishedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    ];
    let userMessage = '';
    const chatPort = {
      async complete(request: Parameters<ChatPort['complete']>[0]) {
        userMessage = request.messages.find((message) => message.role === 'user')?.content ?? '';
        return {
          content: '{"answer":"변경 내용입니다 [C1]."}',
          metadata: {
            model: 'fixture',
            latencyMs: 0,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        };
      },
    } satisfies ChatPort;
    const service = createAnswerService({
      chatPort,
      searchService: createFakeSearchService(sampleHits),
      now: nowFn,
    });
    const response = await service.generateAnswer({
      question: '최신 릴리스 변경점',
      requestId: 'req_citation_prompt',
    });
    expect(response.status).toBe('answered');
    expect(userMessage).toContain('<available_citations>[C1]</available_citations>');
    expect(userMessage).toContain('인용 없는 자연어 답변은 허용되지 않습니다.');
    expect(userMessage).toContain('약 180 토큰 이내');
    expect(userMessage).toContain('첫 번째 사실 문장부터 즉시 [C#] 인용');
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
    const makeHit = (id: string, title: string): SearchHit => ({
      chunkId: `chunk-${id}`,
      documentId: `doc-${id}`,
      documentRevisionId: `rev-${id}`,
      title,
      content: `${title} hybrid search evidence.`,
      headingPath: [],
      score: 0.88,
      publishedAt: new Date('2026-08-25T00:00:00.000Z'),
    });
    const lexicalOnly = makeHit('lexical', 'Lexical only');
    const vectorOnly = makeHit('vector', 'Vector only');
    const shared = makeHit('shared', 'Shared RRF winner');

    const chatPort = createDeterministicChatPort({
      response: '하이브리드 검색 결과 답변 [C1]',
    });
    const embeddingPort = createDeterministicEmbeddingPort({ dimensions: 8 });
    let vectorRequest: Parameters<SearchServicePort['searchExactVector']>[0] | undefined;
    let ftsRequest: Parameters<SearchServicePort['searchFts']>[0] | undefined;
    const searchService: SearchServicePort = {
      searchFts: async (params) => {
        ftsRequest = params;
        return [lexicalOnly, shared];
      },
      searchExactVector: async (params) => {
        vectorRequest = params;
        return [vectorOnly, shared];
      },
    };

    const service = createAnswerService({
      chatPort,
      searchService,
      embeddingPort,
      embeddingProvider: 'approved-provider',
      embeddingProfileHash: 'approved-profile-hash',
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: '하이브리드 검색 테스트',
      requestId: 'req_hybrid',
    });

    expect(response.status).toBe('answered');
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.documentRevisionId).toBe('rev-shared');
    expect(embeddingPort.calls).toHaveLength(1);
    expect(ftsRequest?.limit).toBe(20);
    expect(vectorRequest).toMatchObject({
      provider: 'approved-provider',
      profileHash: 'approved-profile-hash',
      dimensions: 8,
      limit: 20,
      filter: { requireApprovedRights: true },
    });
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
          requireApprovedRights: params.filter?.requireApprovedRights,
          topicSlugs: params.filter?.topicSlugs,
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
      expect(snap['requireApprovedRights']).toBe(true);
      expect(snap['topicSlugs']).toEqual(['playwright']);
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

  test('COV-007 local-first: sufficient local evidence causes zero acquisition calls', async () => {
    const localHit: SearchHit = {
      chunkId: 'chunk-local-1',
      documentId: 'doc-local-1',
      documentRevisionId: 'rev-local-1',
      title: 'TypeScript 5.6 Features',
      content: 'TypeScript 5.6 introduces iterator helper types and regex syntax checks.',
      headingPath: ['github_releases'],
      score: 0.95,
      publishedAt: new Date('2026-08-25T00:00:00.000Z'),
    };

    let acquisitionCalls = 0;
    const fakeAcquisitionPort: BoundedAcquisitionPort = {
      acquire: async () => {
        acquisitionCalls += 1;
        return { acquired: 1, searches: 1, fetches: 1, httpAttempts: 1, bytes: 500, reason: null };
      },
    };

    const searchService = createFakeSearchService([localHit]);
    const chatPort = createDeterministicChatPort({
      response: 'TypeScript 5.6은 iterator helper types를 지원합니다 [C1].',
    });

    const service = createAnswerService({
      chatPort,
      searchService,
      acquisitionPort: fakeAcquisitionPort,
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: 'TypeScript 5.6의 새로운 기능은?',
      requestId: 'req_local_first_test',
    });

    expect(response.status).toBe('answered');
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.documentRevisionId).toBe('rev-local-1');
    // Zero external acquisition calls when local evidence is sufficient
    expect(acquisitionCalls).toBe(0);
  });

  test('COV-007 insufficient branch: invokes bounded acquisition with strict limits and performs exactly one re-search', async () => {
    let capturedRequest: AcquisitionRequest | undefined;
    let acquisitionCalls = 0;

    const fakeAcquisitionPort: BoundedAcquisitionPort = {
      acquire: async (req) => {
        acquisitionCalls += 1;
        capturedRequest = req;
        return {
          acquired: 2,
          searches: 1,
          fetches: 2,
          httpAttempts: 3,
          bytes: 12500,
          reason: null,
        };
      },
    };

    let ftsSearchCount = 0;
    const persistedAcquiredHit: SearchHit = {
      chunkId: 'chunk-persisted-1',
      documentId: 'https://github.com/astral-sh/uv/releases/tag/0.4.0',
      documentRevisionId: 'rev-uv-040',
      title: 'uv 0.4.0 Release',
      content: 'uv 0.4.0 adds cross-platform python build standalone management.',
      headingPath: ['github_releases'],
      score: 0.98,
      publishedAt: new Date('2026-08-28T00:00:00.000Z'),
    };

    const searchService: SearchServicePort = {
      searchFts: async () => {
        ftsSearchCount += 1;
        // First search returns empty (local miss), re-search after acquisition returns persisted doc
        if (ftsSearchCount === 1) {
          return [];
        }
        return [persistedAcquiredHit];
      },
      searchExactVector: async () => [],
    };

    const chatPort = createDeterministicChatPort({
      response: 'uv 0.4.0은 크로스 플랫폼 파이썬 빌드 관리를 추가했습니다 [C1].',
    });

    const service = createAnswerService({
      chatPort,
      searchService,
      acquisitionPort: fakeAcquisitionPort,
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: 'uv 패키지 매니저 0.4.0 릴리스 변경점',
      requestId: 'req_acq_branch_test',
      timeoutMs: 8000,
    });

    expect(response.status).toBe('answered');
    expect(acquisitionCalls).toBe(1);
    // Initial FTS + exactly one re-search = 2 FTS calls total
    expect(ftsSearchCount).toBe(2);

    // Verify acquisition bounds
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.query).toBe('uv 패키지 매니저 0.4.0 릴리스 변경점');
    expect(capturedRequest?.limits.maxSearches).toBe(2);
    expect(capturedRequest?.limits.maxFetches).toBe(3);
    expect(capturedRequest?.limits.maxHttpAttempts).toBe(8);
    expect(capturedRequest?.limits.deadline.getTime()).toBeLessThanOrEqual(
      fixedNow.getTime() + 8000,
    );
    expect(capturedRequest?.signal).toBeInstanceOf(AbortSignal);

    // Verify citation matches immutable persisted document
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.documentRevisionId).toBe('rev-uv-040');
    expect(response.citations[0]?.url).toBe('https://github.com/astral-sh/uv/releases/tag/0.4.0');
    expect(response.citations[0]?.excerptIsVerbatim).toBe(true);
  });

  test('COV-007 bounded acquisition: propagates rights restriction / SSRF block limitation without background continuation', async () => {
    const fakeAcquisitionPort: BoundedAcquisitionPort = {
      acquire: async () => {
        return {
          acquired: 0,
          searches: 1,
          fetches: 0,
          httpAttempts: 1,
          bytes: 100,
          reason: 'source_policy_forbidden: untrusted redirect to private IP blocked',
        };
      },
    };

    const searchService = createFakeSearchService([]);
    const chatPort = createDeterministicChatPort();

    const service = createAnswerService({
      chatPort,
      searchService,
      acquisitionPort: fakeAcquisitionPort,
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: '악성 사이트 정보 조회',
      requestId: 'req_ssrf_limitation_test',
    });

    expect(response.status).toBe('insufficient_evidence');
    expect(response.answer).toBeNull();
    expect(response.citations).toHaveLength(0);
    expect(response.coverage.limitations).toContain(
      'source_policy_forbidden: untrusted redirect to private IP blocked',
    );
  });

  test('COV-007 bounded acquisition: handles acquisition exception gracefully and returns insufficient_evidence with limitation note', async () => {
    const errorAcquisitionPort: BoundedAcquisitionPort = {
      acquire: async () => {
        throw new Error('Network timeout fetching candidate target from upstream');
      },
    };

    const searchService = createFakeSearchService([]);
    const chatPort = createDeterministicChatPort();

    const service = createAnswerService({
      chatPort,
      searchService,
      acquisitionPort: errorAcquisitionPort,
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: '알 수 없는 새 프로젝트 동향',
      requestId: 'req_acq_error_graceful',
    });

    expect(response.status).toBe('insufficient_evidence');
    expect(response.answer).toBeNull();
    expect(response.coverage.limitations.some((lim) => lim.includes('Network timeout'))).toBe(true);
  });

  test('RAG-005 retries validation at most once and accepts a corrected grounded answer', async () => {
    const hit: SearchHit = {
      chunkId: 'chunk-retry',
      documentId: 'doc-retry',
      documentRevisionId: 'rev-retry',
      title: 'Retry Evidence',
      content: 'Grounded retry evidence.',
      headingPath: ['github_releases'],
      score: 1,
      publishedAt: new Date('2026-09-01T00:00:00Z'),
    };
    let calls = 0;
    const chatPort = {
      complete: async () => {
        calls += 1;
        return {
          content: calls === 1 ? '잘못된 인용 [C99]' : '수정된 근거 답변입니다 [C1].',
          metadata: { model: 'test-model', totalTokens: 10 },
        };
      },
    };
    const service = createAnswerService({
      chatPort,
      searchService: createFakeSearchService([hit]),
      now: nowFn,
    });

    const response = await service.generateAnswer({
      question: 'Retry Evidence 변경점은?',
      requestId: 'req_validation_retry',
    });

    expect(calls).toBe(2);
    expect(response.status).toBe('answered');
    expect(response.citations[0]?.id).toBe('C1');
  });

  test('RAG-005 evaluation mode can disable validation regeneration entirely', async () => {
    const chat = createDeterministicChatPort({ response: 'fabricated [C99]' });
    const hit: SearchHit = {
      chunkId: 'chunk-eval-no-retry',
      documentId: 'doc-eval-no-retry',
      documentRevisionId: 'rev-eval-no-retry',
      title: 'Playwright Release',
      content: 'Playwright release evidence.',
      headingPath: ['github_releases'],
      score: 1,
      publishedAt: new Date('2026-09-01T00:00:00Z'),
    };
    const service = createAnswerService({
      chatPort: chat,
      searchService: createFakeSearchService([hit]),
      maxValidationRetries: 0,
    });

    const result = await service.generateAnswer({
      question: 'Playwright update',
      requestId: 'req_eval_no_retry',
    });

    expect(chat.calls).toHaveLength(1);
    expect(result.status).toBe('insufficient_evidence');
    expect(result.coverage.limitations.join(' ')).toContain('인용 검증 실패');
  });
});
