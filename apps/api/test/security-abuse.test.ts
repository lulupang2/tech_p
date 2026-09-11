import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createApp } from '../src/app.js';
import {
  ConcurrencyLimiter,
  DailyBudgetTracker,
  MemoryRateLimiter,
} from '../src/abuse-controls.js';
import {
  createDeterministicChatPort,
  type SearchHit,
  type SearchServicePort,
} from '@techpulse/domain';
import { createAnswerService } from '@techpulse/rag';
import { parseAnswerResponse, parseErrorEnvelope } from '@techpulse/contracts';

function createFakeSearchService(hits: readonly SearchHit[]): SearchServicePort {
  return {
    searchFts: async () => hits,
    searchExactVector: async () => hits,
  };
}

describe('SEC-001 Public API Abuse Controls & Threat Mitigations', () => {
  const sampleHits: SearchHit[] = [
    {
      chunkId: 'chunk-sec-1',
      documentId: 'doc-sec-1',
      documentRevisionId: 'rev-sec-1',
      title: 'Security Architecture',
      content: 'Signal Archive implements robust API abuse controls and security headers.',
      headingPath: ['Security', 'Architecture'],
      score: 1.0,
      publishedAt: new Date('2026-08-20T00:00:00.000Z'),
    },
  ];

  const chatPort = createDeterministicChatPort({
    response: 'Signal Archive는 보안 헤더와 레이트 리밋을 적용합니다 [C1].',
  });
  const searchService = createFakeSearchService(sampleHits);
  const answerService = createAnswerService({ chatPort, searchService });

  test('enforces mandatory security headers on all responses (THR-006 & SECURITY.md §6)', async () => {
    const app = createApp({ answerService });

    const res = await app.handle(new Request('http://localhost/health/live'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(
      res.headers.get('content-security-policy'),
      "default-src 'none'; frame-ancestors 'none'",
    );
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  });

  test('enforces CORS allowlist and handles OPTIONS preflight (SEC-001)', async () => {
    const app = createApp({
      answerService,
      corsAllowedOrigins: ['http://localhost:5173', 'https://techpulse.dev'],
    });

    // 1. Allowed origin in normal request
    const allowedRes = await app.handle(
      new Request('http://localhost/api/v1/sources', {
        headers: { origin: 'https://techpulse.dev' },
      }),
    );
    assert.equal(allowedRes.headers.get('access-control-allow-origin'), 'https://techpulse.dev');
    assert.equal(allowedRes.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');

    // 2. Unallowed origin -> no Access-Control-Allow-Origin header set
    const forbiddenRes = await app.handle(
      new Request('http://localhost/api/v1/sources', {
        headers: { origin: 'https://evil-attacker.com' },
      }),
    );
    assert.equal(forbiddenRes.headers.get('access-control-allow-origin'), null);

    // 3. OPTIONS Preflight request
    const preflightRes = await app.handle(
      new Request('http://localhost/api/v1/answers', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
        },
      }),
    );
    assert.equal(preflightRes.status, 204);
    assert.equal(preflightRes.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  test('enforces rate limiting and returns 429 RATE_LIMITED when threshold is exceeded (SEC-001)', async () => {
    const rateLimiter = new MemoryRateLimiter({ maxRequests: 3, windowMs: 60000 });
    const app = createApp({ answerService, rateLimiter });

    const clientHeaders = { 'x-forwarded-for': '198.51.100.42' };

    // Request 1, 2, 3 -> OK
    for (let i = 0; i < 3; i++) {
      const res = await app.handle(
        new Request('http://localhost/api/v1/sources', { headers: clientHeaders }),
      );
      assert.equal(res.status, 200);
      assert(res.headers.get('ratelimit-remaining') !== null);
    }

    // Request 4 -> 429 Too Many Requests
    const rateLimitedRes = await app.handle(
      new Request('http://localhost/api/v1/sources', { headers: clientHeaders }),
    );
    assert.equal(rateLimitedRes.status, 429);
    assert(rateLimitedRes.headers.get('retry-after') !== null);
    assert.equal(rateLimitedRes.headers.get('ratelimit-remaining'), '0');

    const body = (await rateLimitedRes.json()) as Record<string, unknown>;
    const envelope = parseErrorEnvelope(body);
    assert.equal(envelope.error.code, 'RATE_LIMITED');
    assert.equal(envelope.error.retryable, true);
  });

  test('enforces concurrency cap on answer generation (SEC-001)', async () => {
    const concurrencyLimiter = new ConcurrencyLimiter({ maxConcurrent: 1 });

    // Mock answer service with a controllable delay
    let resolvePending: (() => void) | null = null;
    const delayedAnswerService = {
      generateAnswer: async () => {
        await new Promise<void>((resolve) => {
          resolvePending = resolve;
        });
        return {
          requestId: 'req_1',
          answerId: 'ans_1',
          status: 'answered' as const,
          intent: 'tech_qa',
          resolvedTimeRange: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
          answer: 'Done [C1]',
          observations: [],
          citations: [],
          coverage: {
            dataFreshThrough: '2026-09-01T00:00:00.000Z',
            sourcesUsed: 1,
            documentsConsidered: 1,
            limitations: [],
          },
        };
      },
    };

    const app = createApp({ answerService: delayedAnswerService, concurrencyLimiter });

    // Launch first request (occupies the single slot)
    const req1Promise = app.handle(
      new Request('http://localhost/api/v1/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'First slow query' }),
      }),
    );

    // Launch second request immediately -> exceeds concurrency cap
    const req2Res = await app.handle(
      new Request('http://localhost/api/v1/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'Second query while busy' }),
      }),
    );

    assert.equal(req2Res.status, 429);
    const body2 = (await req2Res.json()) as Record<string, unknown>;
    const env2 = parseErrorEnvelope(body2);
    assert.equal(env2.error.code, 'RATE_LIMITED');
    assert(env2.error.message.includes('concurrent'));

    // Release first request
    if (resolvePending) (resolvePending as () => void)();
    const req1Res = await req1Promise;
    assert.equal(req1Res.status, 200);
  });

  test('enforces daily provider budget limit on answers endpoint (SEC-001)', async () => {
    const budgetTracker = new DailyBudgetTracker({ maxDailyQueries: 2 });
    const app = createApp({ answerService, budgetTracker });

    const postAnswer = () =>
      app.handle(
        new Request('http://localhost/api/v1/answers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'Query within budget' }),
        }),
      );

    // Query 1 and 2 succeed with 200 and answered payload
    const res1 = await postAnswer();
    assert.equal(res1.status, 200);
    const body1 = (await res1.json()) as Record<string, unknown>;
    const parsed1 = parseAnswerResponse(body1);
    assert.equal(parsed1.status, 'answered');
    assert.ok(typeof parsed1.answer === 'string' && parsed1.answer.includes('[C1]'));

    const res2 = await postAnswer();
    assert.equal(res2.status, 200);
    const body2 = (await res2.json()) as Record<string, unknown>;
    const parsed2 = parseAnswerResponse(body2);
    assert.equal(parsed2.status, 'answered');
    assert.ok(typeof parsed2.answer === 'string' && parsed2.answer.includes('[C1]'));

    // Query 3 fails with daily budget exceeded (429 RATE_LIMITED)
    const res3 = await postAnswer();
    assert.equal(res3.status, 429);
    const body3 = (await res3.json()) as Record<string, unknown>;
    const env3 = parseErrorEnvelope(body3);
    assert.equal(env3.error.code, 'RATE_LIMITED');
    assert(env3.error.message.includes('budget'));
  });
  test('separates ops routes and requires authorization token (THR-008 & SECURITY.md §6)', async () => {
    const app = createApp({ answerService, opsApiKey: 'super-secret-ops-key-42' });

    // 1. Unauthenticated request to ops endpoint -> 401 UNAUTHENTICATED
    const unauthRes = await app.handle(new Request('http://localhost/api/v1/ops/status'));
    assert.equal(unauthRes.status, 401);
    const unauthEnv = parseErrorEnvelope(await unauthRes.json());
    assert.equal(unauthEnv.error.code, 'UNAUTHENTICATED');

    // 2. Wrong token -> 403 FORBIDDEN
    const forbiddenRes = await app.handle(
      new Request('http://localhost/api/v1/ops/status', {
        headers: { authorization: 'Bearer wrong-ops-key' },
      }),
    );
    assert.equal(forbiddenRes.status, 403);
    const forbiddenEnv = parseErrorEnvelope(await forbiddenRes.json());
    assert.equal(forbiddenEnv.error.code, 'FORBIDDEN');

    // 3. Valid ops token -> 200 OK
    const okRes = await app.handle(
      new Request('http://localhost/api/v1/ops/status', {
        headers: { authorization: 'Bearer super-secret-ops-key-42' },
      }),
    );
    assert.equal(okRes.status, 200);
    const okBody = (await okRes.json()) as Record<string, unknown>;
    assert.equal(okBody['status'], 'ok');
  });
});
