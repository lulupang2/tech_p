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
  /** Optional until DEC-007 selects a model. */
  readonly model?: string;
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
}

export interface EmbeddingResult {
  readonly vector: readonly number[];
  readonly metadata: EmbeddingMetadata;
}

export interface EmbeddingPort {
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
  embedMany(requests: readonly EmbeddingRequest[]): Promise<readonly EmbeddingResult[]>;
}

export type AiErrorKind = 'timeout' | 'unsupported_input' | 'provider_error';
export interface AiErrorMetadata {
  readonly model: string;
  readonly latencyMs: number;
  readonly dimensions?: number;
  readonly usage?: TokenUsage;
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
  constructor(message = 'AI provider request failed', metadata?: AiErrorMetadata, cause?: unknown) {
    super('provider_error', message, { retryable: true, metadata });
    this.name = 'AiProviderError';
    if (cause !== undefined) this.cause = cause;
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

export function createDeterministicChatPort(
  options: DeterministicChatOptions = {},
): DeterministicChatPort {
  const response = options.response ?? 'deterministic fake response';
  const model = options.model ?? 'fake-chat-v1';
  const latencyMs = options.latencyMs ?? 0;
  if (!Number.isInteger(latencyMs) || latencyMs < 0) throw new RangeError('latencyMs must be non-negative');
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
  for (let i = 0; i < input.length; i += 1) value = Math.imul(value ^ input.charCodeAt(i), 16777619) >>> 0;
  return value;
}

export function createDeterministicEmbeddingPort(
  options: DeterministicEmbeddingOptions = {},
): DeterministicEmbeddingPort {
  const dimensions = options.dimensions ?? 8;
  const model = options.model ?? 'fake-embedding-v1';
  const latencyMs = options.latencyMs ?? 0;
  if (!Number.isInteger(dimensions) || dimensions < 1) throw new RangeError('dimensions must be a positive integer');
  if (!Number.isInteger(latencyMs) || latencyMs < 0) throw new RangeError('latencyMs must be non-negative');
  const calls: EmbeddingRequest[] = [];
  const embed = async (request: EmbeddingRequest): Promise<EmbeddingResult> => {
    if (request.input.trim().length === 0) throw new UnsupportedAiInputError('embedding input must be non-empty');
    assertTimeout(request.timeoutMs);
    calls.push({ ...request });
    const metadata = { model, dimensions, latencyMs };
    await waitForLatency(latencyMs, request.signal, request.timeoutMs, metadata);
    if (options.failWith !== undefined) throw providerError(options.failWith, metadata);
    const vector = Array.from({ length: dimensions }, (_, i) => (hash(request.input, i) / 0xffffffff) * 2 - 1);
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
