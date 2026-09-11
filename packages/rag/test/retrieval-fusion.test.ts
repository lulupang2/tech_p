import { describe, expect, it } from 'vitest';
import type { SearchHit } from '@techpulse/domain';
import { fuseRetrievalCandidates } from '../src/retrieval-fusion.js';

function hit(
  chunkId: string,
  revisionId: string,
  sourceKey: string,
  publishedAt: string,
  clusterId?: string,
): SearchHit {
  return {
    chunkId,
    documentId: `doc-${revisionId}`,
    documentRevisionId: revisionId,
    ...(clusterId ? { duplicateClusterId: clusterId } : {}),
    title: chunkId,
    content: chunkId,
    headingPath: [],
    score: 1,
    sourceKey,
    publishedAt: new Date(publishedAt),
  };
}

describe('retrieval candidate fusion', () => {
  it('rewards candidates present in both ranked lists', () => {
    const shared = hit('shared', 'r-shared', 'github', '2026-09-01T00:00:00Z');
    const result = fuseRetrievalCandidates(
      [
        [hit('lexical', 'r-lexical', 'github', '2026-09-01T00:00:00Z'), shared],
        [hit('vector', 'r-vector', 'github', '2026-09-01T00:00:00Z'), shared],
      ],
      { now: new Date('2026-09-10T00:00:00Z') },
    );
    expect(result[0]?.chunkId).toBe('shared');
  });

  it('prevents one long revision or duplicate cluster from occupying the result set', () => {
    const crowded = Array.from({ length: 8 }, (_, index) =>
      hit(`crowded-${index}`, 'r-crowded', 'github', '2026-09-01T00:00:00Z', 'cluster-a'),
    );
    const distinct = [
      hit('distinct-a', 'r-a', 'github', '2026-08-31T00:00:00Z', 'cluster-b'),
      hit('distinct-b', 'r-b', 'github', '2026-08-30T00:00:00Z', 'cluster-c'),
    ];
    const result = fuseRetrievalCandidates([[...crowded, ...distinct]], {
      limit: 10,
      maxChunksPerRevision: 2,
      maxPerDuplicateCluster: 2,
      now: new Date('2026-09-10T00:00:00Z'),
    });
    expect(result.filter((item) => item.documentRevisionId === 'r-crowded')).toHaveLength(2);
    expect(result.map((item) => item.chunkId)).toEqual(
      expect.arrayContaining(['distinct-a', 'distinct-b']),
    );
  });

  it('applies an adaptive source cap only when multiple sources exist', () => {
    const manyA = Array.from({ length: 8 }, (_, index) =>
      hit(`a-${index}`, `ra-${index}`, 'a', '2026-09-01T00:00:00Z'),
    );
    const sourceB = hit('b-1', 'rb-1', 'b', '2026-08-01T00:00:00Z');
    const result = fuseRetrievalCandidates([[...manyA, sourceB]], {
      limit: 5,
      now: new Date('2026-09-10T00:00:00Z'),
    });
    expect(result.filter((item) => item.sourceKey === 'a')).toHaveLength(3);
    expect(result.some((item) => item.sourceKey === 'b')).toBe(true);
  });

  it('uses bounded recency only as a tie breaker and remains deterministic', () => {
    const oldHit = hit('old', 'r-old', 'github', '2025-01-01T00:00:00Z');
    const recentHit = hit('recent', 'r-recent', 'github', '2026-09-09T00:00:00Z');
    const options = { now: new Date('2026-09-10T00:00:00Z') };
    const first = fuseRetrievalCandidates([[oldHit, recentHit]], options);
    const second = fuseRetrievalCandidates([[oldHit, recentHit]], options);
    expect(first.map((item) => item.chunkId)).toEqual(second.map((item) => item.chunkId));
    expect(first.map((item) => item.chunkId)).toContain('recent');
  });
});
