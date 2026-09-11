import { randomUUID } from 'node:crypto';
import { createProviderBudgetRepository, type DatabaseClient } from '@techpulse/database';
import {
  collectionHash,
  createProviderBudgetService,
  ProviderBudgetError,
  assertValidModelProfile,
  assertValidBudgetCaps,
  assertValidPriceRate,
  type ChatPort,
  type EmbeddingPort,
  type ModelProfile,
  type ExecutionCaps,
  type PriceRate,
} from '@techpulse/domain';

export interface RuntimeModelBinding<Port> {
  readonly port: Port;
  readonly profile: ModelProfile;
  readonly scopeId: string;
  readonly caps: ExecutionCaps;
  readonly priceRate: PriceRate;
}

/** Explicit adapters only: credentials alone never authorize a model or spending. */
export interface ApiModelBindings {
  readonly chat: RuntimeModelBinding<ChatPort>;
  readonly embedding?: RuntimeModelBinding<EmbeddingPort>;
}

export interface ApiRuntimeBudgetOptions {
  /** Reserve the full approved input cap when a caller has independently bounded the input. */
  readonly reserveFullInputCap?: boolean;
}

export function createBudgetedApiModels(
  db: DatabaseClient['db'],
  bindings: ApiModelBindings,
  options: ApiRuntimeBudgetOptions = {},
) {
  assertValidModelProfile(bindings.chat.profile);
  assertValidBudgetCaps(bindings.chat.caps);
  assertValidPriceRate(bindings.chat.priceRate);
  if (!bindings.chat.scopeId || bindings.chat.scopeId.trim().length === 0) {
    throw new ProviderBudgetError('approval_required');
  }

  if (bindings.embedding) {
    assertValidModelProfile(bindings.embedding.profile);
    assertValidBudgetCaps(bindings.embedding.caps);
    assertValidPriceRate(bindings.embedding.priceRate);
    if (!bindings.embedding.scopeId || bindings.embedding.scopeId.trim().length === 0) {
      throw new ProviderBudgetError('approval_required');
    }
  }

  const budget = createProviderBudgetService(createProviderBudgetRepository(db));
  async function authorize(binding: RuntimeModelBinding<unknown>) {
    const scope = await db.query.providerBudgetScopes.findFirst({
      where: (scopes, { eq }) => eq(scopes.id, binding.scopeId),
    });
    if (
      !scope ||
      !scope.approved ||
      scope.blocked ||
      !Array.isArray(scope.approvedModelProfiles) ||
      !scope.approvedModelProfiles.includes(collectionHash(binding.profile))
    ) {
      throw new ProviderBudgetError('approval_required');
    }
  }
  const chatPort: ChatPort = {
    async complete(request) {
      await authorize(bindings.chat);
      return budget.executeChatWithBudget(bindings.chat.port, request, {
        ...bindings.chat,
        attemptId: randomUUID(),
        ...(options.reserveFullInputCap
          ? { inputTokenUpperBound: bindings.chat.caps.maxInputTokens }
          : {}),
      });
    },
  };
  const embedding = bindings.embedding;
  const embeddingPort: EmbeddingPort | undefined = embedding
    ? {
        async embed(request) {
          await authorize(embedding);
          return budget.executeQueryEmbeddingWithBudget(embedding.port, request, {
            ...embedding,
            attemptId: randomUUID(),
            lane: 'query_embedding',
            ...(options.reserveFullInputCap
              ? { inputTokenUpperBound: embedding.caps.maxInputTokens }
              : {}),
          });
        },
        async embedMany(requests) {
          const results = [];
          for (const request of requests) results.push(await this.embed(request));
          return results;
        },
      }
    : undefined;
  return { chatPort, embeddingPort };
}
