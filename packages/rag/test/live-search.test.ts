import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { fetchLiveTechEvidence } from '../src/live-search.js';

describe('fetchLiveTechEvidence', () => {
  test('returns SearchHit array formatted for RAG context using mock fetch', async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('registry.npmjs.org')) {
        return new Response(
          JSON.stringify({
            objects: [
              {
                package: {
                  name: 'next',
                  version: '15.1.0',
                  description: 'The React Framework',
                  links: { npm: 'https://www.npmjs.com/package/next' },
                  date: '2026-08-01T00:00:00Z',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('api.github.com')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                full_name: 'vercel/next.js',
                html_url: 'https://github.com/vercel/next.js',
                description: 'The React Framework',
                stargazers_count: 120000,
                pushed_at: '2026-08-20T00:00:00Z',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          query: {
            search: [
              {
                title: 'Next.js',
                snippet: 'Next.js is an open-source React front-end development web framework.',
                pageid: 12345,
                timestamp: '2026-08-15T00:00:00Z',
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const hits = await fetchLiveTechEvidence('Next.js 15 릴리스 동향은 어때?', {
      fetchFn: mockFetch,
    });

    assert.ok(hits.length >= 2);
    const first = hits[0]!;
    assert.ok(first.title.includes('next'));
    assert.ok(first.documentId.startsWith('https://'));
    assert.ok(first.content.includes('React Framework'));
    assert.ok(first.score > 0.8);
  });

  test('safely returns empty array if all outbound calls fail or time out', async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error('Network error');
    };

    const hits = await fetchLiveTechEvidence('어떤 질문', { fetchFn: failingFetch });
    assert.deepEqual(hits, []);
  });
});
