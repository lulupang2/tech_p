/** Provider-neutral contracts for chat completion and text embeddings. */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface AiRequestOptions {
  /** Provider-independent per-call deadline in milliseconds. */
  readonly timeoutMs?: number;
  /** Cancellation is advisory; adapters must reject promptly when aborted. */
  readonly signal?: AbortSignal;
}

export interface ChatCompletionRequest extends AiRequestOptions {
  readonly messages: readonly ChatMessage[];
  readonly model?: string;
  readonly responseFormat?: 'json_object';
  readonly maxOutputTokens?: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ChatCompletionMetadata {
  readonly model: string;
  readonly usage: TokenUsage;
  readonly latencyMs: number;
}

export interface ChatCompletionResult {
  readonly content: string;
  readonly metadata: ChatCompletionMetadata;
}

export interface ChatPort {
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}

export interface EmbeddingRequest extends AiRequestOptions {
  readonly input: string;
  readonly model?: string;
}

export interface EmbeddingMetadata {
  readonly model: string;
  readonly dimensions: number;
  readonly latencyMs: number;
  readonly usage: Pick<TokenUsage, 'inputTokens' | 'totalTokens'>;
}

export interface EmbeddingResult {
  readonly vector: readonly number[];
  readonly metadata: EmbeddingMetadata;
}

export interface EmbeddingPort {
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
  embedMany(requests: readonly EmbeddingRequest[]): Promise<readonly EmbeddingResult[]>;
}

export type AiErrorKind = 'timeout' | 'rate_limited' | 'unsupported_input' | 'provider_error';
export interface AiErrorMetadata {
  readonly model: string;
  readonly latencyMs: number;
  readonly dimensions?: number;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens?: number;
    readonly totalTokens: number;
  };
}
/** Compatibility names for adapters that refer to provider ports directly. */
export type ChatRequest = ChatCompletionRequest;
export type ChatResponse = ChatCompletionResult;
export type ChatProvider = ChatPort;
export type EmbeddingProvider = EmbeddingPort;

export class AiPortError extends Error {
  readonly kind: AiErrorKind;
  readonly retryable: boolean;
  readonly metadata: AiErrorMetadata | undefined;

  constructor(
    kind: AiErrorKind,
    message: string,
    options: { readonly retryable: boolean; readonly metadata: AiErrorMetadata | undefined },
  ) {
    super(message);
    this.name = 'AiPortError';
    this.kind = kind;
    this.retryable = options.retryable;
    this.metadata = options.metadata;
  }
}

export class AiTimeoutError extends AiPortError {
  constructor(message = 'AI request timed out', metadata?: AiErrorMetadata) {
    super('timeout', message, { retryable: true, metadata });
    this.name = 'AiTimeoutError';
  }
}

export class UnsupportedAiInputError extends AiPortError {
  constructor(message: string) {
    super('unsupported_input', message, { retryable: false, metadata: undefined });
    this.name = 'UnsupportedAiInputError';
  }
}

export class AiProviderError extends AiPortError {
  constructor(
    message = 'AI provider request failed',
    metadata?: AiErrorMetadata,
    cause?: unknown,
    retryable = true,
  ) {
    super('provider_error', message, { retryable, metadata });
    this.name = 'AiProviderError';
    if (cause !== undefined) this.cause = cause;
  }
}

export class AiRateLimitError extends AiPortError {
  readonly retryAfterMs: number | undefined;

