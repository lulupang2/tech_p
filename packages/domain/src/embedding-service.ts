import {
  ProviderBudgetError,
  type EmbeddingWorkKey,
  type EmbeddingWorkPort,
  type ModelProfile,
  type ProviderBudgetPort,
} from './model-work.js';
import {
  assertValidModelProfile,
  assertValidPriceRate,
  calculateTokenUnits,
  estimateTokenCount,
  type ModelPricingTable,
} from './provider-budget.js';
import {
  AiPortError,
  UnsupportedAiInputError,
  type EmbeddingPort,
  type EmbeddingResult,
} from './ai.js';

export interface EmbeddingChunkInput {
  readonly chunkId: string;
  readonly input: string;
  readonly inputHash: string;
}

export interface EmbeddingServiceCaps {
  readonly maxInputTokens: number;
  readonly leaseMs?: number;
  readonly timeoutMs?: number;
}

export interface EmbeddingServiceOptions {
  readonly workPort: EmbeddingWorkPort;
  readonly budgetPort: ProviderBudgetPort;
  readonly embeddingPort: EmbeddingPort;
  readonly scopeId: string;
  readonly priceTable?: ModelPricingTable;
  readonly caps?: EmbeddingServiceCaps;
  readonly now?: () => Date;
}

export type ChunkEmbeddingStatus =
  'completed' | 'reused' | 'in_flight' | 'outcome_unknown' | 'failed';

export interface ChunkEmbeddingResult {
  readonly chunkId: string;
  readonly status: ChunkEmbeddingStatus;
  readonly workId: string | null;
  readonly vector: readonly number[] | null;
  readonly reused: boolean;
  readonly error?: Error;
}

export interface EmbeddingService {
  readonly workPort: EmbeddingWorkPort;
  readonly budgetPort: ProviderBudgetPort;
  readonly embeddingPort: EmbeddingPort;

  processChunk(
    chunk: EmbeddingChunkInput,
    profile: ModelProfile,
    options?: { timeoutMs?: number; signal?: AbortSignal; now?: Date },
  ): Promise<ChunkEmbeddingResult>;

  processBatch(
    chunks: readonly EmbeddingChunkInput[],
    profile: ModelProfile,
    options?: { timeoutMs?: number; signal?: AbortSignal; now?: Date },
  ): Promise<readonly ChunkEmbeddingResult[]>;
}

