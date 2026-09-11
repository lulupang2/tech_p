import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { fetchLiveTechEvidence } from '../src/live-search.js';
import type {
  AcquisitionRequest,
  AcquisitionResult,
  BoundedAcquisitionPort,
  SearchHit,
  SearchServicePort,
} from '@techpulse/domain';

describe('fetchLiveTechEvidence (Bounded Acquisition)', () => {
  const fixedNow = new Date('2026-09-01T12:00:00.000Z');
  const nowFn = () => fixedNow;

  test('returns SearchHit array from lexical re-search after successful bounded acquisition', async () => {
    let capturedRequest: AcquisitionRequest | undefined;

    const fakeAcquisitionPort: BoundedAcquisitionPort = {
      acquire: async (req) => {
        capturedRequest = req;
        const result: AcquisitionResult = {
          acquired: 2,
          searches: 1,
          fetches: 2,
          httpAttempts: 3,
          bytes: 15420,
          reason: null,
        };
        return result;
      },
    };

    const reSearchHits: SearchHit[] = [
      {
        chunkId: 'chunk-acq-1',
        documentId: 'doc-acq-1',
        documentRevisionId: 'rev-acq-1',
        title: 'Next.js 15 Release Update',
        content: 'Next.js 15 introduces React 19 support and Turbopack for dev.',
        headingPath: ['npm_registry'],
        score: 0.95,
        publishedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    ];

    let reSearchCalls = 0;
    const fakeSearchService: SearchServicePort = {
      searchFts: async () => {
        reSearchCalls += 1;
        return reSearchHits;
      },
      searchExactVector: async () => [],
    };

    const hits = await fetchLiveTechEvidence('Next.js 15 릴리스 동향은 어때?', {
      acquisitionPort: fakeAcquisitionPort,
      searchService: fakeSearchService,
      now: nowFn,
      timeoutMs: 3500,
    });

    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.documentRevisionId, 'rev-acq-1');
    assert.equal(hits[0]?.title, 'Next.js 15 Release Update');
    assert.equal(reSearchCalls, 1);

    // Verify bounded acquisition request limits
    assert.ok(capturedRequest);
    assert.equal(capturedRequest.query, 'Next.js 15 릴리스 동향은 어때?');
    assert.equal(capturedRequest.limits.maxSearches, 2);
    assert.equal(capturedRequest.limits.maxFetches, 3);
    assert.equal(capturedRequest.limits.maxHttpAttempts, 8);
    assert.ok(capturedRequest.limits.deadline.getTime() <= fixedNow.getTime() + 3500);
    assert.ok(capturedRequest.signal instanceof AbortSignal);
  });

  test('returns empty array when acquisitionPort is omitted', async () => {
    const hits = await fetchLiveTechEvidence('Next.js 15 릴리스 동향', {});
    assert.deepEqual(hits, []);
  });

  test('safely returns empty array if acquisition fails, times out, or throws error (rights/SSRF/abort)', async () => {
    const failingAcquisitionPort: BoundedAcquisitionPort = {
      acquire: async () => {
        throw new Error('SSRF attempt blocked: private IP target forbidden');
      },
    };

    const hits = await fetchLiveTechEvidence('어떤 질문', {
      acquisitionPort: failingAcquisitionPort,
      now: nowFn,
    });
    assert.deepEqual(hits, []);
  });

  test('returns empty array if acquisition acquires 0 documents', async () => {
    const emptyAcquisitionPort: BoundedAcquisitionPort = {
      acquire: async () => ({
        acquired: 0,
        searches: 1,
        fetches: 0,
        httpAttempts: 1,
        bytes: 200,
        reason: 'no_matching_source_candidates',
      }),
    };

    let reSearchCalls = 0;
    const fakeSearchService: SearchServicePort = {
      searchFts: async () => {
        reSearchCalls += 1;
        return [];
      },
      searchExactVector: async () => [],
    };

    const hits = await fetchLiveTechEvidence('희귀 패키지 질문', {
      acquisitionPort: emptyAcquisitionPort,
      searchService: fakeSearchService,
      now: nowFn,
    });

    assert.deepEqual(hits, []);
    assert.equal(reSearchCalls, 0);
  });
});
