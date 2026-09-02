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

        // First call: exact query has '최근 Playwright' -> return empty
        if (sqlText.includes('최근 Playwright')) {
          return { rows: [] };
        }

        // Fallback call: tech keyword 'Playwright' matches
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
    // Must have executed exact query first, then fallback
    assert(executedSqls.length >= 2);
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
});
