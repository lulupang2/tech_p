import { describe, expect, it } from 'vitest';
import { parseAnswerContent, validateAnswerDraft } from '../src/answer-validation.js';
import type { ResolvedContextChunk } from '../src/answer-service.js';

function chunk(overrides: Partial<ResolvedContextChunk> = {}): ResolvedContextChunk {
  return {
    citationKey: 'C1',
    chunkId: 'chunk-1',
    documentId: 'doc-1',
    documentRevisionId: 'rev-1',
    title: 'Evidence',
    content: 'Exact source excerpt.',
    headingPath: [],
    publishedAt: new Date('2026-09-05T00:00:00Z'),
    canonicalUrl: 'https://example.com/1',
    source: 'github_releases',
    isVerbatimOnly: false,
    ...overrides,
  };
}

const range = {
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-09-10T00:00:00.000Z',
  timezone: 'UTC',
};

describe('RAG-005 answer validation', () => {
  it('normalizes approved JSON-object transport to a plain user-facing answer', () => {
    expect(parseAnswerContent('{"answer":"정상 답변 [C1]"}')).toEqual({
      answer: '정상 답변 [C1]',
      structured: true,
    });
    expect(parseAnswerContent('plain answer [C1]')).toEqual({
      answer: 'plain answer [C1]',
      structured: false,
    });
  });

  it('rejects missing, fabricated, and out-of-range citations', () => {
    const inRange = chunk();
    const outOfRange = chunk({ citationKey: 'C2', publishedAt: new Date('2026-08-01T00:00:00Z') });
    const map = new Map([
      ['C1', inRange],
      ['C2', outOfRange],
    ]);
    expect(
      validateAnswerDraft({
        content: 'no citation',
        chunksByCitation: map,
        resolvedTimeRange: range,
        enforceTimeRange: true,
      }).reasons,
    ).toContain('missing_citation');
    expect(
      validateAnswerDraft({
        content: 'bad [C99]',
        chunksByCitation: map,
        resolvedTimeRange: range,
        enforceTimeRange: true,
      }).reasons,
    ).toContain('unknown_citation:C99');
    expect(
      validateAnswerDraft({
        content: 'old [C2]',
        chunksByCitation: map,
        resolvedTimeRange: range,
        enforceTimeRange: true,
      }).reasons,
    ).toContain('out_of_range_citation:C2');
  });

  it('requires verbatim-only evidence to appear unchanged in the answer', () => {
    const exact = chunk({ isVerbatimOnly: true, source: 'stack_exchange' });
    const map = new Map([['C1', exact]]);
    expect(
      validateAnswerDraft({
        content: 'Paraphrase [C1]',
        chunksByCitation: map,
        resolvedTimeRange: range,
        enforceTimeRange: true,
      }).valid,
    ).toBe(false);
    expect(
      validateAnswerDraft({
        content: `Exact source excerpt. [C1]`,
        chunksByCitation: map,
        resolvedTimeRange: range,
        enforceTimeRange: true,
      }).valid,
    ).toBe(true);
  });
});
