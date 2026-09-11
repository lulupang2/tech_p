import { describe, expect, it } from 'vitest';
import type { SearchHit } from '@techpulse/domain';
import { assembleContextEvidence } from '../src/context-assembly.js';

function hit(
  overrides: Partial<SearchHit> & Pick<SearchHit, 'chunkId' | 'documentRevisionId'>,
): SearchHit {
  return {
    chunkId: overrides.chunkId,
    documentId: overrides.documentId ?? `doc-${overrides.documentRevisionId}`,
    documentRevisionId: overrides.documentRevisionId,
    title: overrides.title ?? 'Evidence',
    content: overrides.content ?? 'grounded evidence',
    headingPath: overrides.headingPath ?? ['section'],
    score: overrides.score ?? 1,
    publishedAt: overrides.publishedAt ?? new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

describe('RAG-004 context assembly', () => {
  it('merges adjacent chunks from the same revision and heading', () => {
    const result = assembleContextEvidence(
      [
        hit({
          chunkId: 'c1',
          documentRevisionId: 'r1',
          ordinal: 0,
          tokenCount: 10,
          content: 'first',
        }),
        hit({
          chunkId: 'c2',
          documentRevisionId: 'r1',
          ordinal: 1,
          tokenCount: 12,
          content: 'second',
        }),
      ],
      { intent: 'recent_updates', maxContextTokens: 100 },
    );

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.mergedChunkIds).toEqual(['c1', 'c2']);
    expect(result.evidence[0]?.hit.content).toBe('first\n\nsecond');
    expect(result.totalEstimatedTokens).toBe(22);
  });

  it('suppresses duplicate upstream clusters before context budgeting', () => {
    const result = assembleContextEvidence(
      [
        hit({ chunkId: 'c1', documentRevisionId: 'r1', duplicateClusterId: 'dup-a' }),
        hit({ chunkId: 'c2', documentRevisionId: 'r2', duplicateClusterId: 'dup-a' }),
        hit({ chunkId: 'c3', documentRevisionId: 'r3', duplicateClusterId: 'dup-b' }),
      ],
      { intent: 'trend_summary', maxContextTokens: 1000 },
    );

    expect(result.evidence.map((item) => item.hit.chunkId)).toEqual(['c1', 'c3']);
    expect(result.suppressedDuplicates).toBe(1);
  });

  it('never exceeds the context token budget', () => {
    const result = assembleContextEvidence(
      [
        hit({ chunkId: 'c1', documentRevisionId: 'r1', tokenCount: 60, content: 'first evidence' }),
        hit({
          chunkId: 'c2',
          documentRevisionId: 'r2',
          tokenCount: 60,
          content: 'second evidence',
        }),
        hit({ chunkId: 'c3', documentRevisionId: 'r3', tokenCount: 30, content: 'third evidence' }),
      ],
      { intent: 'trend_summary', maxContextTokens: 100 },
    );

    expect(result.totalEstimatedTokens).toBeLessThanOrEqual(100);
    expect(result.evidence.map((item) => item.hit.chunkId)).toEqual(['c1', 'c3']);
    expect(result.droppedForBudget).toBe(1);
  });

  it('keeps only the newest revision for an explicit latest-release question', () => {
    const result = assembleContextEvidence(
      [
        hit({ chunkId: 'old', documentRevisionId: 'r-old', publishedAt: new Date('2026-08-01') }),
        hit({
          chunkId: 'new-1',
          documentRevisionId: 'r-new',
          content: 'new first',
          publishedAt: new Date('2026-09-01'),
        }),
        hit({
          chunkId: 'new-2',
          documentRevisionId: 'r-new',
          content: 'new second',
          publishedAt: new Date('2026-09-01'),
        }),
      ],
      { intent: 'recent_updates', latestOnly: true },
    );

    expect(result.evidence.map((item) => item.hit.chunkId)).toEqual(['new-1', 'new-2']);
    expect(result.sufficiency.documents).toBe(1);
  });

  it('fails closed when no evidence matches an explicit repository target', () => {
    const result = assembleContextEvidence(
      [
        hit({
          chunkId: 'foreign',
          documentRevisionId: 'r-foreign',
          canonicalUrl: 'https://github.com/microsoft/playwright/releases/tag/v1.63.0',
        }),
      ],
      {
        intent: 'recent_updates',
        latestOnly: true,
        repositoryTarget: 'nodejs/node',
      },
    );

    expect(result.evidence).toHaveLength(0);
    expect(result.sufficiency).toMatchObject({ sufficient: false, reason: 'no_evidence' });
  });

  it('recognizes the canonical repository after an approved repository rename', () => {
    const result = assembleContextEvidence(
      [
        hit({
          chunkId: 'react',
          documentRevisionId: 'r-react',
          canonicalUrl: 'https://github.com/react/react/releases/tag/v19.3.0',
        }),
      ],
      {
        intent: 'recent_updates',
        latestOnly: true,
        repositoryTarget: 'facebook/react',
      },
    );

    expect(result.evidence.map((item) => item.hit.chunkId)).toEqual(['react']);
  });

  it.each([
    'https://evil-github.com/react/react/releases/tag/v19.3.0',
    'https://example.test/github.com/react/react/releases/tag/v19.3.0',
    'https://example.test/?url=github.com/react/react/releases/tag/v19.3.0',
    'http://github.com/react/react/releases/tag/v19.3.0',
    'https://user:pass@github.com/react/react/releases/tag/v19.3.0',
    'https://github.com/react/react-other/releases/tag/v19.3.0',
    'https://github.com/unapproved/react/releases/tag/v19.3.0',
    'not-a-url',
  ])('rejects unapproved or misleading repository URL %s', (canonicalUrl) => {
    const result = assembleContextEvidence(
      [hit({ chunkId: 'foreign', documentRevisionId: 'r-foreign', canonicalUrl })],
      { intent: 'recent_updates', repositoryTarget: 'facebook/react', latestOnly: true },
    );
    expect(result.evidence).toHaveLength(0);
    expect(result.sufficiency.sufficient).toBe(false);
  });

  it('requires multiple independent documents for compare and emerging intents', () => {
    const oneDoc = [hit({ chunkId: 'c1', documentRevisionId: 'r1' })];
    const compare = assembleContextEvidence(oneDoc, {
      intent: 'compare_interest',
      entityIds: ['react', 'svelte'],
    });
    const emerging = assembleContextEvidence(oneDoc, { intent: 'emerging_topics' });

    expect(compare.sufficiency).toMatchObject({
      sufficient: false,
      reason: 'compare_requires_multiple_independent_documents',
    });
    expect(emerging.sufficiency).toMatchObject({
      sufficient: false,
      reason: 'emerging_topics_require_multiple_documents',
    });
  });
});
