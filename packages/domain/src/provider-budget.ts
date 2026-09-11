import { ProviderBudgetError, type ModelProfile, type ProviderBudgetPort } from './model-work.js';
import {
  UnsupportedAiInputError,
  type ChatCompletionRequest,
  type ChatCompletionResult,
  type ChatPort,
  type EmbeddingPort,
  type EmbeddingRequest,
  type EmbeddingResult,
} from './ai.js';

export type BudgetLane = 'chat' | 'query_embedding' | 'ingestion_embedding' | 'search';

export interface PriceRate {
  /** Cost in integer micro-units (or smallest currency unit) per 1,000 tokens. Must be a safe non-negative integer. */
  readonly unitsPerThousandTokens: number;
}

export interface ModelPricingTable {
  readonly [priceVersion: string]: PriceRate;
}

export interface ExecutionCaps {
  readonly maxInputTokens: number;
  readonly maxContextTokens?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
}

export interface BudgetedChatOptions {
  readonly scopeId: string;
  readonly attemptId: string;
  readonly profile: ModelProfile;
  readonly caps: ExecutionCaps;
  readonly priceRate: PriceRate;
  readonly now?: Date;
  /** Optional conservative reservation, e.g. a UTF-8 upper bound for release evaluation. */
  readonly inputTokenUpperBound?: number;
}

export interface BudgetedEmbeddingOptions {
  readonly scopeId: string;
  readonly attemptId: string;
  readonly profile: ModelProfile;
  readonly lane: 'query_embedding' | 'ingestion_embedding';
  readonly caps: ExecutionCaps;
  readonly priceRate: PriceRate;
  readonly now?: Date;
  readonly inputTokenUpperBound?: number;
}

export interface ProviderBudgetService {
  readonly budgetPort: ProviderBudgetPort;

  executeChatWithBudget(
    chatPort: ChatPort,
    request: ChatCompletionRequest,
    options: BudgetedChatOptions,
  ): Promise<ChatCompletionResult>;

  executeQueryEmbeddingWithBudget(
    embeddingPort: EmbeddingPort,
    request: EmbeddingRequest,
    options: BudgetedEmbeddingOptions,
  ): Promise<EmbeddingResult>;
}

export function assertValidModelProfile(profile: ModelProfile): void {
  if (!profile || typeof profile !== 'object') {
    throw new ProviderBudgetError('invalid_usage');
  }
  if (
    !profile.provider ||
    typeof profile.provider !== 'string' ||
    profile.provider.trim().length === 0 ||
    !profile.model ||
    typeof profile.model !== 'string' ||
    profile.model.trim().length === 0 ||
    !profile.version ||
    typeof profile.version !== 'string' ||
    profile.version.trim().length === 0 ||
    !profile.priceVersion ||
    typeof profile.priceVersion !== 'string' ||
    profile.priceVersion.trim().length === 0 ||
    !profile.tokenizerVersion ||
    typeof profile.tokenizerVersion !== 'string' ||
    profile.tokenizerVersion.trim().length === 0 ||
    !profile.approvalReference ||
    typeof profile.approvalReference !== 'string' ||
    profile.approvalReference.trim().length === 0
  ) {
    throw new ProviderBudgetError('approval_required');
  }
  if (
    !Number.isSafeInteger(profile.dimensions) ||
    profile.dimensions < 1 ||
    profile.dimensions > 16000
  ) {
    throw new ProviderBudgetError('invalid_usage');
  }
}

export function assertValidBudgetCaps(caps: ExecutionCaps): void {
  if (!caps || typeof caps !== 'object') {
    throw new ProviderBudgetError('approval_required');
  }
  if (!Number.isSafeInteger(caps.maxInputTokens) || caps.maxInputTokens <= 0) {
    throw new ProviderBudgetError('approval_required');
  }
  if (
    caps.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(caps.maxOutputTokens) || caps.maxOutputTokens <= 0)
  ) {
    throw new ProviderBudgetError('approval_required');
  }
  if (
    caps.maxContextTokens !== undefined &&
    (!Number.isSafeInteger(caps.maxContextTokens) || caps.maxContextTokens <= 0)
  ) {
    throw new ProviderBudgetError('approval_required');
  }
  if (
    caps.timeoutMs !== undefined &&
    (!Number.isSafeInteger(caps.timeoutMs) || caps.timeoutMs <= 0)
  ) {
    throw new ProviderBudgetError('invalid_usage');
  }
}

