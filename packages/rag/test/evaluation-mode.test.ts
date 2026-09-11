import { describe, expect, test } from 'vitest';
import {
  createDeterministicChatPort,
  type EmbeddingPort,
  type SearchHit,
  type SearchServicePort,
} from '@techpulse/domain';
import { createAnswerService, DatabaseRetrievalError } from '../src/answer-service.js';

const hit: SearchHit = {
  chunkId: 'eval-chunk',
  documentId: 'eval-document',
  documentRevisionId: 'eval-revision',
  title: 'Playwright release',
  content: 'Playwright release evidence.',
  headingPath: ['github_releases'],
  sourceKey: 'github_releases',
  score: 1,
  publishedAt: new Date('2026-09-01T00:00:00Z'),
};

describe('EVAL-002 strict retrieval execution', () => {
  test.each([true, false])('embedding fallback allowed=%s', async (allowed) => {
    let embeddingCalls = 0;
    let vectorCalls = 0;
    const embeddingPort: EmbeddingPort = {
      async embed() {
        embeddingCalls += 1;
        throw new Error('fixture provider failure');
      },
      async embedMany() {
        throw new Error('batch forbidden');
      },
    };
    const chatPort = createDeterministicChatPort({
      response: '{"answer":"Release evidence [C1]."}',
    });
    const searchService: SearchServicePort = {
      searchFts: async () => [hit],
      searchExactVector: async () => {
        vectorCalls += 1;
        return [hit];
      },
    };
    const service = createAnswerService({
      searchService,
      chatPort,
      embeddingPort,
      maxValidationRetries: 0,
      ...(allowed ? {} : { allowEmbeddingFallback: false }),
      now: () => new Date('2026-09-10T03:50:22Z'),
    });
    const result = service.generateAnswer({
      question: 'Playwright release',
      requestId: 'eval-strict',
    });
    if (allowed) {
      expect((await result).status).toBe('answered');
      expect(chatPort.calls).toHaveLength(1);
    } else {
      await expect(result).rejects.toBeInstanceOf(DatabaseRetrievalError);
      expect(chatPort.calls).toHaveLength(0);
    }
    expect(embeddingCalls).toBe(1);
    expect(vectorCalls).toBe(0);
  });

  test('strict evaluation never repeats lexical queries after an empty result', async () => {
    let searches = 0;
    const chatPort = createDeterministicChatPort();
    const service = createAnswerService({
      searchService: {
        searchFts: async () => {
          searches += 1;
          return [];
        },
        searchExactVector: async () => [],
      },
      chatPort,
      allowLexicalFallback: false,
      maxValidationRetries: 0,
      now: () => new Date('2026-09-10T03:50:22Z'),
    });
    const result = await service.generateAnswer({
      question: 'Playwright latest release update',
      requestId: 'eval-no-lexical-retry',
    });
    expect(result.status).toBe('insufficient_evidence');
    expect(searches).toBe(1);
    expect(chatPort.calls).toHaveLength(0);
  });
});
