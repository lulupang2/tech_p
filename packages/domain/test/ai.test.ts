import { describe, expect, test } from 'vitest';
import {
  AiTimeoutError,
  UnsupportedAiInputError,
  createDeterministicChatPort,
  createDeterministicEmbeddingPort,
} from '../src/index.js';

describe('provider-neutral deterministic AI ports', () => {
  test('chat returns content plus model, usage, and latency metadata', async () => {
    const chat = createDeterministicChatPort({ response: 'grounded answer', model: 'test-chat' });
    const result = await chat.complete({ messages: [{ role: 'user', content: 'hello world' }] });
    expect(result).toEqual({
      content: 'grounded answer',
      metadata: {
        model: 'test-chat',
        latencyMs: 0,
        usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
      },
    });
  });

  test('embedding is deterministic and reports dimensions/model', async () => {
    const embedding = createDeterministicEmbeddingPort({ dimensions: 4, model: 'test-embed' });
    const request = { input: 'same text' };
    const first = await embedding.embed(request);
    embedding.reset();
    const second = await embedding.embed(request);
    expect(second).toEqual(first);
    expect(first.vector).toHaveLength(4);
    expect(first.metadata).toEqual({ model: 'test-embed', dimensions: 4, latencyMs: 0 });
  });

  test('fake timeout is explicit and retryable', async () => {
    const chat = createDeterministicChatPort({ latencyMs: 20 });
    await expect(
      chat.complete({ messages: [{ role: 'user', content: 'hello' }], timeoutMs: 10 }),
    ).rejects.toMatchObject({ name: 'AiTimeoutError', kind: 'timeout', retryable: true });
    expect(chat.calls).toHaveLength(1);
    expect(AiTimeoutError).toBeDefined();
  });

  test('unsupported empty inputs fail without network access', async () => {
    const embedding = createDeterministicEmbeddingPort();
    await expect(embedding.embed({ input: '  ' })).rejects.toBeInstanceOf(UnsupportedAiInputError);
    const chat = createDeterministicChatPort();
    await expect(chat.complete({ messages: [] })).rejects.toBeInstanceOf(UnsupportedAiInputError);
  });

  test('provider failures pass through without exposing provider SDK types', async () => {
    const failure = new Error('offline failure');
    const embedding = createDeterministicEmbeddingPort({ failWith: failure });
    await expect(embedding.embed({ input: 'text' })).rejects.toBe(failure);
  });
});