export function assertValidPriceRate(priceRate: PriceRate): void {
  if (!priceRate || typeof priceRate !== 'object') {
    throw new ProviderBudgetError('approval_required');
  }
  if (
    !Number.isSafeInteger(priceRate.unitsPerThousandTokens) ||
    priceRate.unitsPerThousandTokens < 0
  ) {
    throw new ProviderBudgetError('invalid_usage');
  }
}

export function estimateTokenCount(text: string, tokenizerVersion?: string): number {
  if (tokenizerVersion !== undefined && tokenizerVersion.trim().length === 0) {
    throw new ProviderBudgetError('invalid_usage');
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return Math.ceil(trimmed.split(/\s+/u).length * 1.2);
}

export function calculateTokenUnits(tokens: number, priceRate: PriceRate): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new ProviderBudgetError('invalid_usage');
  }
  assertValidPriceRate(priceRate);
  if (tokens === 0) return 0;
  const calculated = Math.ceil((tokens * priceRate.unitsPerThousandTokens) / 1000);
  return calculated > 0 ? calculated : 1;
}

function reservedInputTokens(text: string, profile: ModelProfile, upperBound?: number): number {
  const estimated = estimateTokenCount(text, profile.tokenizerVersion);
  if (upperBound === undefined) return estimated;
  if (!Number.isSafeInteger(upperBound) || upperBound < estimated) {
    throw new ProviderBudgetError('invalid_usage');
  }
  return upperBound;
}

async function executeChatWithBudget(
  budgetPort: ProviderBudgetPort,
  chatPort: ChatPort,
  request: ChatCompletionRequest,
  options: BudgetedChatOptions,
): Promise<ChatCompletionResult> {
  assertValidModelProfile(options.profile);
  assertValidBudgetCaps(options.caps);
  assertValidPriceRate(options.priceRate);

  if (!options.scopeId || options.scopeId.trim().length === 0) {
    throw new ProviderBudgetError('approval_required');
  }
  if (!options.attemptId || options.attemptId.trim().length === 0) {
    throw new ProviderBudgetError('invalid_usage');
  }

  if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
    throw new UnsupportedAiInputError('chat messages must contain non-empty content');
  }

  const inputText = request.messages.map((m) => `${m.role}:${m.content}`).join('\n');
  if (inputText.trim().length === 0) {
    throw new UnsupportedAiInputError('chat messages must contain non-empty content');
  }

  const inputTokens = reservedInputTokens(inputText, options.profile, options.inputTokenUpperBound);
  if (inputTokens > options.caps.maxInputTokens) {
    throw new ProviderBudgetError('invalid_usage');
  }
  if (options.caps.maxContextTokens && inputTokens > options.caps.maxContextTokens) {
    throw new ProviderBudgetError('invalid_usage');
  }

  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)
  ) {
    throw new ProviderBudgetError('invalid_usage');
  }
  // Inner budgeting must never widen a stricter caller/release reservation.
  const outputCap = options.caps.maxOutputTokens ?? 4096;
  const maxOutputTokens = Math.min(request.maxOutputTokens ?? outputCap, outputCap);
  const maxTokens = inputTokens + maxOutputTokens;
  const maxUnits = calculateTokenUnits(maxTokens, options.priceRate);
  const now = options.now ?? new Date();

  // 1. Reserve budget
  const reservation = await budgetPort.reserve(
    options.scopeId,
    options.attemptId,
    'chat',
    maxUnits,
    maxTokens,
    now,
  );

  // 2. Execute call
  let result: ChatCompletionResult;
  try {
    const timeout = options.caps.timeoutMs ?? request.timeoutMs;
    result = await chatPort.complete({
      ...request,
      model: options.profile.model,
      maxOutputTokens,
      ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
    });
  } catch (error) {
    await budgetPort.holdUnknown(reservation.id, now);
    throw error;
  }

  // 3. Validate usage and settle
  const usage = result.metadata?.usage;
  if (
    !usage ||
    !Number.isSafeInteger(usage.totalTokens) ||
    usage.totalTokens < 0 ||
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0
  ) {
    await budgetPort.holdUnknown(reservation.id, now);
    throw new ProviderBudgetError('invalid_usage');
  }

  const actualTokens = usage.totalTokens;
  const actualUnits = calculateTokenUnits(actualTokens, options.priceRate);

  await budgetPort.settle(reservation.id, actualUnits, actualTokens, now);
  return result;
}

