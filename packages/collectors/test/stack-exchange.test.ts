import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  StackExchangeCollector,
  detectTombstoneCandidates,
  decodeOpaqueCursor,
  validateUrl,
  SOURCE_POLICIES,
  type StackExchangeCursorPayload,
  type StackExchangeApiResponse,
} from '../src/index.js';

describe('COL-003 Stack Exchange Collector Adapter Contract', () => {
  // Mock fixtures for Stack Exchange API
  const mockOwner = {
    user_id: 123456,
    user_type: 'registered',
    display_name: 'John Developer',
    profile_image: 'https://www.gravatar.com/avatar/abc123def456',
    link: 'https://stackoverflow.com/users/123456/john-developer',
    reputation: 9999,
  };

  const sampleQuestionWithLicense = {
    question_id: 78901,
    link: 'https://stackoverflow.com/questions/78901/how-to-do-something-in-typescript',
    title: 'How to do something in TypeScript?',
    creation_date: 1725148800, // 2024-09-01T00:00:00.000Z
    last_activity_date: 1725152400, // 2024-09-01T01:00:00.000Z
    content_license: 'CC BY-SA 4.0',
    tags: ['typescript', 'node.js'],
    score: 42,
    view_count: 1024,
    answer_count: 3,
    is_answered: true,
    owner: mockOwner,
  };

  const sampleQuestionWithoutLicense = {
    question_id: 78902,
    link: 'https://stackoverflow.com/questions/78902/legacy-question-without-license',
    title: 'Legacy question without license',
    creation_date: 1262304000, // 2010-01-01T00:00:00.000Z
    last_activity_date: 1262307600,
    tags: ['javascript'],
    score: 10,
    view_count: 500,
    answer_count: 1,
    is_answered: true,
    owner: mockOwner,
    // content_license intentionally missing
  };

  const sampleClosedQuestion = {
    question_id: 78903,
    link: 'https://stackoverflow.com/questions/78903/closed-question',
    title: 'Closed question title',
    creation_date: 1725148800,
    content_license: 'CC BY-SA 4.0',
    tags: ['typescript'],
    closed_date: 1725156000,
    closed_reason: 'Duplicate',
    locked_date: 1725160000,
    owner: mockOwner,
  };

  describe('1. Query Parameters & Injected Fetch', () => {
    test('constructs valid API URL with site, tag, and pagination parameters', async () => {
      let requestedUrl = '';
      const customFetch: typeof fetch = async (input) => {
        requestedUrl = String(input);
        const body: StackExchangeApiResponse = {
          items: [sampleQuestionWithLicense],
          has_more: false,
          quota_remaining: 9990,
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const collector = new StackExchangeCollector({
        fetchFn: customFetch,
        defaultSite: 'stackoverflow',
        defaultTag: 'typescript',
        apiKey: 'test-api-key',
      });

      const result = await collector.collect({
        sourceKey: 'stack_exchange',
        cursor: null,
        timeWindow: {
          from: new Date('2024-09-01T00:00:00Z'),
          to: new Date('2024-09-02T00:00:00Z'),
        },
        limit: 25,
      });

      assert.equal(result.sourceKey, 'stack_exchange');
      assert.equal(result.items.length, 1);

      const parsedUrl = new URL(requestedUrl);
      assert.equal(parsedUrl.hostname, 'api.stackexchange.com');
      assert.equal(parsedUrl.pathname, '/2.3/questions');
      assert.equal(parsedUrl.searchParams.get('site'), 'stackoverflow');
      assert.equal(parsedUrl.searchParams.get('tagged'), 'typescript');
      assert.equal(parsedUrl.searchParams.get('pagesize'), '25');
      assert.equal(parsedUrl.searchParams.get('page'), '1');
      assert.equal(parsedUrl.searchParams.get('order'), 'desc');
      assert.equal(parsedUrl.searchParams.get('sort'), 'activity');
      assert.equal(parsedUrl.searchParams.get('fromdate'), '1725148800');
      assert.equal(parsedUrl.searchParams.get('todate'), '1725235200');
      assert.equal(parsedUrl.searchParams.get('key'), 'test-api-key');
    });
  });

  describe('2. Pagination & Cursor Navigation', () => {
    test('produces nextCursor when has_more is true and advances page number', async () => {
      let callCount = 0;
      const pagesRequested: number[] = [];

      const customFetch: typeof fetch = async (input) => {
        callCount++;
        const parsed = new URL(String(input));
        const page = Number(parsed.searchParams.get('page') ?? '1');
        pagesRequested.push(page);

        const hasMore = page < 2;
        const body: StackExchangeApiResponse = {
          items: [sampleQuestionWithLicense],
          has_more: hasMore,
          quota_remaining: 9900,
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const collector = new StackExchangeCollector({
        fetchFn: customFetch,
        defaultSite: 'stackoverflow',
        defaultTag: 'typescript',
      });

      // Page 1
      const res1 = await collector.collect({
        sourceKey: 'stack_exchange',
        cursor: null,
      });

      assert.equal(res1.hasMore, true);
      assert(res1.nextCursor !== null);

      const decodedCursor1 = decodeOpaqueCursor<StackExchangeCursorPayload>(res1.nextCursor);
      assert.equal(decodedCursor1?.page, 2);
      assert.equal(decodedCursor1?.site, 'stackoverflow');
      assert.equal(decodedCursor1?.tag, 'typescript');

      // Page 2 using cursor from Page 1
      const res2 = await collector.collect({
        sourceKey: 'stack_exchange',
        cursor: res1.nextCursor,
      });

      assert.equal(res2.hasMore, false);
      assert.equal(callCount, 2);
      assert.deepEqual(pagesRequested, [1, 2]);
    });
  });

  describe('3. Response Backoff Preservation', () => {
    test('preserves backoff seconds and timestamp in cursor when API returns backoff', async () => {
      const customFetch: typeof fetch = async () => {
        const body: StackExchangeApiResponse = {
          items: [sampleQuestionWithLicense],
          has_more: true,
          backoff: 15, // 15 seconds backoff requested by API
          quota_remaining: 8500,
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const collector = new StackExchangeCollector({ fetchFn: customFetch });
      const res = await collector.collect({
        sourceKey: 'stack_exchange',
        cursor: null,
      });

      assert(res.nextCursor !== null);
      const decoded = decodeOpaqueCursor<StackExchangeCursorPayload>(res.nextCursor);
      assert.equal(decoded?.backoffSeconds, 15);
      assert(typeof decoded?.backoffUntil === 'number');
      assert.equal(decoded?.quotaRemaining, 8500);
    });

    test('preserves backoff in next cursor even when has_more is false', async () => {
      const customFetch: typeof fetch = async () => {
        const body: StackExchangeApiResponse = {
          items: [sampleQuestionWithLicense],
          has_more: false,
          backoff: 30,
          quota_remaining: 100,
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const collector = new StackExchangeCollector({ fetchFn: customFetch });
      const res = await collector.collect({
        sourceKey: 'stack_exchange',
        cursor: null,
      });

      assert.equal(res.hasMore, false);
      assert(res.nextCursor !== null);
      const decoded = decodeOpaqueCursor<StackExchangeCursorPayload>(res.nextCursor);
      assert.equal(decoded?.backoffSeconds, 30);
    });
  });

  describe('4. PII Redaction: Owner Stripping (SECURITY.md §8)', () => {
    test('completely removes owner object from raw payload before persistence', async () => {
      const customFetch: typeof fetch = async () => {
        const body: StackExchangeApiResponse = {
          items: [sampleQuestionWithLicense],
          has_more: false,
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const collector = new StackExchangeCollector({ fetchFn: customFetch });
      const res = await collector.collect({
        sourceKey: 'stack_exchange',
        cursor: null,
      });

      assert.equal(res.items.length, 1);
      const item = res.items[0]!;

      // Owner object MUST be completely stripped from raw payload
      assert.equal(item.payload['owner'], undefined);
      assert.equal((item.payload as Record<string, unknown>)['owner.display_name'], undefined);

      // Question metadata fields must remain intact
      assert.equal(item.payload['question_id'], 78901);
      assert.equal(item.payload['title'], 'How to do something in TypeScript?');

      // SHA-256 hash computed over sanitized payload
      assert.equal(item.rawHash.length, 64);
    });
  });

  describe('5. Content License & Verbatim Only Metadata (SOURCE_CATALOG.md §3)', () => {
    test('preserves content_license when present and propagates verbatim_only as true', async () => {
      const customFetch: typeof fetch = async () => {
        const body: StackExchangeApiResponse = {
          items: [sampleQuestionWithLicense],
          has_more: false,
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const collector = new StackExchangeCollector({ fetchFn: customFetch });
      const res = await collector.collect({
        sourceKey: 'stack_exchange',
        cursor: null,
      });

      const item = res.items[0]!;
      assert.equal(item.externalId, 'stackoverflow:78901');
      assert.equal(item.metadata?.['content_license'], 'CC BY-SA 4.0');
      assert.equal(item.metadata?.['verbatim_only'], true);
      assert.equal(
        item.metadata?.['canonical_url'],
        'https://stackoverflow.com/questions/78901/how-to-do-something-in-typescript',
      );
      assert.equal(item.metadata?.['site'], 'stackoverflow');
      assert.deepEqual(item.metadata?.['tags'], ['typescript', 'node.js']);
      assert.equal(item.publishedAt?.toISOString(), '2024-09-01T00:00:00.000Z');
    });

    test('sets content_license to null in metadata when missing from API item', async () => {
      const customFetch: typeof fetch = async () => {
        const body: StackExchangeApiResponse = {
          items: [sampleQuestionWithoutLicense],
          has_more: false,
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const collector = new StackExchangeCollector({ fetchFn: customFetch });
      const res = await collector.collect({
        sourceKey: 'stack_exchange',
        cursor: null,
      });

      const item = res.items[0]!;
      assert.equal(item.externalId, 'stackoverflow:78902');
      assert.strictEqual(item.metadata?.['content_license'], null);
      assert.equal(item.metadata?.['verbatim_only'], true);
      assert.equal(item.publishedAt?.toISOString(), '2010-01-01T00:00:00.000Z');
    });
  });

  describe('6. Deletion vs Error Handling (DATA_PIPELINE.md §9 & SOURCE_CATALOG.md §3)', () => {
    test('throws error on HTTP 429 Rate Limit and NEVER marks items as deleted', async () => {
      const customFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ error_message: 'Too Many Requests' }), {
          status: 429,
          statusText: 'Too Many Requests',
        });
      };

      const collector = new StackExchangeCollector({ fetchFn: customFetch });

      await assert.rejects(
        async () => {
          await collector.collect({
            sourceKey: 'stack_exchange',
            cursor: null,
          });
        },
        (err: Error) => {
          assert(err.message.includes('429'));
          return true;
        },
      );

      // Verify re-check function also throws on 429 and does not produce tombstone candidates
      await assert.rejects(async () => {
        await collector.verifyQuestionsActive({
          questionIds: [78901, 78902],
        });
      });
    });

    test('throws error on Stack Exchange API throttle_violation error payload', async () => {
      const customFetch: typeof fetch = async () => {
        const body: StackExchangeApiResponse = {
          error_id: 502,
          error_name: 'throttle_violation',
          error_message: 'too many requests from this IP',
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const collector = new StackExchangeCollector({ fetchFn: customFetch });

      await assert.rejects(
        async () => {
          await collector.collect({
            sourceKey: 'stack_exchange',
            cursor: null,
          });
        },
        (err: Error) => {
          assert(err.message.includes('throttle_violation'));
          return true;
        },
      );
    });

    test('throws error on network failure and NEVER treats failure as deletion', async () => {
      const customFetch: typeof fetch = async () => {
        throw new TypeError('Network connection terminated');
      };

      const collector = new StackExchangeCollector({ fetchFn: customFetch });

      await assert.rejects(
        async () => {
          await collector.collect({
            sourceKey: 'stack_exchange',
            cursor: null,
          });
        },
        (err: Error) => {
          assert(err.message.includes('Network failure'));
          return true;
        },
      );
    });
  });

  describe('7. Absence-Based Deletion Detection (Re-fetch Contract)', () => {
    test('detectTombstoneCandidates identifies missing items ONLY on successful fetch', () => {
      const expectedIds = ['stackoverflow:1001', 'stackoverflow:1002', 'stackoverflow:1003'];
      const fetchedActive = ['stackoverflow:1001', 'stackoverflow:1003'];

      // Successful re-fetch with missing item 1002
      const candidatesOnSuccess = detectTombstoneCandidates({
        expectedExternalIds: expectedIds,
        fetchedActiveExternalIds: fetchedActive,
        fetchSuccess: true,
      });
      assert.deepEqual(candidatesOnSuccess, ['stackoverflow:1002']);

      // Unsuccessful / failed fetch MUST NEVER return tombstone candidates
      const candidatesOnFailure = detectTombstoneCandidates({
        expectedExternalIds: expectedIds,
        fetchedActiveExternalIds: fetchedActive,
        fetchSuccess: false,
      });
      assert.deepEqual(candidatesOnFailure, []);
    });

    test('verifyQuestionsActive identifies absence-based tombstone candidates in 200 OK re-fetch', async () => {
      const customFetch: typeof fetch = async (input) => {
        const urlStr = String(input);
        assert(urlStr.includes('/questions/78901;78902'));

        // API only returns 78901; 78902 is absent (deleted upstream)
        const body: StackExchangeApiResponse = {
          items: [sampleQuestionWithLicense],
          has_more: false,
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const collector = new StackExchangeCollector({ fetchFn: customFetch });
      const result = await collector.verifyQuestionsActive({
        questionIds: [78901, 78902],
      });

      assert.deepEqual(result.activeExternalIds, ['stackoverflow:78901']);
      assert.deepEqual(result.tombstoneCandidates, ['stackoverflow:78902']);
    });

    test('closed and locked items are preserved as active items, NOT tombstones', async () => {
      const customFetch: typeof fetch = async () => {
        const body: StackExchangeApiResponse = {
          items: [sampleClosedQuestion],
          has_more: false,
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const collector = new StackExchangeCollector({ fetchFn: customFetch });
      const res = await collector.collect({
        sourceKey: 'stack_exchange',
        cursor: null,
      });

      assert.equal(res.items.length, 1);
      const item = res.items[0]!;
      assert.equal(item.externalId, 'stackoverflow:78903');
      assert.equal(item.metadata?.['closed_date'], '2024-09-01T02:00:00.000Z');
      assert.equal(item.metadata?.['locked_date'], '2024-09-01T03:06:40.000Z');

      // In re-fetch, closed question is returned by API and thus marked active, NOT tombstone
      const verifyRes = await collector.verifyQuestionsActive({
        questionIds: [78903],
      });
      assert.deepEqual(verifyRes.activeExternalIds, ['stackoverflow:78903']);
      assert.deepEqual(verifyRes.tombstoneCandidates, []);
    });
  });

  describe('8. SSRF and Security Guard Enforcements', () => {
    const policy = SOURCE_POLICIES['stack_exchange'];

    test('validateUrl rejects unpermitted scheme for stack_exchange policy', () => {
      const httpRes = validateUrl('http://api.stackexchange.com/2.3/questions', policy);
      assert.equal(httpRes.valid, false);
      assert(httpRes.reason?.includes('not permitted'));
    });

    test('validateUrl rejects unpermitted host for stack_exchange policy', () => {
      const hostRes = validateUrl('https://evil-stack.com/2.3/questions', policy);
      assert.equal(hostRes.valid, false);
      assert(hostRes.reason?.includes('not in the allowed hosts list'));
    });

    test('validateUrl accepts permitted https api.stackexchange.com host', () => {
      const validRes = validateUrl('https://api.stackexchange.com/2.3/questions', policy);
      assert.equal(validRes.valid, true);
    });

    test('collector throws security violation error if guard rejects generated URL', async () => {
      const rejectingGuard = {
        validateUrl: () => ({ valid: false, reason: 'SSRF guard blocked host' }),
        stripPii: <T extends Record<string, unknown>>(p: T) => p,
        enforceContentPolicy: () => ({ valid: true }),
      };

      const collector = new StackExchangeCollector({
        guard: rejectingGuard,
      });

      await assert.rejects(
        async () => {
          await collector.collect({
            sourceKey: 'stack_exchange',
            cursor: null,
          });
        },
        (err: Error) => {
          assert(err.message.includes('Security violation'));
          assert(err.message.includes('SSRF guard blocked host'));
          return true;
        },
      );
    });
  });

  describe('9. Multi-target Tags for Public Corpus', () => {
    test('supports rotating across Bun, Node, Playwright, TS, React tags', async () => {
      const requestedUrls: string[] = [];
      const customFetch: typeof fetch = async (url: string | URL | Request) => {
        requestedUrls.push(url.toString());
        return new Response(
          JSON.stringify({
            items: [
              {
                question_id: 991,
                link: 'https://stackoverflow.com/questions/991',
                creation_date: 1700000000,
                content_license: 'CC BY-SA 4.0',
              },
            ],
            has_more: false,
            quota_remaining: 9999,
          }),
          { status: 200 },
        );
      };

      const collector = new StackExchangeCollector({
        fetchFn: customFetch,
        defaultTags: ['typescript', 'bun'],
      });

      // Run 1: first tag (typescript)
      const run1 = await collector.collect({ sourceKey: 'stack_exchange', cursor: null });
      assert.match(requestedUrls[0]!, /tagged=typescript/);
      assert.equal(run1.items.length, 1);
      assert.ok(run1.nextCursor);

      const cursor1 = decodeOpaqueCursor<{ tagIndex: number; tag: string }>(run1.nextCursor!);
      assert.equal(cursor1.tagIndex, 1);
      assert.equal(cursor1.tag, 'bun');

      // Run 2: second tag (bun)
      const run2 = await collector.collect({
        sourceKey: 'stack_exchange',
        cursor: run1.nextCursor,
      });
      assert.match(requestedUrls[1]!, /tagged=bun/);
      assert.equal(run2.items.length, 1);

      const cursor2 = decodeOpaqueCursor<{ tagIndex: number }>(run2.nextCursor!);
      assert.equal(cursor2.tagIndex, 0); // rotated back to 0
    });
  });
});