  constructor(metadata?: AiErrorMetadata, retryAfterMs?: number) {
    super('rate_limited', 'AI provider rate limit exceeded', {
      retryable: true,
      metadata,
    });
    this.name = 'AiRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

function providerError(failure: Error, metadata: AiErrorMetadata): AiProviderError {
  return new AiProviderError('AI provider request failed', metadata, failure);
}

export interface DeterministicChatOptions {
  readonly response?: string;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly usage?: TokenUsage;
  readonly failWith?: Error;
}

export interface DeterministicChatPort extends ChatPort {
  readonly calls: readonly ChatCompletionRequest[];
  reset(): void;
}

function assertTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) {
    throw new RangeError('timeoutMs must be a positive integer');
  }
}
function waitForLatency(
  latencyMs: number,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  metadata: AiErrorMetadata,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(delayTimer);
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void => finish(new AiTimeoutError('AI request was aborted', metadata));
    const delayTimer = setTimeout(() => finish(), latencyMs);
    const timeoutTimer = setTimeout(
      () => finish(new AiTimeoutError('AI request timed out', metadata)),
      timeoutMs ?? latencyMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function inputText(messages: readonly ChatMessage[]): string {
  return messages.map(({ role, content }) => `${role}:${content}`).join('\n');
}

function tokenCount(value: string): number {
  const trimmed = value.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}

function validateMessages(messages: readonly ChatMessage[]): void {
  if (messages.length === 0 || messages.some(({ content }) => content.trim().length === 0)) {
    throw new UnsupportedAiInputError('chat messages must contain non-empty content');
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/u.test(value.trim())) return Number(value.trim()) * 1000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

export function createDeterministicChatPort(
  options: DeterministicChatOptions = {},
): DeterministicChatPort {
  const response = options.response ?? 'deterministic fake response';
  const model = options.model ?? 'fake-chat-v1';
  const latencyMs = options.latencyMs ?? 0;
  if (!Number.isInteger(latencyMs) || latencyMs < 0)
    throw new RangeError('latencyMs must be non-negative');
  const calls: ChatCompletionRequest[] = [];
  return {
    calls,
    complete: async (request) => {
      validateMessages(request.messages);
      assertTimeout(request.timeoutMs);
      calls.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
      const metadata = { model, latencyMs };
      await waitForLatency(latencyMs, request.signal, request.timeoutMs, metadata);
      if (options.failWith !== undefined) throw providerError(options.failWith, metadata);
      const input = inputText(request.messages);
      const usage = options.usage ?? {
        inputTokens: tokenCount(input),
        outputTokens: tokenCount(response),
        totalTokens: tokenCount(input) + tokenCount(response),
      };
      return { content: response, metadata: { ...metadata, usage } };
    },
    reset: () => calls.splice(0),
  };
}

export interface DeterministicEmbeddingOptions {
  readonly dimensions?: number;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly failWith?: Error;
}

export interface DeterministicEmbeddingPort extends EmbeddingPort {
  readonly calls: readonly EmbeddingRequest[];
  reset(): void;
}

function hash(input: string, index: number): number {
  let value = (2166136261 ^ index) >>> 0;
  for (let i = 0; i < input.length; i += 1)
    value = Math.imul(value ^ input.charCodeAt(i), 16777619) >>> 0;
  return value;
}

export function createDeterministicEmbeddingPort(
  options: DeterministicEmbeddingOptions = {},
): DeterministicEmbeddingPort {
  const dimensions = options.dimensions ?? 8;
  const model = options.model ?? 'fake-embedding-v1';
  const latencyMs = options.latencyMs ?? 0;
  if (!Number.isInteger(dimensions) || dimensions < 1)
    throw new RangeError('dimensions must be a positive integer');
  if (!Number.isInteger(latencyMs) || latencyMs < 0)
    throw new RangeError('latencyMs must be non-negative');
  const calls: EmbeddingRequest[] = [];
  const embed = async (request: EmbeddingRequest): Promise<EmbeddingResult> => {
    if (request.input.trim().length === 0)
      throw new UnsupportedAiInputError('embedding input must be non-empty');
    assertTimeout(request.timeoutMs);
    calls.push({ ...request });
    const inputTokens = tokenCount(request.input);
    const metadata = {
      model,
      dimensions,
      latencyMs,
      usage: { inputTokens, totalTokens: inputTokens },
    };
    await waitForLatency(latencyMs, request.signal, request.timeoutMs, metadata);
    if (options.failWith !== undefined) throw providerError(options.failWith, metadata);
    const vector = Array.from(
      { length: dimensions },
      (_, i) => (hash(request.input, i) / 0xffffffff) * 2 - 1,
    );
    return { vector, metadata };
  };
  return {
    calls,
    embed,
    embedMany: async (requests) => {
      const results: EmbeddingResult[] = [];
      for (const request of requests) results.push(await embed(request));
      return results;
    },
    reset: () => calls.splice(0),
  };
}

export interface OpenAiCompatibleChatOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly defaultTimeoutMs?: number;
  readonly temperature?: number;
  readonly requireJsonObject?: boolean;
  readonly fetchFn?: typeof fetch;
}

export function createOpenAiCompatibleChatPort(options: OpenAiCompatibleChatOptions): ChatPort {
  const apiKey = options.apiKey;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('apiKey is required for OpenAiCompatibleChatPort');
  }
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/u, '');
  const defaultModel = options.model ?? 'gpt-4o-mini';
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const temperature = options.temperature ?? 0.2;
  const requireJsonObject = options.requireJsonObject ?? true;

  return {
    async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
      validateMessages(request.messages);
      assertTimeout(request.timeoutMs);

      const model = request.model ?? defaultModel;
      const timeoutMs = request.timeoutMs ?? options.defaultTimeoutMs;
      const url = `${baseUrl}/chat/completions`;

      const controller = new AbortController();
      let timeoutId: NodeJS.Timeout | undefined;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      }
      const onAbort = (): void => controller.abort();
      if (request.signal) {
        request.signal.addEventListener('abort', onAbort, { once: true });
        if (request.signal.aborted) controller.abort();
      }

      const start = Date.now();
      try {
        const response = await fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
            temperature,
            ...(requireJsonObject || request.responseFormat === 'json_object'
              ? { response_format: { type: 'json_object' } }
              : {}),
            ...(request.maxOutputTokens !== undefined
              ? { max_tokens: request.maxOutputTokens }
              : {}),
          }),
          signal: controller.signal,
        });

        const latencyMs = Date.now() - start;
        const metadata: AiErrorMetadata = { model, latencyMs };

        if (response.status === 408 || response.status === 504) {
          throw new AiTimeoutError('AI request timed out at upstream provider', metadata);
        }

        if (response.status === 429) {
          throw new AiRateLimitError(
            metadata,
            parseRetryAfterMs(response.headers.get('retry-after')),
          );
        }

        if (!response.ok) {
          throw new AiProviderError(
            `AI provider returned HTTP ${response.status}`,
            metadata,
            undefined,
            response.status >= 500,
          );
        }

        const rawData: unknown = await response.json();
        let content = '';
        let promptTokens = 0;
        let completionTokens = 0;
        let totalTokens = 0;
        let hasUsage = false;
        let responseModel = model;

        if (typeof rawData === 'object' && rawData !== null) {
          const dataObj = rawData as Record<string, unknown>;
          if (typeof dataObj['model'] === 'string') {
            responseModel = dataObj['model'];
          }
          if (Array.isArray(dataObj['choices']) && dataObj['choices'].length > 0) {
            const firstChoice = dataObj['choices'][0];
            if (typeof firstChoice === 'object' && firstChoice !== null) {
              const choiceObj = firstChoice as Record<string, unknown>;
              if (typeof choiceObj['message'] === 'object' && choiceObj['message'] !== null) {
                const messageObj = choiceObj['message'] as Record<string, unknown>;
                if (typeof messageObj['content'] === 'string') {
                  content = messageObj['content'];
                }
              }
            }
          }
          if (typeof dataObj['usage'] === 'object' && dataObj['usage'] !== null) {
            hasUsage = true;
            const usageObj = dataObj['usage'] as Record<string, unknown>;
            if (typeof usageObj['prompt_tokens'] === 'number')
              promptTokens = usageObj['prompt_tokens'];
            if (typeof usageObj['completion_tokens'] === 'number')
              completionTokens = usageObj['completion_tokens'];
            if (typeof usageObj['total_tokens'] === 'number')
              totalTokens = usageObj['total_tokens'];
          }
        }

        if (!content) {
          throw new AiProviderError('AI provider response missing message content', metadata);
        }

        if (
          !hasUsage ||
          !Number.isSafeInteger(promptTokens) ||
          promptTokens < 0 ||
          !Number.isSafeInteger(completionTokens) ||
          completionTokens < 0 ||
          !Number.isSafeInteger(totalTokens) ||
          totalTokens !== promptTokens + completionTokens
        ) {
          throw new AiProviderError('AI provider response missing valid usage', metadata);
        }
        const usage: TokenUsage = {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          totalTokens,
        };

        return {
          content,
          metadata: {
            model: responseModel,
            usage,
            latencyMs,
          },
        };
      } catch (err: unknown) {
        const latencyMs = Date.now() - start;
        const metadata: AiErrorMetadata = { model, latencyMs };

        if (err instanceof AiPortError) {
          throw err;
        }

        const isAbort =
          controller.signal.aborted ||
          (typeof err === 'object' &&
            err !== null &&
            'name' in err &&
            (err as { name: unknown }).name === 'AbortError');
        if (isAbort) {
          throw new AiTimeoutError('AI request timed out or was aborted', metadata);
        }

        const rawMessage = err instanceof Error ? err.message : 'Unknown provider error';
        const sanitizedMessage = rawMessage.replace(
          new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          '[REDACTED]',
        );
        throw new AiProviderError(`AI provider request failed: ${sanitizedMessage}`, metadata, err);
      } finally {
        clearTimeout(timeoutId);
        if (request.signal) {
          request.signal.removeEventListener('abort', onAbort);
        }
      }
    },
  };
}

export interface OpenAiCompatibleEmbeddingOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly dimensions?: number;
  readonly defaultTimeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  /** Explicit provider response aliases that map to the configured model. */
  readonly acceptedResponseModels?: readonly string[];
}

export function createOpenAiCompatibleEmbeddingPort(
  options: OpenAiCompatibleEmbeddingOptions,
): EmbeddingPort {
  const apiKey = options.apiKey;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('apiKey is required for OpenAiCompatibleEmbeddingPort');
  }
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/u, '');
  const defaultModel = options.model ?? 'text-embedding-3-small';
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const expectedDimensions = options.dimensions;
  const acceptedResponseModels = new Set([defaultModel, ...(options.acceptedResponseModels ?? [])]);

  const embedOne = async (request: EmbeddingRequest): Promise<EmbeddingResult> => {
    if (request.input.trim().length === 0) {
      throw new UnsupportedAiInputError('embedding input must be non-empty');
    }
    assertTimeout(request.timeoutMs);

    const model = request.model ?? defaultModel;
    const timeoutMs = request.timeoutMs ?? options.defaultTimeoutMs;
    const url = `${baseUrl}/embeddings`;

    const controller = new AbortController();
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }
    const onAbort = (): void => controller.abort();
    if (request.signal) {
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (request.signal.aborted) controller.abort();
    }

    const start = Date.now();
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: request.input,
        }),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - start;
      const metadata: AiErrorMetadata = {
        model,
        latencyMs,
        ...(expectedDimensions !== undefined ? { dimensions: expectedDimensions } : {}),
      };
      if (response.status === 408 || response.status === 504) {
        throw new AiTimeoutError('AI request timed out at upstream provider', metadata);
      }

      if (response.status === 429) {
        throw new AiRateLimitError(
          metadata,
          parseRetryAfterMs(response.headers.get('retry-after')),
        );
      }

      if (!response.ok) {
        throw new AiProviderError(
          `AI provider returned HTTP ${response.status}`,
          metadata,
          undefined,
          response.status >= 500,
        );
      }

      const rawData: unknown = await response.json();
      let vector: readonly number[] | undefined;
      let responseModel = model;
      let inputTokens: number | undefined;
      let totalTokens: number | undefined;

      if (typeof rawData === 'object' && rawData !== null) {
        const dataObj = rawData as Record<string, unknown>;
        if (typeof dataObj['model'] === 'string') {
          responseModel = dataObj['model'];
        }
        if (Array.isArray(dataObj['data']) && dataObj['data'].length > 0) {
          const firstData = dataObj['data'][0];
          if (typeof firstData === 'object' && firstData !== null) {
            const itemObj = firstData as Record<string, unknown>;
            if (Array.isArray(itemObj['embedding'])) {
              vector = itemObj['embedding'] as readonly number[];
            }
          }
        }
        if (typeof dataObj['usage'] === 'object' && dataObj['usage'] !== null) {
          const usageObj = dataObj['usage'] as Record<string, unknown>;
          if (typeof usageObj['prompt_tokens'] === 'number')
            inputTokens = usageObj['prompt_tokens'];
          if (typeof usageObj['total_tokens'] === 'number') totalTokens = usageObj['total_tokens'];
        }
      }

      if (!vector || vector.length === 0) {
        throw new AiProviderError('AI provider response missing data[0].embedding', metadata);
      }
      if (!acceptedResponseModels.has(responseModel)) {
        throw new AiProviderError('AI provider response model mismatch', metadata);
      }
      if (
        !Number.isSafeInteger(inputTokens) ||
        (inputTokens ?? -1) < 0 ||
        !Number.isSafeInteger(totalTokens) ||
        totalTokens !== inputTokens
      ) {
        throw new AiProviderError('AI provider response missing valid usage', metadata);
      }
      if (expectedDimensions !== undefined && vector.length !== expectedDimensions) {
        throw new AiProviderError('AI provider response dimensions mismatch', metadata);
      }

      const billedInputTokens = inputTokens as number;
      const billedTotalTokens = totalTokens as number;
      return {
        vector,
        metadata: {
          model,
          dimensions: vector.length,
          latencyMs,
          usage: { inputTokens: billedInputTokens, totalTokens: billedTotalTokens },
        },
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      const metadata: AiErrorMetadata = {
        model,
        latencyMs,
        ...(expectedDimensions !== undefined ? { dimensions: expectedDimensions } : {}),
      };
      if (err instanceof AiPortError) {
        throw err;
      }

      const isAbort =
        controller.signal.aborted ||
        (typeof err === 'object' &&
          err !== null &&
          'name' in err &&
          (err as { name: unknown }).name === 'AbortError');
      if (isAbort) {
        throw new AiTimeoutError('AI request timed out or was aborted', metadata);
      }

      const rawMessage = err instanceof Error ? err.message : 'Unknown provider error';
      const sanitizedMessage = rawMessage.replace(
        new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        '[REDACTED]',
      );
      throw new AiProviderError(`AI provider request failed: ${sanitizedMessage}`, metadata, err);
    } finally {
      clearTimeout(timeoutId);
      if (request.signal) {
        request.signal.removeEventListener('abort', onAbort);
      }
    }
  };

  return {
    embed: embedOne,
    embedMany: async (requests) => {
      const results: EmbeddingResult[] = [];
      for (const req of requests) {
        results.push(await embedOne(req));
      }
      return results;
    },
  };
}
