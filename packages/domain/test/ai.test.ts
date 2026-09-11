import { describe, expect, test, vi } from 'vitest';
import {
  AiProviderError,
  AiRateLimitError,
  AiTimeoutError,
  UnsupportedAiInputError,
  createDeterministicChatPort,
  createDeterministicEmbeddingPort,
  createOpenAiCompatibleChatPort,
  createOpenAiCompatibleEmbeddingPort,
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
    expect(first.metadata).toEqual({
      model: 'test-embed',
      dimensions: 4,
      latencyMs: 0,
      usage: { inputTokens: 2, totalTokens: 2 },
    });
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

describe('OpenAI-compatible HTTP AI ports', () => {
  test('chat completes request with correct headers, payload and parses response', async () => {
    const calls: { url: string; headers: HeadersInit; body: string }[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers as HeadersInit,
        body: String(init?.body),
      });
      return new Response(
        JSON.stringify({
          model: 'custom-model',
          choices: [{ message: { content: 'Answer from OpenAI provider [C1]' } }],
          usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const chat = createOpenAiCompatibleChatPort({
      apiKey: 'secret-key-12345',
      baseUrl: 'https://api.runinfra.com/v1',
      model: 'custom-model',
      fetchFn: fakeFetch,
    });

    const result = await chat.complete({
      messages: [{ role: 'user', content: 'What is Bun?' }],
    });

    expect(result.content).toBe('Answer from OpenAI provider [C1]');
    expect(result.metadata.model).toBe('custom-model');
    expect(result.metadata.usage).toEqual({
      inputTokens: 15,
      outputTokens: 25,
      totalTokens: 40,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.runinfra.com/v1/chat/completions');
    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-key-12345');
    expect(JSON.parse(calls[0]!.body)).toEqual({
      model: 'custom-model',
      messages: [{ role: 'user', content: 'What is Bun?' }],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });
  });

  test('chat port redacts secret API key on network/provider error', async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error('Connection failed to https://api.runinfra.com with key secret-key-12345');
    };

    const chat = createOpenAiCompatibleChatPort({
      apiKey: 'secret-key-12345',
      fetchFn: fakeFetch,
    });

    await expect(
      chat.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrowError();

    try {
      await chat.complete({ messages: [{ role: 'user', content: 'hi' }] });
    } catch (err: unknown) {
      const error = err as Error;
      expect(error.name).toBe('AiProviderError');
      expect(error.message).not.toContain('secret-key-12345');
      expect(error.message).toContain('[REDACTED]');
    }
  });

  test('chat port throws AiTimeoutError on timeout or 504', async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response('Gateway Timeout', { status: 504 });
    };

    const chat = createOpenAiCompatibleChatPort({
      apiKey: 'test-key',
      fetchFn: fakeFetch,
    });

    await expect(
      chat.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(AiTimeoutError);
  });

  test('embedding port embeds input and returns vector with dimensions', async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          model: 'perplexity/pplx-embed-v1-0.6b',
          data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }],
          usage: { prompt_tokens: 2, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const embedding = createOpenAiCompatibleEmbeddingPort({
      apiKey: 'openrouter-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'perplexity/pplx-embed-v1-0.6b',
      dimensions: 4,
      fetchFn: fakeFetch,
    });

    const result = await embedding.embed({ input: 'test text' });
    expect(result.vector).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(result.metadata.dimensions).toBe(4);
    expect(result.metadata.model).toBe('perplexity/pplx-embed-v1-0.6b');
    expect(result.metadata.usage).toEqual({ inputTokens: 2, totalTokens: 2 });
  });

  test('maps an explicitly accepted provider model alias to the configured model', async () => {
    const embedding = createOpenAiCompatibleEmbeddingPort({
      apiKey: 'openrouter-key',
      model: 'perplexity/pplx-embed-v1-0.6b',
      dimensions: 2,
      acceptedResponseModels: ['pplx-embed-v1-0.6b'],
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            model: 'pplx-embed-v1-0.6b',
            data: [{ embedding: [0.1, 0.2] }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const result = await embedding.embed({ input: 'test' });
    expect(result.metadata.model).toBe('perplexity/pplx-embed-v1-0.6b');
  });

  test('rejects a provider model outside the explicit response allowlist', async () => {
    const embedding = createOpenAiCompatibleEmbeddingPort({
      apiKey: 'openrouter-key',
      model: 'perplexity/pplx-embed-v1-0.6b',
      dimensions: 2,
      acceptedResponseModels: ['pplx-embed-v1-0.6b'],
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            model: 'other/model',
            data: [{ embedding: [0.1, 0.2] }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    await expect(embedding.embed({ input: 'test' })).rejects.toMatchObject({
      name: 'AiProviderError',
      message: 'AI provider response model mismatch',
    });
  });

  test('normalizes HTTP 429 and Retry-After without reading provider error bodies', async () => {
    const chat = createOpenAiCompatibleChatPort({
      apiKey: 'rate-secret',
      fetchFn: async () =>
        new Response('sensitive upstream body', {
          status: 429,
          headers: { 'Retry-After': '7' },
        }),
    });

    await expect(
      chat.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({
      name: 'AiRateLimitError',
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 7000,
      message: 'AI provider rate limit exceeded',
    });
    expect(AiRateLimitError).toBeDefined();
  });

  test('rejects successful responses with missing billing usage', async () => {
    const chat = createOpenAiCompatibleChatPort({
      apiKey: 'test-key',
      fetchFn: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await expect(
      chat.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({
      name: 'AiProviderError',
      message: 'AI provider response missing valid usage',
    });
  });
});
