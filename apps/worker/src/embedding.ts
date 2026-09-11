import { createHash } from 'node:crypto';
import {
  ProviderBudgetError,
  createEmbeddingService,
  createOpenAiCompatibleEmbeddingPort,
  type ChunkRepositoryPort,
  type CollectionStatePort,
  type DocumentRepositoryPort,
  type EmbeddingPort,
  type EmbeddingService,
  type EmbeddingWorkPort,
  type ModelPricingTable,
  type ModelProfile,
  type ProviderBudgetPort,
} from '@techpulse/domain';
import type { StructuredLogger } from '@techpulse/observability';
import type { WorkerEmbeddingConfig } from './config.js';
import type { EmbeddingDeliveryHandler } from './partition-runtime.js';

export interface CreateWorkerEmbeddingServiceOptions {
  readonly config: WorkerEmbeddingConfig;
  readonly allowFixtureProviders?: boolean | undefined;
  readonly workPort: EmbeddingWorkPort;
  readonly budgetPort: ProviderBudgetPort;
  readonly embeddingPort?: EmbeddingPort | undefined;
  readonly profile?: ModelProfile | undefined;
  readonly scopeId?: string | undefined;
  readonly pricingTable?: ModelPricingTable | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * Creates the EmbeddingService for the worker runtime with fail-closed gates.
 * Explicit injected EmbeddingPort is required for fake/deterministic test fixtures.
 * Credentials never imply approval: full model profile, approvalReference, scopeId,
 * priceVersion, tokenizerVersion, dimensions, and matching pricingTable are strictly required.
 * Automatic live adapter selection based on key or fixture flag is prohibited.
 */
export function createWorkerEmbeddingService(
  options: CreateWorkerEmbeddingServiceOptions,
): { embeddingService: EmbeddingService; profile: ModelProfile } | undefined {
  const { config, allowFixtureProviders = false, workPort, budgetPort } = options;

  let profile: ModelProfile;
  if (options.profile) {
    profile = options.profile;
  } else {
    if (
      !config.provider ||
      !config.model ||
      !config.version ||
      !config.dimensions ||
      !config.priceVersion ||
      !config.tokenizerVersion ||
      !config.approvalReference
    ) {
      return undefined;
    }
    profile = {
      provider: config.provider.trim(),
      model: config.model.trim(),
      version: config.version.trim(),
      dimensions: config.dimensions,
      priceVersion: config.priceVersion.trim(),
      tokenizerVersion: config.tokenizerVersion.trim(),
      approvalReference: config.approvalReference.trim(),
    };
  }

  // Strictly validate profile fields (fail-closed)
  if (
    typeof profile.provider !== 'string' ||
    profile.provider.trim().length === 0 ||
    typeof profile.model !== 'string' ||
    profile.model.trim().length === 0 ||
    typeof profile.version !== 'string' ||
    profile.version.trim().length === 0 ||
    typeof profile.priceVersion !== 'string' ||
    profile.priceVersion.trim().length === 0 ||
    typeof profile.tokenizerVersion !== 'string' ||
    profile.tokenizerVersion.trim().length === 0 ||
    typeof profile.approvalReference !== 'string' ||
    profile.approvalReference.trim().length === 0 ||
    !Number.isSafeInteger(profile.dimensions) ||
    profile.dimensions < 1 ||
    profile.dimensions > 16000
  ) {
    return undefined;
  }

  const scopeId = (options.scopeId ?? config.scopeId)?.trim();
  if (!scopeId || scopeId.length === 0) {
    return undefined;
  }

  const priceTable =
    options.pricingTable ??
    (profile.provider === 'openrouter-perplexity' &&
    profile.model === 'perplexity/pplx-embed-v1-0.6b' &&
    profile.dimensions === 1024 &&
    profile.priceVersion === 'openrouter-pplx-embed-2026-09-10' &&
    profile.approvalReference === 'DEC-007-2026-09-10'
      ? { [profile.priceVersion]: { unitsPerThousandTokens: 4 } }
      : undefined);
  if (!priceTable || !priceTable[profile.priceVersion]) {
    return undefined;
  }
  const priceRate = priceTable[profile.priceVersion];
  if (
    !priceRate ||
    typeof priceRate !== 'object' ||
    !Number.isSafeInteger(priceRate.unitsPerThousandTokens) ||
    priceRate.unitsPerThousandTokens < 0
  ) {
    return undefined;
  }

  let embeddingPort = options.embeddingPort;

  if (!embeddingPort) {
    if (allowFixtureProviders) {
      // In fixture mode, never construct a live adapter from a key and never construct an un-injected fake.
      // Fake model ports must be explicitly injected.
      return undefined;
    }

    // Live production path
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      return undefined;
    }

    if (config.baseUrl?.trim() !== 'https://openrouter.ai/api/v1') {
      return undefined;
    }

    // Deterministic or fixture providers in live mode are rejected
    if (profile.provider === 'deterministic' || profile.provider === 'fixture') {
      return undefined;
    }

    embeddingPort = createOpenAiCompatibleEmbeddingPort({
      apiKey: config.apiKey.trim(),
      ...(config.baseUrl ? { baseUrl: config.baseUrl.trim() } : {}),
      model: profile.model,
      dimensions: profile.dimensions,
      acceptedResponseModels: ['pplx-embed-v1-0.6b'],
    });
  }