async function executeQueryEmbeddingWithBudget(
  budgetPort: ProviderBudgetPort,
  embeddingPort: EmbeddingPort,
  request: EmbeddingRequest,
  options: BudgetedEmbeddingOptions,
): Promise<EmbeddingResult> {
  assertValidModelProfile(options.profile);
  assertValidBudgetCaps(options.caps);
  assertValidPriceRate(options.priceRate);

  if (!options.scopeId || options.scopeId.trim().length === 0) {
    throw new ProviderBudgetError('approval_required');
  }
  if (!options.attemptId || options.attemptId.trim().length === 0) {
    throw new ProviderBudgetError('invalid_usage');
  }

  if (!request.input || request.input.trim().length === 0) {
    throw new UnsupportedAiInputError('embedding input must be non-empty');
  }

  const inputTokens = reservedInputTokens(
    request.input,
    options.profile,
    options.inputTokenUpperBound,
  );
  if (inputTokens > options.caps.maxInputTokens) {
    throw new ProviderBudgetError('invalid_usage');
  }
  if (options.caps.maxContextTokens && inputTokens > options.caps.maxContextTokens) {
    throw new ProviderBudgetError('invalid_usage');
  }

  const maxTokens = inputTokens;
  const maxUnits = calculateTokenUnits(maxTokens, options.priceRate);
  const now = options.now ?? new Date();

  // 1. Reserve budget
  const reservation = await budgetPort.reserve(
    options.scopeId,
    options.attemptId,
    options.lane,
    maxUnits,
    maxTokens,
    now,
  );

  // 2. Execute call
  let result: EmbeddingResult;
  try {
    const timeout = options.caps.timeoutMs ?? request.timeoutMs;
    result = await embeddingPort.embed({
      ...request,
      model: options.profile.model,
      ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
    });
  } catch (error) {
    await budgetPort.holdUnknown(reservation.id, now);
    throw error;
  }

  // 3. Validate vector
  const vector = result.vector;
  const isValidVector =
    Array.isArray(vector) &&
    vector.length === options.profile.dimensions &&
    vector.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    vector.some((v) => v !== 0);

  if (!isValidVector) {
    await budgetPort.holdUnknown(reservation.id, now);
    throw new ProviderBudgetError('invalid_usage');
  }

  // 4. Settle
  const usage = result.metadata.usage;
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.totalTokens) ||
    usage.totalTokens !== usage.inputTokens ||
    usage.totalTokens > maxTokens
  ) {
    await budgetPort.holdUnknown(reservation.id, now);
    throw new ProviderBudgetError('invalid_usage');
  }
  const actualTokens = usage.totalTokens;
  const actualUnits = calculateTokenUnits(actualTokens, options.priceRate);
  await budgetPort.settle(reservation.id, actualUnits, actualTokens, now);
  return result;
}

export function createProviderBudgetService(budgetPort: ProviderBudgetPort): ProviderBudgetService {
  return {
    budgetPort,
    executeChatWithBudget: (chatPort, request, options) =>
      executeChatWithBudget(budgetPort, chatPort, request, options),
    executeQueryEmbeddingWithBudget: (embeddingPort, request, options) =>
      executeQueryEmbeddingWithBudget(budgetPort, embeddingPort, request, options),
  };
}
