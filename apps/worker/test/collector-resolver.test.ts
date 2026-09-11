import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createCollectorPageAdapter, createTargetRevision } from '@techpulse/collectors';
import type { CollectionPartition } from '@techpulse/domain';
import type { TargetCollectorResolver } from '../src/ingestion.js';

describe('Worker Target-Aware Collector Resolution', () => {
  const clock = new Date('2026-09-09T00:00:00Z');

  function createSamplePartition(targetRevisionId: string): CollectionPartition {
    return {
      id: 'part-1',
      targetRevisionId,
      mode: 'incremental',
      scopeKey: 'default',
      window: {
        from: new Date('2026-09-08T00:00:00Z'),
        to: new Date('2026-09-09T00:00:00Z'),
      },
      timeBasis: 'published_at',
      workflowVersion: '1',
      state: 'running',
      cursor: null,
      pageSequence: 1,
      leaseEpoch: 1,
      leaseUntil: null,
      dueAt: clock,
      lastAttemptAt: null,
      attemptCount: 0,
      itemsCollected: 0,
      bytesIngested: 0,
      requestsMade: 0,
      disposition: null,
      reason: null,
    };
  }

  test('resolves target-aware adapter for github_releases target', async () => {
    const target = createTargetRevision({
      targetId: 'tgt-gh',
      sourceId: 'src-gh',
      sourceKey: 'github_releases',
      selector: { kind: 'repository', owner: 'microsoft', repository: 'playwright' },
      enabled: true,
    });

    const fixtureFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify([
          {
            id: 1,
            tag_name: 'v1.40.0',
            name: 'v1.40.0',
            draft: false,
            prerelease: false,
            published_at: '2026-09-08T12:00:00Z',
            html_url: 'https://github.com/microsoft/playwright/releases/tag/v1.40.0',
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const adapter = createCollectorPageAdapter({ fetch: fixtureFetch });
    const result = await adapter.collectPage({
      target,
      partition: createSamplePartition(target.id),
      limit: 10,
      maxRequests: 5,
      maxBytes: 1048576,
      now: clock,
    });

    assert.equal(result.items.length, 1);
    assert.equal(
      result.items[0]?.metadata?.['canonicalUrl'],
      'https://github.com/microsoft/playwright/releases/tag/v1.40.0',
    );
    assert.equal(result.items[0]?.externalId, 'github_releases:microsoft/playwright:1');
  });

  test('resolves target-aware adapter for arxiv target', async () => {
    const target = createTargetRevision({
      targetId: 'tgt-arxiv',
      sourceId: 'src-arxiv',
      sourceKey: 'arxiv',
      selector: { kind: 'category', category: 'cs.AI' },
      enabled: true,
    });

    const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>cs.AI updates</title>
  <entry>
    <id>http://arxiv.org/abs/2609.00001v1</id>
    <updated>2026-09-08T10:00:00Z</updated>
    <published>2026-09-08T10:00:00Z</published>
    <title>Sample AI Paper</title>
    <summary>Sample abstract text.</summary>
    <author><name>Test Author</name></author>
  </entry>
</feed>`;

    const fixtureFetch: typeof fetch = async () =>
      new Response(sampleXml, { status: 200, headers: { 'content-type': 'application/atom+xml' } });

    const adapter = createCollectorPageAdapter({ fetch: fixtureFetch });
    const result = await adapter.collectPage({
      target,
      partition: createSamplePartition(target.id),
      limit: 10,
      maxRequests: 5,
      maxBytes: 1048576,
      now: clock,
    });

    assert.equal(result.items.length, 1);
    assert.ok(String(result.items[0]?.metadata?.['canonicalUrl']).includes('2609.00001'));
  });

  test('rejects unapproved or disabled target collection', async () => {
    const disabledTarget = createTargetRevision({
      targetId: 'tgt-disabled',
      sourceId: 'src-gh',
      sourceKey: 'github_releases',
      selector: { kind: 'repository', owner: 'facebook', repository: 'react' },
      enabled: false,
    });

    const adapter = createCollectorPageAdapter();
    await assert.rejects(
      () =>
        adapter.collectPage({
          target: disabledTarget,
          partition: createSamplePartition(disabledTarget.id),
          limit: 10,
          maxRequests: 5,
          maxBytes: 1048576,
          now: clock,
        }),
      /policy_blocked/u,
    );
  });

  test('resolves target-aware adapter through TargetCollectorResolver contract', () => {
    const defaultAdapter = createCollectorPageAdapter();
    const resolver: TargetCollectorResolver = () => defaultAdapter;

    const target = createTargetRevision({
      targetId: 'tgt-gh',
      sourceId: 'src-gh',
      sourceKey: 'github_releases',
      selector: { kind: 'repository', owner: 'microsoft', repository: 'playwright' },
      enabled: true,
    });

    const collector = resolver('github_releases', target);
    assert.equal(collector, defaultAdapter);
  });
});