  const embeddingService = createEmbeddingService({
    workPort,
    budgetPort,
    embeddingPort,
    scopeId,
    priceTable,
    caps: {
      maxInputTokens: 8192,
      leaseMs: 30000,
    },
    ...(options.now ? { now: options.now } : {}),
  });

  return { embeddingService, profile };
}

export interface WorkerEmbeddingHandlerOptions {
  readonly stateRepository: CollectionStatePort;
  readonly embeddingService?: EmbeddingService | undefined;
  readonly chunkRepository: ChunkRepositoryPort;
  readonly documentRepository?: DocumentRepositoryPort | undefined;
  readonly profile?: ModelProfile | undefined;
  readonly logger?: StructuredLogger | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * Creates the durable v2 embedding delivery handler.
 * Validates model/budget gates, reuses existing chunk embeddings where available,
 * handles unknown/failure outcomes deterministically, and completes deliveries in PostgreSQL.
 */
export function createWorkerEmbeddingHandler(
  options: WorkerEmbeddingHandlerOptions,
): EmbeddingDeliveryHandler {
  const {
    stateRepository,
    embeddingService,
    chunkRepository,
    profile,
    logger,
    now: getNow = () => new Date(),
  } = options;

  return async (delivery: { deliveryId: string; revisionId: string }): Promise<void> => {
    const { deliveryId, revisionId } = delivery;
    if (!embeddingService || !profile) {
      logger?.error('worker.embedding.rejected', {
        deliveryId,
        revisionId,
        reason: 'provider_not_configured_or_approval_required',
      });
      throw new ProviderBudgetError('approval_required');
    }
    const chunks = await chunkRepository.listByRevision(revisionId);
    for (const chunk of chunks) {
      const inputHash = createHash('sha256').update(chunk.content, 'utf8').digest('hex');
      const result = await embeddingService.processChunk(
        {
          chunkId: chunk.id,
          input: chunk.content,
          inputHash,
        },
        profile,
        { now: getNow() },
      );
      if (result.status === 'in_flight') {
        throw new Error(`Embedding chunk '${chunk.id}' is in-flight on another worker`);
      }
      if (result.status === 'outcome_unknown') {
        logger?.warn('worker.embedding.outcome_unknown', {
          deliveryId,
          revisionId,
          chunkId: chunk.id,
        });
        throw new ProviderBudgetError('outcome_unknown');
      }

      if (result.status === 'failed') {
        logger?.error('worker.embedding.failed', {
          deliveryId,
          revisionId,
          chunkId: chunk.id,
        });
        throw new Error(`Embedding chunk '${chunk.id}' failed`);
      }
    }
    await stateRepository.completeDelivery(deliveryId, getNow(), profile);
    logger?.info('worker.embedding.completed', {
      deliveryId,
      revisionId,
      chunkCount: chunks.length,
    });
  };
}
