import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { render } from 'svelte/server';
import QuestionAnswer, {
  isUnboundedStart,
  buildAnswerRequestPayload,
} from '../src/lib/components/QuestionAnswer.svelte';
import { ApiClient } from '../src/lib/api-client.js';
import type { AnswerRequest, AnswerResponse } from '@techpulse/contracts';

describe('QuestionAnswer Component & QA Flow', () => {
  it('exports QuestionAnswer as a valid Svelte 5 component', () => {
    assert.ok(QuestionAnswer);
    assert.equal(typeof QuestionAnswer, 'function');
  });

  it('constructs well-formed AnswerRequest payload with omitted timeRange by default (latest unbounded)', async () => {
    let capturedRequest: AnswerRequest | null = null;
    const mockClient = new ApiClient({
      fetch: async (_url, init) => {
        capturedRequest = JSON.parse(String(init?.body));
        const res: AnswerResponse = {
          requestId: 'req_qa_1',
          answerId: 'ans_qa_1',
          status: 'answered',
          intent: 'compare_interest',
          resolvedTimeRange: {
            from: '2026-08-01T00:00:00Z',
            to: '2026-09-01T00:00:00Z',
            timezone: 'Asia/Seoul',
          },
          answer: 'Test answer text [C1].',
          observations: [],
          citations: [
            {
              id: 'C1',
              documentRevisionId: 'rev_1',
              title: 'Source Title',
              source: 'github_releases',
              url: 'https://example.com/release',
              publishedAt: '2026-08-15T00:00:00Z',
              excerpt: 'Verbatim excerpt',
              excerptIsVerbatim: true,
            },
          ],
          coverage: {
            dataFreshThrough: '2026-09-01T00:00:00Z',
            sourcesUsed: 1,
            documentsConsidered: 5,
            limitations: [],
          },
        };
        return new Response(JSON.stringify(res), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const response = await mockClient.createAnswer({
      question: '최근 한 달간 Bun과 Node.js 관심 비교',
      timezone: 'Asia/Seoul',
      language: 'ko',
    });
    const req = capturedRequest as AnswerRequest | null;
    assert.ok(req);
    assert.equal(req.question, '최근 한 달간 Bun과 Node.js 관심 비교');
    assert.equal(req.timezone, 'Asia/Seoul');
    assert.equal(req.language, 'ko');
    assert.equal(req.timeRange, undefined);
    assert.equal(response.status, 'answered');
    assert.equal(response.citations.length, 1);
    assert.ok(response.citations[0]);
    assert.equal(response.citations[0].url, 'https://example.com/release');
  });
  it('handles insufficient_evidence response with limitations and no fabricated answer', async () => {
    const mockClient = new ApiClient({
      fetch: async () => {
        const res: AnswerResponse = {
          requestId: 'req_qa_insufficient',
          answerId: 'ans_qa_insufficient',
          status: 'insufficient_evidence',
          intent: 'trend_summary',
          resolvedTimeRange: {
            from: '2026-08-01T00:00:00Z',
            to: '2026-09-01T00:00:00Z',
            timezone: 'UTC',
          },
          answer: null,
          observations: [],
          citations: [],
          coverage: {
            dataFreshThrough: '2026-09-01T00:00:00Z',
            sourcesUsed: 0,
            documentsConsidered: 0,
            limitations: ['요청 기간의 근거가 충분하지 않습니다.'],
          },
        };
        return new Response(JSON.stringify(res), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const response = await mockClient.createAnswer({
      question: 'Unknown exotic query',
    });

    assert.equal(response.status, 'insufficient_evidence');
    assert.equal(response.answer, null);
    assert.equal(response.citations.length, 0);
    assert.deepEqual(response.coverage.limitations, ['요청 기간의 근거가 충분하지 않습니다.']);
  });

  it('handles metric observations with discrete units without summing them', async () => {
    const mockClient = new ApiClient({
      fetch: async () => {
        const res: AnswerResponse = {
          requestId: 'req_qa_obs',
          answerId: 'ans_qa_obs',
          status: 'answered',
          intent: 'compare_interest',
          resolvedTimeRange: {
            from: '2026-08-01T00:00:00Z',
            to: '2026-09-01T00:00:00Z',
            timezone: 'UTC',
          },
          answer: 'Detailed metric observation response [C1].',
          observations: [
            {
              subject: 'Bun',
              metric: 'community_mentions',
              value: 42,
              unit: 'deduplicated_documents',
              change: 12.5,
            },
            {
              subject: 'Node.js',
              metric: 'issue_discussion',
              value: 156,
              unit: 'interactions',
              change: -4.2,
            },
          ],
          citations: [
            {
              id: 'C1',
              documentRevisionId: 'rev_obs_1',
              title: 'Release Tracker',
              source: 'github_releases',
              url: 'https://github.com/nodejs/node',
              publishedAt: '2026-08-20T00:00:00Z',
              excerpt: 'Node v22 updates',
              excerptIsVerbatim: true,
            },
          ],
          coverage: {
            dataFreshThrough: '2026-09-01T00:00:00Z',
            sourcesUsed: 2,
            documentsConsidered: 15,
            limitations: [],
          },
        };
        return new Response(JSON.stringify(res), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const response = await mockClient.createAnswer({ question: 'Compare Bun and Node metrics' });
    assert.equal(response.observations.length, 2);
    const obs0 = response.observations[0];
    const obs1 = response.observations[1];
    assert.ok(obs0);
    assert.ok(obs1);
    assert.equal(obs0.unit, 'deduplicated_documents');
    assert.equal(obs1.unit, 'interactions');
    // Verify different units are distinct
    assert.notEqual(obs0.unit, obs1.unit);
  });

  it('presents comparative metrics for multiple subjects with metric-specific units and periods (WEB-003)', async () => {
    const mockClient = new ApiClient({
      fetch: async () => {
        const res: AnswerResponse = {
          requestId: 'req_comp_123',
          answerId: 'ans_comp_123',
          status: 'answered',
          intent: 'compare_interest',
          resolvedTimeRange: {
            from: '2026-08-01T00:00:00.000Z',
            to: '2026-09-01T00:00:00.000Z',
            timezone: 'Asia/Seoul',
          },
          answer:
            'Bun showed significant release momentum [C1] while Node.js maintained steady mentions [C2].',
          observations: [
            {
              subject: 'Bun',
              metric: 'community_mentions',
              value: 1420,
              unit: 'deduplicated_documents',
              change: 35.5,
            },
            {
              subject: 'Node.js',
              metric: 'community_mentions',
              value: 3890,
              unit: 'deduplicated_documents',
              change: -4.2,
            },
            {
              subject: 'Bun',
              metric: 'package_downloads',
              value: 850000,
              unit: 'downloads',
              change: 12.0,
            },
            {
              subject: 'Node.js',
              metric: 'package_downloads',
              value: 45000000,
              unit: 'downloads',
              change: 0.0,
            },
            {
              subject: 'Bun',
              metric: 'repo_attention',
              value: 72000,
              unit: 'stars',
              change: null,
            },
          ],
          citations: [
            {
              id: 'C1',
              documentRevisionId: 'rev_bun_rel',
              title: 'Bun v1.1.27 Release Notes',
              source: 'github_releases',
              url: 'https://github.com/oven-sh/bun/releases/tag/bun-v1.1.27',
              publishedAt: '2026-08-20T10:00:00.000Z',
              excerpt: 'Bun v1.1.27 includes performance improvements and bug fixes.',
              excerptIsVerbatim: true,
            },
            {
              id: 'C2',
              documentRevisionId: 'rev_node_rel',
              title: 'Node.js v22.8.0 Release',
              source: 'github_releases',
              url: 'https://github.com/nodejs/node/releases/tag/v22.8.0',
              publishedAt: '2026-08-25T14:00:00.000Z',
              excerpt: 'Node.js 22.8.0 brings experimental type stripping support.',
              excerptIsVerbatim: true,
            },
          ],
          coverage: {
            dataFreshThrough: '2026-09-01T00:15:00.000Z',
            sourcesUsed: 3,
            documentsConsidered: 48,
            limitations: [
              'npm download metrics historical data is clamped to available 18-month range.',
              'GitHub repository stars metric does not include pre-collection baseline.',
            ],
          },
        };
        return new Response(JSON.stringify(res), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const res = await mockClient.createAnswer({
      question: '최근 한 달간 Bun과 Node.js에 대한 관심 변화를 비교해줘.',
    });

    assert.equal(res.status, 'answered');
    assert.equal(res.intent, 'compare_interest');
    assert.equal(res.resolvedTimeRange.from, '2026-08-01T00:00:00.000Z');
    assert.equal(res.resolvedTimeRange.to, '2026-09-01T00:00:00.000Z');
    assert.equal(res.observations.length, 5);

    // Verify individual observations preserve discrete units without composite score
    const mentionObs = res.observations.filter((o) => o.metric === 'community_mentions');
    assert.equal(mentionObs.length, 2);
    assert.equal(mentionObs[0]?.unit, 'deduplicated_documents');
    assert.equal(mentionObs[1]?.unit, 'deduplicated_documents');
    assert.equal(mentionObs[0]?.change, 35.5);
    assert.equal(mentionObs[1]?.change, -4.2);

    const downloadObs = res.observations.filter((o) => o.metric === 'package_downloads');
    assert.equal(downloadObs.length, 2);
    assert.equal(downloadObs[0]?.unit, 'downloads');
    assert.equal(downloadObs[1]?.unit, 'downloads');
    assert.equal(downloadObs[0]?.change, 12.0);
    assert.equal(downloadObs[1]?.change, 0.0);

    const starObs = res.observations.filter((o) => o.metric === 'repo_attention');
    assert.equal(starObs.length, 1);
    assert.equal(starObs[0]?.unit, 'stars');
    assert.equal(starObs[0]?.change, null); // Baseline comparison N/A

    // Verify units are completely separate and not mixed
    const uniqueUnits = new Set(res.observations.map((o) => o.unit));
    assert.deepEqual(
      Array.from(uniqueUnits).sort(),
      ['deduplicated_documents', 'downloads', 'stars'].sort(),
    );

    // Verify freshness and limitations warning propagation
    assert.equal(res.coverage.dataFreshThrough, '2026-09-01T00:15:00.000Z');
    assert.equal(res.coverage.sourcesUsed, 3);
    assert.equal(res.coverage.documentsConsidered, 48);
    assert.equal(res.coverage.limitations.length, 2);
    assert.ok(res.coverage.limitations[0]?.includes('npm download'));
    assert.ok(res.coverage.limitations[1]?.includes('pre-collection baseline'));
  });

  it('propagates stale and partial source coverage warnings consistent with API contract (WEB-003)', async () => {
    const mockClient = new ApiClient({
      fetch: async () => {
        const res: AnswerResponse = {
          requestId: 'req_stale_warning',
          answerId: 'ans_stale_warning',
          status: 'answered',
          intent: 'trend_summary',
          resolvedTimeRange: {
            from: '2026-08-20T00:00:00.000Z',
            to: '2026-08-27T00:00:00.000Z',
            timezone: 'UTC',
          },
          answer: 'Summary with partial source coverage notice [C1].',
          observations: [
            {
              subject: 'Rust',
              metric: 'release_activity',
              value: 3,
              unit: 'releases',
              change: 0,
            },
          ],
          citations: [
            {
              id: 'C1',
              documentRevisionId: 'rev_rust_1',
              title: 'Rust 1.81.0 Pre-release',
              source: 'github_releases',
              url: 'https://github.com/rust-lang/rust/releases',
              publishedAt: '2026-08-22T00:00:00.000Z',
              excerpt: 'Rust release announcement.',
              excerptIsVerbatim: true,
            },
          ],
          coverage: {
            dataFreshThrough: '2026-08-25T12:00:00.000Z',
            sourcesUsed: 1,
            documentsConsidered: 5,
            limitations: [
              'users_rust_lang source is currently stale (last collected 48 hours ago).',
              'npm download data was unavailable for 2 days in the requested window.',
            ],
          },
        };
        return new Response(JSON.stringify(res), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const res = await mockClient.createAnswer({ question: 'Rust 릴리스 현황' });
    assert.equal(res.status, 'answered');
    assert.equal(res.coverage.sourcesUsed, 1);
    assert.equal(res.coverage.limitations.length, 2);
    assert.ok(res.coverage.limitations[0]?.includes('stale'));
    assert.ok(res.coverage.limitations[1]?.includes('unavailable'));
  });

  describe('Date filter request payload construction & unbounded default policy', () => {
    const fixedNow = new Date('2026-09-03T12:00:00.000Z');

    it('omits timeRange in payload when timePreset is auto (no date filter / latest data)', () => {
      const payload = buildAnswerRequestPayload({
        question: 'Bun과 Node.js 비교',
        timePreset: 'auto',
        timezone: 'Asia/Seoul',
        language: 'ko',
        now: () => fixedNow,
      });

      assert.equal(payload.question, 'Bun과 Node.js 비교');
      assert.equal(payload.timezone, 'Asia/Seoul');
      assert.equal(payload.language, 'ko');
      assert.equal(payload.timeRange, undefined);
      assert.equal('timeRange' in payload, false);
    });

    it('constructs explicit rolling 30d timeRange when 30d preset is chosen', () => {
      const payload = buildAnswerRequestPayload({
        question: '최근 30일간 릴리스 동향',
        timePreset: '30d',
        now: () => fixedNow,
      });

      assert.ok(payload.timeRange);
      assert.equal(payload.timeRange.to, '2026-09-03T12:00:00.000Z');
      assert.equal(payload.timeRange.from, '2026-08-04T12:00:00.000Z');
    });

    it('constructs explicit rolling 7d timeRange when 7d preset is chosen', () => {
      const payload = buildAnswerRequestPayload({
        question: '최근 7일간 릴리스 동향',
        timePreset: '7d',
        now: () => fixedNow,
      });

      assert.ok(payload.timeRange);
      assert.equal(payload.timeRange.to, '2026-09-03T12:00:00.000Z');
      assert.equal(payload.timeRange.from, '2026-08-27T12:00:00.000Z');
    });

    it('constructs explicit custom timeRange when valid custom dates are provided', () => {
      const payload = buildAnswerRequestPayload({
        question: '직접 지정 기간',
        timePreset: 'custom',
        customFrom: '2026-06-01T00:00:00.000Z',
        customTo: '2026-07-01T00:00:00.000Z',
      });

      assert.ok(payload.timeRange);
      assert.equal(payload.timeRange.from, '2026-06-01T00:00:00.000Z');
      assert.equal(payload.timeRange.to, '2026-07-01T00:00:00.000Z');
    });

    it('rejects invalid custom dates where to <= from or missing dates', () => {
      assert.throws(
        () =>
          buildAnswerRequestPayload({
            question: '역전된 기간',
            timePreset: 'custom',
            customFrom: '2026-08-01T00:00:00.000Z',
            customTo: '2026-07-01T00:00:00.000Z',
          }),
        /End date \(to\) must be after start date \(from\)/,
      );

      assert.throws(
        () =>
          buildAnswerRequestPayload({
            question: '누락된 기간',
            timePreset: 'custom',
            customFrom: '',
            customTo: '2026-07-01T00:00:00.000Z',
          }),
        /Please specify both start/,
      );
    });

    it('isUnboundedStart helper identifies UNBOUNDED_START (1970 epoch) vs bounded dates', () => {
      assert.equal(isUnboundedStart('1970-01-01T00:00:00.000Z'), true);
      assert.equal(isUnboundedStart('1970-01-01T00:00:00Z'), true);
      assert.equal(isUnboundedStart('2026-08-01T00:00:00.000Z'), false);
      assert.equal(isUnboundedStart(undefined), false);
      assert.equal(isUnboundedStart(null), false);
    });
  });

  describe('Rendered UI state for date filter & response labeling', () => {
    const dummyClient = new ApiClient({ fetch: async () => new Response('{}') });

    it('renders time range dropdown with default no-filter / latest data label while preserving explicit 30d option', () => {
      const { html } = render(QuestionAnswer, {
        props: { client: dummyClient },
      });

      // Must present default as '기간 필터 없음 / 최신 데이터'
      assert.ok(html.includes('기본값 (기간 필터 없음 / 최신 데이터)'));
      // Must NOT present the old misleading '기본값 (최근 30일)'
      assert.equal(html.includes('기본값 (최근 30일)'), false);
      // Must preserve the explicit '최근 30일' option
      assert.ok(html.includes('최근 30일'));
      assert.ok(html.includes('value="30d"'));
      assert.ok(html.includes('최근 7일'));
      assert.ok(html.includes('직접 기간 설정'));
    });

    it('renders response with clear latest/unbounded labeling when resolvedTimeRange is unbounded', () => {
      const unboundedResponse: AnswerResponse = {
        requestId: 'req_unbounded_render',
        answerId: 'ans_unbounded_render',
        status: 'answered',
        intent: 'compare_interest',
        resolvedTimeRange: {
          from: '1970-01-01T00:00:00.000Z',
          to: '2026-09-03T12:00:00.000Z',
          timezone: 'Asia/Seoul',
        },
        answer: 'Unbounded latest answer text [C1].',
        observations: [
          {
            subject: 'Bun',
            metric: 'community_mentions',
            value: 99,
            unit: 'count',
            change: null,
          },
        ],
        citations: [
          {
            id: 'C1',
            documentRevisionId: 'rev_1',
            title: 'Doc Title',
            source: 'github_releases',
            url: 'https://example.com',
            publishedAt: '2026-08-10T00:00:00.000Z',
            excerpt: 'Excerpt',
            excerptIsVerbatim: true,
          },
        ],
        coverage: {
          dataFreshThrough: '2026-09-03T12:00:00.000Z',
          sourcesUsed: 1,
          documentsConsidered: 1,
          limitations: [],
        },
      };

      const { html } = render(QuestionAnswer, {
        props: {
          client: dummyClient,
          initialResponse: unboundedResponse,
        },
      });

      // Must render clear unbounded / latest labeling
      assert.ok(html.includes('unbounded-tag'));
      assert.ok(html.includes('전체 기간 (최신 데이터)'));
      // Must NOT display raw 1970 epoch date string to the user
      assert.equal(html.includes('1970-01-01 00:00:00 UTC'), false);
      // Must display the end date and timezone
      assert.ok(html.includes('2026-09-03 12:00:00 UTC'));
      assert.ok(html.includes('Asia/Seoul'));
    });

    it('renders response with explicit date range when resolvedTimeRange has bounded dates', () => {
      const boundedResponse: AnswerResponse = {
        requestId: 'req_bounded_render',
        answerId: 'ans_bounded_render',
        status: 'answered',
        intent: 'trend_summary',
        resolvedTimeRange: {
          from: '2026-08-01T00:00:00.000Z',
          to: '2026-09-01T00:00:00.000Z',
          timezone: 'UTC',
        },
        answer: 'Bounded answer text [C1].',
        observations: [],
        citations: [],
        coverage: {
          dataFreshThrough: '2026-09-01T00:00:00.000Z',
          sourcesUsed: 0,
          documentsConsidered: 0,
          limitations: [],
        },
      };

      const { html } = render(QuestionAnswer, {
        props: {
          client: dummyClient,
          initialResponse: boundedResponse,
        },
      });

      // Bounded dates should be rendered directly
      assert.ok(html.includes('2026-08-01 00:00:00 UTC'));
      assert.ok(html.includes('2026-09-01 00:00:00 UTC'));
      // Must NOT render unbounded-tag for bounded range
      assert.equal(html.includes('unbounded-tag'), false);
      assert.equal(html.includes('전체 기간 (최신 데이터)'), false);
    });
  });
});
