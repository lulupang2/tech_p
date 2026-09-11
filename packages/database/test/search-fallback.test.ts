import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createSearchService } from '../src/index.js';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import type { schema } from '../src/schema/index.js';

describe('DB search service: conservative natural query fallback', () => {
  test("exact match first, then fallback to normalized keywords for '최근 Playwright 릴리스의 주요 변경점을 알려줘.'", async () => {
    const executedSqls: string[] = [];

    const mockDb = {
      execute: async (query: { queryChunks: unknown[] }) => {
        // Collect stringified query chunks to inspect queries executed
        const sqlText = JSON.stringify(query);
        executedSqls.push(sqlText);

        // All normalized candidates are represented in one SQL statement.
        if (sqlText.includes('Playwright')) {
          return {
            rows: [
              {
                chunk_id: 'chunk-pw-1',
                document_id: 'doc-pw-1',
                document_revision_id: 'rev-pw-1',
                title: 'Playwright v1.62.1 Release',
                content: 'New locator assertions in Playwright v1.62.1',
                heading_path: ['Releases'],
                score: 0.92,
                published_at: '2026-08-25T00:00:00.000Z',
              },
            ],
          };
        }

        return { rows: [] };
      },
    } as unknown as NeonDatabase<typeof schema>;

    const searchService = createSearchService(mockDb);

    const hits = await searchService.searchFts({
      query: '최근 Playwright 릴리스의 주요 변경점을 알려줘.',
      limit: 5,
    });

    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.chunkId, 'chunk-pw-1');
    assert.equal(hits[0]?.title, 'Playwright v1.62.1 Release');
    // Natural-language candidates are combined into one indexed DB round-trip.
    assert.equal(executedSqls.length, 1);
  });

  test('exact query match returns immediately without triggering fallback', async () => {
    let callCount = 0;

    const mockDb = {
      execute: async () => {
        callCount++;
        return {
          rows: [
            {
              chunk_id: 'chunk-exact-1',
              document_id: 'doc-exact-1',
              document_revision_id: 'rev-exact-1',
              title: 'Exact Title',
              content: 'Exact Content',
              heading_path: [],
              score: 0.99,
              published_at: null,
            },
          ],
        };
      },
    } as unknown as NeonDatabase<typeof schema>;

    const searchService = createSearchService(mockDb);

    const hits = await searchService.searchFts({
      query: 'Exact Title',
    });

    assert.equal(hits.length, 1);
    assert.equal(callCount, 1);
  });

  test('prioritizes an exact semver fallback before generic release words', async () => {
    const executedSqls: string[] = [];
    const mockDb = {
      execute: async (query: { queryChunks: unknown[] }) => {
        const sqlText = JSON.stringify(query);
        executedSqls.push(sqlText);
        if (sqlText.includes('24.21.0')) {
          return {
            rows: [
              {
                chunk_id: 'chunk-node',
                document_id: 'doc-node',
                document_revision_id: 'rev-node',
                title: '2026-09-08, Version 24.21.0 Krypton (LTS)',
                content: 'Node release notes',
                heading_path: [],
                ordinal: 0,
                token_count: 5,
                score: 1,
                published_at: '2026-09-08T00:00:00Z',
              },
            ],
          };
        }
        return { rows: [] };
      },
    } as unknown as NeonDatabase<typeof schema>;
    const searchService = createSearchService(mockDb);
    const hits = await searchService.searchFts({
      query: 'Summarize nodejs/node release "2026-09-08, Version 24.21.0 Krypton (LTS)".',
    });
    assert.equal(hits[0]?.documentRevisionId, 'rev-node');
    assert.equal(executedSqls.length, 1);
    assert(executedSqls[0]?.includes('Summarize'));
    assert(executedSqls[0]?.includes('24.21.0'));
  });

  test('unrelated query returning zero hits across attempts returns empty array', async () => {
    const mockDb = {
      execute: async () => ({ rows: [] }),
    } as unknown as NeonDatabase<typeof schema>;

    const searchService = createSearchService(mockDb);

    const hits = await searchService.searchFts({
      query: '오늘 서울 날씨 어때?',
    });

    assert.deepEqual(hits, []);
  });

  test('database execution errors propagate directly as database errors', async () => {
    const mockDb = {
      execute: async () => {
        throw new Error('PostgreSQL connection timeout');
      },
    } as unknown as NeonDatabase<typeof schema>;

    const searchService = createSearchService(mockDb);

    await assert.rejects(
      () => searchService.searchFts({ query: 'Playwright' }),
      (err: unknown) => {
        assert(err instanceof Error);
        assert.equal(err.message, 'PostgreSQL connection timeout');
        return true;
      },
    );
  });

  test('renders the same fail-closed rights filter and complete profile readiness in SQL', async () => {
    const executedSqls: string[] = [];
    const mockDb = {
      execute: async (query: unknown) => {
        executedSqls.push(JSON.stringify(query));
        return { rows: [] };
      },
    } as unknown as NeonDatabase<typeof schema>;
    const searchService = createSearchService(mockDb);
    const filter = {
      status: 'searchable',
      publishedAfter: new Date('2026-08-01T00:00:00.000Z'),
      publishedBefore: new Date('2026-09-01T00:00:00.000Z'),
      requireApprovedRights: true,
    } as const;

    await searchService.searchFts({ query: 'Playwright', filter });
    await searchService.searchExactVector({
      vector: [1, 0, 0],
      dimensions: 3,
      provider: 'approved-provider',
      model: 'approved-model',
      profileHash: 'approved-profile-hash',
      filter,
    });

    const lexicalSql = executedSqls[0] ?? '';
    const vectorSql = executedSqls.at(-1) ?? '';
    for (const sqlText of [lexicalSql, vectorSql]) {
      assert.match(sqlText, /rights_metadata/u);
      assert.match(sqlText, /modelInput/u);
      assert.match(sqlText, /displayExcerpt/u);
      assert.match(sqlText, /policy_reviewed_at/u);
      assert.match(sqlText, /published_at/u);
    }
    assert.match(vectorSql, /profile_hash/u);
    assert.match(vectorSql, /input_hash/u);
    assert.match(vectorSql, /NOT EXISTS/u);
  });
});
