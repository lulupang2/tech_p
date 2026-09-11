import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CollectionStateError,
  encodePageCursor,
  type CollectionPartition,
} from '@techpulse/domain';
import { createTargetRevision, createCollectorPageAdapter } from '../src/targets.js';
import { createSourceSearchAdapter } from '../src/source-search.js';
import { GitHubReleasesCollector } from '../src/github-releases.js';
import { StackExchangeCollector } from '../src/stack-exchange.js';
import { DefaultPolicyGuard } from '../src/guard.js';
import { SOURCE_POLICIES } from '../src/policies.js';

describe('COV-003: Target-Level Collectors & Search/Discovery Acceptance', () => {
  const clock = () => new Date('2026-09-08T12:00:00.000Z');

  function createPartition(
    targetRevisionId: string,
    mode: 'backfill' | 'incremental' | 'on_demand' = 'backfill',
    from = new Date('2026-06-01T00:00:00.000Z'),
    to = new Date('2026-09-01T00:00:00.000Z'),
    cursor: string | null = null,
  ): CollectionPartition {
    return {
      id: `part_${targetRevisionId}`,
      targetRevisionId,
      mode,
      scopeKey: 'test-scope-v1',
      window: { from, to },
      timeBasis: 'published_at',
      workflowVersion: '1.0.0',
      state: 'pending',
      pageSequence: 0,
      cursor,
      leaseEpoch: 1,
      leaseUntil: null,
      nextDueAt: new Date('2026-09-08T00:00:00.000Z'),
      reason: null,
    };
  }

  test('1. Two configured targets have isolated cursors and external ID namespaces', async () => {
    // Setup Target A (facebook/react) and Target B (microsoft/typescript)
    const targetA = createTargetRevision({
      targetId: 'target-react',
      sourceId: 'src-github',
      sourceKey: 'github_releases',
      selector: { kind: 'repository', owner: 'facebook', repository: 'react' },
      enabled: true,
    });

    const targetB = createTargetRevision({
      targetId: 'target-ts',
      sourceId: 'src-github',
      sourceKey: 'github_releases',
      selector: { kind: 'repository', owner: 'microsoft', repository: 'typescript' },
      enabled: true,
    });

    assert.notEqual(targetA.canonicalIdentity, targetB.canonicalIdentity);
    assert.equal(targetA.canonicalIdentity, 'github_releases:facebook/react');
    assert.equal(targetB.canonicalIdentity, 'github_releases:microsoft/typescript');

    const partitionA = createPartition(targetA.id);
    const partitionB = createPartition(targetB.id);

    // Encode a valid cursor for Target A
    const cursorA = encodePageCursor(
      partitionA,
      targetA.capability.cursorVersion,
      JSON.stringify({ page: 2 }),
    );

    // Passing Target A's cursor to Target B must fail with invalid_cursor error
    const partitionBWithCursorA: CollectionPartition = {
      ...partitionB,
      cursor: cursorA,
    };

    const fixtureFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify([
          {
            id: 12345,
            tag_name: 'v1.0.0',
            name: 'v1.0.0',
            draft: false,
            prerelease: false,
            published_at: '2026-07-01T12:00:00Z',
            html_url: 'https://github.com/example/repo/releases/tag/v1.0.0',
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const adapter = createCollectorPageAdapter({ fetch: fixtureFetch });

    // Target B should reject Target A's cursor
    await assert.rejects(
      async () => {
        await adapter.collectPage({
          target: targetB,
          partition: partitionBWithCursorA,
          limit: 30,
          maxRequests: 5,
          maxBytes: 1048576,
          now: clock,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof CollectionStateError);
        assert.equal(err.code, 'invalid_cursor');
        return true;
      },
    );

    // Target A with valid partition produces namespaced external ID
    const resA = await adapter.collectPage({
      target: targetA,
      partition: partitionA,
      limit: 30,
      maxRequests: 5,
      maxBytes: 1048576,
      now: clock,
    });

    assert.equal(resA.items.length, 1);
    assert.equal(resA.items[0]?.externalId, 'github_releases:facebook/react:12345');

    // Target B with valid partition produces its own namespaced external ID
    const resB = await adapter.collectPage({
      target: targetB,
      partition: partitionB,
      limit: 30,
      maxRequests: 5,
      maxBytes: 1048576,
      now: clock,
    });

    assert.equal(resB.items.length, 1);
    assert.equal(resB.items[0]?.externalId, 'github_releases:microsoft/typescript:12345');
    assert.notEqual(resA.items[0]?.externalId, resB.items[0]?.externalId);
  });

  test('2. Pagination yields expected unique IDs across pages', async () => {
    const target = createTargetRevision({
      targetId: 'target-se-ts',
      sourceId: 'src-se',
      sourceKey: 'stack_exchange',
      selector: { kind: 'tag', site: 'stackoverflow', tag: 'typescript' },
      enabled: true,
    });

    const partition = createPartition(target.id);

    const page1Questions = [
      { question_id: 101, title: 'Q101', creation_date: 1782864000, link: 'https://so.com/q/101' },
      { question_id: 102, title: 'Q102', creation_date: 1782864000, link: 'https://so.com/q/102' },
    ];
    const page2Questions = [
      { question_id: 103, title: 'Q103', creation_date: 1782864000, link: 'https://so.com/q/103' },
      { question_id: 104, title: 'Q104', creation_date: 1782864000, link: 'https://so.com/q/104' },
    ];

    const fixtureFetch: typeof fetch = async (urlStr) => {
      const url = new URL(urlStr.toString());
      const page = url.searchParams.get('page');
      if (page === '1') {
        return new Response(JSON.stringify({ items: page1Questions, has_more: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ items: page2Questions, has_more: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const collector = new StackExchangeCollector({ fetchFn: fixtureFetch });

    // Page 1
    const page1Res = await collector.collectPage({
      target,
      partition,
      limit: 2,
      maxRequests: 5,
      maxBytes: 1048576,
      now: clock,
    });

    assert.equal(page1Res.disposition, 'continue');
    assert.ok(page1Res.nextCursor);
    assert.deepEqual(
      page1Res.items.map((i) => i.externalId),
      ['stack_exchange:stackoverflow:101', 'stack_exchange:stackoverflow:102'],
    );

    // Page 2
    const partitionPage2: CollectionPartition = {
      ...partition,
      pageSequence: 1,
      cursor: page1Res.nextCursor,
    };

    const page2Res = await collector.collectPage({
      target,
      partition: partitionPage2,
      limit: 2,
      maxRequests: 5,
      maxBytes: 1048576,
      now: clock,
    });

    assert.equal(page2Res.disposition, 'complete');
    assert.equal(page2Res.nextCursor, null);
    assert.deepEqual(
      page2Res.items.map((i) => i.externalId),
      ['stack_exchange:stackoverflow:103', 'stack_exchange:stackoverflow:104'],
    );

    // Verify all 4 IDs are unique across pages
    const allIds = [
      ...page1Res.items.map((i) => i.externalId),
      ...page2Res.items.map((i) => i.externalId),
    ];
    assert.equal(new Set(allIds).size, 4);
  });

  test('3. Feed end differs from complete historical coverage', async () => {
    // Feed-only source (users_rust_lang / Discourse) on backfill partition
    const feedTarget = createTargetRevision({
      targetId: 'target-discourse',
      sourceId: 'src-discourse',
      sourceKey: 'users_rust_lang',
      selector: { kind: 'source' },
      capability: { historyMode: 'feed_only' },
      enabled: true,
    });

    const backfillPartition = createPartition(feedTarget.id, 'backfill');

    const fixtureFetch: typeof fetch = async (urlStr) => {
      const url = urlStr.toString();
      if (url.includes('/latest.json')) {
        return new Response(
          JSON.stringify({
            topic_list: {
              topics: [],
              more_topics_url: null, // Feed exhausted
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const adapter = createCollectorPageAdapter({ fetch: fixtureFetch });

    const feedRes = await adapter.collectPage({
      target: feedTarget,
      partition: backfillPartition,
      limit: 30,
      maxRequests: 5,
      maxBytes: 1048576,
      now: clock,
    });

    // Feed exhaustion on backfill yields partial with history_unsupported
    assert.equal(feedRes.disposition, 'partial');
    assert.equal(feedRes.reason, 'history_unsupported');

    // In contrast, historical range source (arXiv) yields complete when exhaustive
    const arxivTarget = createTargetRevision({
      targetId: 'target-arxiv',
      sourceId: 'src-arxiv',
      sourceKey: 'arxiv',
      selector: { kind: 'category', category: 'cs.AI' },
      capability: { historyMode: 'historical_range' },
      enabled: true,
    });

    const arxivPartition = createPartition(arxivTarget.id, 'backfill');

    const arxivFixtureFetch: typeof fetch = async () => {
      const emptyAtomXml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
        <opensearch:totalResults>0</opensearch:totalResults>
        <opensearch:startIndex>0</opensearch:startIndex>
        <opensearch:itemsPerPage>25</opensearch:itemsPerPage>
      </feed>`;
      return new Response(emptyAtomXml, {
        status: 200,
        headers: { 'content-type': 'application/atom+xml' },
      });
    };

    const arxivAdapter = createCollectorPageAdapter({ fetch: arxivFixtureFetch });
    const arxivRes = await arxivAdapter.collectPage({
      target: arxivTarget,
      partition: arxivPartition,
      limit: 25,
      maxRequests: 5,
      maxBytes: 1048576,
      now: clock,
    });

    assert.equal(arxivRes.disposition, 'complete');
    assert.equal(arxivRes.nextCursor, null);
  });

  test('4. Filtered empty pages continue', async () => {
    const target = createTargetRevision({
      targetId: 'target-gh-releases',
      sourceId: 'src-github',
      sourceKey: 'github_releases',
      selector: { kind: 'repository', owner: 'facebook', repository: 'react' },
      enabled: true,
    });

    // Window: 2026-06-01 to 2026-07-01
    const partition = createPartition(
      target.id,
      'backfill',
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-07-01T00:00:00.000Z'),
    );

    // Page 1 releases are newer than 2026-07-01 (e.g. 2026-08-15) -> all filtered out!
    // But Link header indicates next page exists.
    const page1Releases = [
      {
        id: 201,
        tag_name: 'v19.1.0',
        name: 'v19.1.0',
        draft: false,
        published_at: '2026-08-15T00:00:00.000Z',
        html_url: 'https://github.com/facebook/react/releases/tag/v19.1.0',
      },
    ];

    const page2Releases = [
      {
        id: 200,
        tag_name: 'v19.0.0',
        name: 'v19.0.0',
        draft: false,
        published_at: '2026-06-15T00:00:00.000Z', // In window!
        html_url: 'https://github.com/facebook/react/releases/tag/v19.0.0',
      },
    ];

    const fixtureFetch: typeof fetch = async (urlStr) => {
      const url = new URL(urlStr.toString());
      const page = url.searchParams.get('page');
      if (page === '1' || !page) {
        return new Response(JSON.stringify(page1Releases), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            link: '<https://api.github.com/repos/facebook/react/releases?page=2>; rel="next"',
          },
        });
      }
      return new Response(JSON.stringify(page2Releases), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    };

    const collector = new GitHubReleasesCollector({}, { fetch: fixtureFetch });

    // Page 1: 0 items in window, but has next page -> must continue!
    const page1Res = await collector.collectPage({
      target,
      partition,
      limit: 30,
      maxRequests: 5,
      maxBytes: 1048576,
      now: clock,
    });

    assert.equal(page1Res.items.length, 0);
    assert.equal(page1Res.disposition, 'continue');
    assert.ok(page1Res.nextCursor);

    // Page 2: 1 item in window -> collected!
    const page2Partition: CollectionPartition = {
      ...partition,
      pageSequence: 1,
      cursor: page1Res.nextCursor,
    };

    const page2Res = await collector.collectPage({
      target,
      partition: page2Partition,
      limit: 30,
      maxRequests: 5,
      maxBytes: 1048576,
      now: clock,
    });

    assert.equal(page2Res.items.length, 1);
    assert.equal(page2Res.items[0]?.externalId, 'github_releases:facebook/react:200');
    assert.equal(page2Res.disposition, 'complete');
  });

  test('5. Cap / history unsupported yields partial', async () => {
    // Test 5A: Provider result cap on GitHub Search (1000 items limit / page 10 reached)
    const ghSearchTarget = createTargetRevision({
      targetId: 'target-gh-search',
      sourceId: 'src-gh-search',
      sourceKey: 'github_search',
      selector: { kind: 'query', query: 'topic:ai' },
      capability: { historyMode: 'paginated_history' },
      enabled: true,
    });

    const ghSearchPartition = createPartition(ghSearchTarget.id);
    const page10Cursor = encodePageCursor(
      ghSearchPartition,
      ghSearchTarget.capability.cursorVersion,
      JSON.stringify({ page: 10 }),
    );
    const partitionAtPage10: CollectionPartition = {
      ...ghSearchPartition,
      pageSequence: 9,
      cursor: page10Cursor,
    };

    const searchFetch: typeof fetch = async () => {
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: 1000 + i,
        full_name: `org/repo-${i}`,
        created_at: '2026-07-01T00:00:00Z',
      }));
      return new Response(
        JSON.stringify({
          total_count: 50000, // Total count far exceeds 1000
          items,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const adapter = createCollectorPageAdapter({ fetch: searchFetch });
    const searchRes = await adapter.collectPage({
      target: ghSearchTarget,
      partition: partitionAtPage10,
      limit: 100,
      maxRequests: 5,
      maxBytes: 1048576,
      now: clock,
    });

    assert.equal(searchRes.disposition, 'partial');
    assert.equal(searchRes.reason, 'result_cap');
    assert.equal(searchRes.nextCursor, null);

    // Test 5B: Snapshot-only source (npm_registry) requested with backfill mode
    const npmTarget = createTargetRevision({
      targetId: 'target-npm-reg',
      sourceId: 'src-npm',
      sourceKey: 'npm_registry',
      selector: { kind: 'package', name: 'typescript' },
      capability: { historyMode: 'snapshot_only' },
      enabled: true,
    });

    const npmBackfillPartition = createPartition(npmTarget.id, 'backfill');

    const npmFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          name: 'typescript',
          time: { modified: '2026-09-01T00:00:00Z', created: '2014-01-01T00:00:00Z' },
          'dist-tags': { latest: '5.5.0' },
          versions: { '5.5.0': { name: 'typescript', version: '5.5.0' } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const npmAdapter = createCollectorPageAdapter({ fetch: npmFetch });
    const npmRes = await npmAdapter.collectPage({
      target: npmTarget,
      partition: npmBackfillPartition,
      limit: 10,
      maxRequests: 5,
      maxBytes: 1048576,
      now: clock,
    });

    assert.equal(npmRes.disposition, 'partial');
    assert.equal(npmRes.reason, 'history_unsupported');
  });

  test('6. Malicious URL is rejected by policy guards', async () => {
    const policy = SOURCE_POLICIES.github_releases;
    const guard = new DefaultPolicyGuard();

    const maliciousUrls = [
      'http://169.254.169.254/latest/meta-data',
      'http://127.0.0.1:8080/admin',
      'http://0.0.0.0:3000/internal',
      'http://[::1]/secret',
      'http://10.0.0.1/private',
      'http://192.168.1.1/router',
      'http://172.16.0.1/corp',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://evil-attacker.com/steal-data',
      'https://api.github.com.evil.com/releases',
    ];

    for (const badUrl of maliciousUrls) {
      const validation = guard.validateUrl(badUrl, policy);
      assert.equal(validation.valid, false, `Expected ${badUrl} to be rejected by guard`);
      assert.ok(validation.reason);
    }

    // Valid allowlisted URL passes
    const validValidation = guard.validateUrl(
      'https://api.github.com/repos/facebook/react/releases',
      policy,
    );
    assert.equal(validValidation.valid, true);
  });

  test('7. Approved search/discovery uses fixture HTTP without live calls', async () => {
    const requestedUrls: string[] = [];

    const fixtureFetch: typeof fetch = async (urlStr) => {
      const url = urlStr.toString();
      requestedUrls.push(url);

      if (url.includes('api.github.com/search/repositories')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                name: 'playwright',
                owner: { login: 'microsoft' },
                html_url: 'https://github.com/microsoft/playwright',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.includes('api.stackexchange.com/2.3/search/advanced')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                question_id: 555,
                title: 'How to use TypeScript?',
                link: 'https://stackoverflow.com/q/555',
                creation_date: 1782864000,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.includes('api.stackexchange.com/2.3/tags')) {
        return new Response(
          JSON.stringify({
            items: [{ name: 'typescript', count: 10000 }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.includes('export.arxiv.org/api/query')) {
        const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
          <entry>
            <id>http://arxiv.org/abs/2401.99999v1</id>
            <title>Advances in AI Agents</title>
            <summary>A paper on autonomous agents.</summary>
            <published>2026-07-01T00:00:00Z</published>
            <updated>2026-07-01T00:00:00Z</updated>
            <author><name>Alice Researcher</name></author>
          </entry>
        </feed>`;
        return new Response(atomXml, {
          status: 200,
          headers: { 'content-type': 'application/atom+xml' },
        });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    };

    const searchAdapter = createSourceSearchAdapter({ fetch: fixtureFetch });

    const ghTarget = createTargetRevision({
      targetId: 'target-gh',
      sourceId: 'src-gh',
      sourceKey: 'github_releases',
      selector: { kind: 'repository', owner: 'microsoft', repository: 'playwright' },
      enabled: true,
    });

    const seTarget = createTargetRevision({
      targetId: 'target-se',
      sourceId: 'src-se',
      sourceKey: 'stack_exchange',
      selector: { kind: 'tag', site: 'stackoverflow', tag: 'typescript' },
      enabled: true,
    });

    const arxivTarget = createTargetRevision({
      targetId: 'target-arxiv',
      sourceId: 'src-arxiv',
      sourceKey: 'arxiv',
      selector: { kind: 'category', category: 'cs.AI' },
      enabled: true,
    });

    const searchWindow = {
      from: new Date('2026-06-01T00:00:00.000Z'),
      to: new Date('2026-09-01T00:00:00.000Z'),
    };

    // Test searchCandidates across approved sources
    const seCandidates = await searchAdapter.searchCandidates({
      query: 'typescript',
      target: seTarget,
      window: searchWindow,
      limit: 5,
      signal: new AbortController().signal,
    });

    assert.equal(seCandidates.length, 1);
    assert.equal(seCandidates[0]?.externalId, 'stack_exchange:stackoverflow:555');
    assert.equal(seCandidates[0]?.title, 'How to use TypeScript?');

    const arxivCandidates = await searchAdapter.searchCandidates({
      query: 'autonomous agents',
      target: arxivTarget,
      window: searchWindow,
      limit: 5,
      signal: new AbortController().signal,
    });

    assert.equal(arxivCandidates.length, 1);
    assert.equal(arxivCandidates[0]?.externalId, 'arxiv:2401.99999v1');
    assert.equal(arxivCandidates[0]?.title, 'Advances in AI Agents');

    // Test discoverTargets (Candidate discovery must NEVER enable targets)
    const discoveredGh = await searchAdapter.discoverTargets({
      query: 'playwright',
      target: ghTarget,
      window: searchWindow,
      limit: 5,
      signal: new AbortController().signal,
    });

    assert.equal(discoveredGh.length, 1);
    assert.equal(discoveredGh[0]?.canonicalIdentity, 'github_releases:microsoft/playwright');
    assert.equal(discoveredGh[0]?.sourceKey, 'github_releases');
    assert.deepEqual(discoveredGh[0]?.selector, {
      kind: 'repository',
      owner: 'microsoft',
      repository: 'playwright',
    });

    const discoveredSe = await searchAdapter.discoverTargets({
      query: 'typescript',
      target: seTarget,
      window: searchWindow,
      limit: 5,
      signal: new AbortController().signal,
    });

    assert.equal(discoveredSe.length, 1);
    assert.equal(discoveredSe[0]?.canonicalIdentity, 'stack_exchange:stackoverflow:typescript');
    assert.equal(discoveredSe[0]?.sourceKey, 'stack_exchange');

    // All requests were intercepted by fixtureFetch
    assert.ok(requestedUrls.length >= 4);
    assert.ok(requestedUrls.some((u) => u.includes('stackexchange.com')));
    assert.ok(requestedUrls.some((u) => u.includes('arxiv.org')));
    assert.ok(requestedUrls.some((u) => u.includes('github.com')));
  });
});
