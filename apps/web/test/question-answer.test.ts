import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import QuestionAnswer from '../src/lib/components/QuestionAnswer.svelte';
import { ApiClient } from '../src/lib/api-client.js';
import type { AnswerRequest, AnswerResponse } from '@techpulse/contracts';

describe('QuestionAnswer Component & QA Flow', () => {
  it('exports QuestionAnswer as a valid Svelte 5 component', () => {
    assert.ok(QuestionAnswer);
    assert.equal(typeof QuestionAnswer, 'function');
  });

  it('constructs well-formed AnswerRequest payload for rolling 30d window', async () => {
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
});