async function processChunk(
  options: EmbeddingServiceOptions,
  chunk: EmbeddingChunkInput,
  profile: ModelProfile,
  callOptions?: { timeoutMs?: number; signal?: AbortSignal; now?: Date },
): Promise<ChunkEmbeddingResult> {
  const now = callOptions?.now ?? (options.now ? options.now() : new Date());

  // 1. Validate profile, scopeId, caps, priceTable
  assertValidModelProfile(profile);

  if (!options.scopeId || options.scopeId.trim().length === 0) {
    throw new ProviderBudgetError('approval_required');
  }

  const caps = options.caps ?? { maxInputTokens: 8192, leaseMs: 30000 };
  if (!Number.isSafeInteger(caps.maxInputTokens) || caps.maxInputTokens <= 0) {
    throw new ProviderBudgetError('approval_required');
  }

  if (!options.priceTable || !options.priceTable[profile.priceVersion]) {
    throw new ProviderBudgetError('approval_required');
  }
  const priceRate = options.priceTable[profile.priceVersion]!;
  assertValidPriceRate(priceRate);

  if (!chunk || !chunk.chunkId || !chunk.inputHash || typeof chunk.input !== 'string') {
    throw new ProviderBudgetError('invalid_usage');
  }

  if (chunk.input.trim().length === 0) {
    throw new UnsupportedAiInputError('embedding input must be non-empty');
  }

  const estimatedTokens = estimateTokenCount(chunk.input, profile.tokenizerVersion);
  if (estimatedTokens > caps.maxInputTokens) {
    throw new ProviderBudgetError('invalid_usage');
  }

  const leaseMs = caps.leaseMs ?? 30000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) {
    throw new ProviderBudgetError('invalid_usage');
  }

  // 2. Completed reuse or claim work
  const key: EmbeddingWorkKey = {
    chunkId: chunk.chunkId,
    inputHash: chunk.inputHash,
    profile,
  };

  const work = await options.workPort.claimOrReadCompleted(key, now, leaseMs);

  if (work === null) {
    return {
      chunkId: chunk.chunkId,
      status: 'in_flight',
      workId: null,
      vector: null,
      reused: false,
    };
  }

  if (work.state === 'completed') {
    return {
      chunkId: chunk.chunkId,
      status: 'reused',
      workId: work.id,
      vector: work.vector,
      reused: true,
    };
  }

  if (work.state === 'outcome_unknown') {
    return {
      chunkId: chunk.chunkId,
      status: 'outcome_unknown',
      workId: work.id,
      vector: null,
      reused: false,
    };
  }

  if (work.state === 'failed') {
    return {
      chunkId: chunk.chunkId,
      status: 'failed',
      workId: work.id,
      vector: null,
      reused: false,
    };
  }

  if (work.state !== 'claimed') {
    throw new ProviderBudgetError('stale_work');
  }

  // 3. Reserve budget
  // Reserve against the approved hard cap. The tokenizer version is provider-reported,
  // so the deterministic estimate is suitable for preflight rejection but not a safe
  // upper bound for code and markdown. Settlement still uses provider-reported usage.
  const maxTokens = caps.maxInputTokens;
  const maxUnits = calculateTokenUnits(maxTokens, priceRate);
  const attemptId = `${work.id}:${work.epoch}`;

  const reservation = await options.budgetPort.reserve(
    options.scopeId,
    attemptId,
    'ingestion_embedding',
    maxUnits,
    maxTokens,
    now,
  );

  // 4. Begin call
  try {
    await options.workPort.beginCall(work.id, work.epoch, reservation.id, now);
  } catch (beginError) {
    await options.budgetPort.releaseUnsent(reservation.id, now);
    throw beginError;
  }

  // 5. Invoke provider
  let embeddingResult: EmbeddingResult;
  try {
    const timeout = callOptions?.timeoutMs ?? caps.timeoutMs;
    embeddingResult = await options.embeddingPort.embed({
      input: chunk.input,
      model: profile.model,
      ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
      ...(callOptions?.signal !== undefined ? { signal: callOptions.signal } : {}),
    });
  } catch (providerError) {
    if (
      providerError instanceof AiPortError &&
      !providerError.retryable &&
      options.workPort.markFailed
    ) {
      await options.workPort.markFailed(work.id, work.epoch, now);
      await options.budgetPort.releaseUnsent(reservation.id, now);
      return {
        chunkId: chunk.chunkId,
        status: 'failed',
        workId: work.id,
        vector: null,
        reused: false,
        error: providerError,
      };
    }
    await options.workPort.markOutcomeUnknown(work.id, work.epoch, now);
    await options.budgetPort.holdUnknown(reservation.id, now);
    return {
      chunkId: chunk.chunkId,
      status: 'outcome_unknown',
      workId: work.id,
      vector: null,
      reused: false,
      error: providerError instanceof Error ? providerError : new Error(String(providerError)),
    };
  }

  // 6. Validate vector
  const vector = embeddingResult.vector;
  const isValidVector =
    embeddingResult.metadata.model === profile.model &&
    embeddingResult.metadata.dimensions === profile.dimensions &&
    Array.isArray(vector) &&
    vector.length === profile.dimensions &&
    vector.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    vector.some((v) => v !== 0);

  if (!isValidVector) {
    await options.workPort.markOutcomeUnknown(work.id, work.epoch, now);
    await options.budgetPort.holdUnknown(reservation.id, now);
    throw new ProviderBudgetError('invalid_usage');
  }

  // 7. Settle budget & commit work
  const usage = embeddingResult.metadata.usage;
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.totalTokens) ||
    usage.totalTokens !== usage.inputTokens ||
    usage.totalTokens > maxTokens
  ) {
    await options.workPort.markOutcomeUnknown(work.id, work.epoch, now);
    await options.budgetPort.holdUnknown(reservation.id, now);
    throw new ProviderBudgetError('invalid_usage');
  }
  const actualTokens = usage.totalTokens;
  const actualUnits = calculateTokenUnits(actualTokens, priceRate);
  await options.budgetPort.settle(reservation.id, actualUnits, actualTokens, now);

  try {
    await options.workPort.completeWork(work.id, work.epoch, vector, now);
  } catch (completeError) {
    await options.workPort.markOutcomeUnknown(work.id, work.epoch, now);
    return {
      chunkId: chunk.chunkId,
      status: 'outcome_unknown',
      workId: work.id,
      vector: null,
      reused: false,
      error: completeError instanceof Error ? completeError : new Error(String(completeError)),
    };
  }

  return {
    chunkId: chunk.chunkId,
    status: 'completed',
    workId: work.id,
    vector,
    reused: false,
  };
}

async function processBatch(
  options: EmbeddingServiceOptions,
  chunks: readonly EmbeddingChunkInput[],
  profile: ModelProfile,
  callOptions?: { timeoutMs?: number; signal?: AbortSignal; now?: Date },
): Promise<readonly ChunkEmbeddingResult[]> {
  const results: ChunkEmbeddingResult[] = [];
  for (const chunk of chunks) {
    try {
      const result = await processChunk(options, chunk, profile, callOptions);
      results.push(result);
    } catch (error) {
      results.push({
        chunkId: chunk.chunkId,
        status: 'failed',
        workId: null,
        vector: null,
        reused: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return results;
}

export function createEmbeddingService(options: EmbeddingServiceOptions): EmbeddingService {
  return {
    workPort: options.workPort,
    budgetPort: options.budgetPort,
    embeddingPort: options.embeddingPort,
    processChunk: (chunk, profile, callOptions) =>
      processChunk(options, chunk, profile, callOptions),
    processBatch: (chunks, profile, callOptions) =>
      processBatch(options, chunks, profile, callOptions),
  };
}
