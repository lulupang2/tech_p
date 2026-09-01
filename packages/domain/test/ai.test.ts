import { describe, expect, test, vi } from 'vitest';
import {
  AiProviderError,
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

  test('embedding output is deterministic and reports dimensions/model', async () => {
    const embedding = createDeterministicEmbeddingPort({ dimensions: 4, model: 'test-embed' });
    const request = { input: 'same text' };
    const first = await embedding.embed(request);
    embedding.reset();
    const second = await embedding.embed(request);
    expect(second).toEqual(first);
    expect(first.vector).toHaveLength(4);
    expect(first.metadata).toEqual({ model: 'test-embed', dimensions: 4, latencyMs: 0 });
  });

  test('timeout rejects after deterministic fake latency elapses', async () => {
    vi.useFakeTimers();
    try {
      const chat = createDeterministicChatPort({ latencyMs: 20 });
      const pending = chat.complete({
        messages: [{ role: 'user', content: 'hello' }],
        timeoutMs: 10,
      });
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(10);
      const error = await outcome;
      expect(error).toMatchObject({
        name: 'AiTimeoutError',
        kind: 'timeout',
        retryable: true,
        metadata: { model: 'fake-chat-v1', latencyMs: 20 },
      });
      expect(chat.calls).toHaveLength(1);
      expect(AiTimeoutError).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('abort signal rejects an in-flight request immediately', async () => {
    const controller = new AbortController();
    const embedding = createDeterministicEmbeddingPort({ latencyMs: 30 });
    const pending = embedding.embed({ input: 'abort me', signal: controller.signal });
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    controller.abort();
    const error = await outcome;
    expect(error).toMatchObject({
      name: 'AiTimeoutError',
      kind: 'timeout',
      message: 'AI request was aborted',
    });
  });

  test('unsupported empty inputs fail without network access', async () => {
    const embedding = createDeterministicEmbeddingPort();
    await expect(embedding.embed({ input: '  ' })).rejects.toBeInstanceOf(UnsupportedAiInputError);
    const chat = createDeterministicChatPort();
    await expect(chat.complete({ messages: [] })).rejects.toBeInstanceOf(UnsupportedAiInputError);
  });

  test('provider failures normalize to typed errors with safe metadata', async () => {
    const failure = new Error('provider secret response');
    const embedding = createDeterministicEmbeddingPort({
      failWith: failure,
      model: 'test-embed',
      dimensions: 3,
    });
    await expect(embedding.embed({ input: 'text' })).rejects.toMatchObject({
      name: 'AiProviderError',
      kind: 'provider_error',
      retryable: true,
      message: 'AI provider request failed',
      metadata: { model: 'test-embed', dimensions: 3, latencyMs: 0 },
    });
    expect(AiProviderError).toBeDefined();
  });
});
