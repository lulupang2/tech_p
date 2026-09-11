import {
  createOpenAiCompatibleChatPort,
  createOpenAiCompatibleEmbeddingPort,
  type ModelProfile,
} from '@techpulse/domain';
import type { ApiConfig } from './config.js';
import type { ApiModelBindings } from './runtime-models.js';

export const DEC007_CHAT_MODEL = 'nemotron-3-5-lightning-30b';
export const DEC007_EMBEDDING_MODEL = 'perplexity/pplx-embed-v1-0.6b';
export const DEC012_SCOPE_ID = 'dec-012-cov009';

const CHAT_PROFILE: ModelProfile = {
  provider: 'runinfra',
  model: DEC007_CHAT_MODEL,
  version: 'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16',
  dimensions: 1,
  priceVersion: 'runinfra-nemotron-3-5-lightning-2026-09-10',
  tokenizerVersion: 'provider-reported-v1',
  approvalReference: 'DEC-007-2026-09-10',
};

const EMBEDDING_PROFILE: ModelProfile = {
  provider: 'openrouter-perplexity',
  model: DEC007_EMBEDDING_MODEL,
  version: '2026-03-16',
  dimensions: 1024,
  priceVersion: 'openrouter-pplx-embed-2026-09-10',
  tokenizerVersion: 'provider-reported-v1',
  approvalReference: 'DEC-007-2026-09-10',
};

export interface ApprovedModelFactoryOptions {
  readonly fetchFn?: typeof fetch;
}

/** Builds only the exact DEC-007 model pair; partial or mismatched config stays unavailable. */
export function createApprovedApiModelBindings(
  config: ApiConfig,
  options: ApprovedModelFactoryOptions = {},
): ApiModelBindings | undefined {
  if (
    !config.aiChatApiKey ||
    config.aiChatBaseUrl !== 'https://api.runinfra.ai/v1' ||
    config.aiChatModel !== DEC007_CHAT_MODEL ||
    !config.aiEmbeddingApiKey ||
    config.aiEmbeddingBaseUrl !== 'https://openrouter.ai/api/v1' ||
    config.aiEmbeddingModel !== DEC007_EMBEDDING_MODEL ||
    config.aiEmbeddingDimensions !== 1024
  ) {
    return undefined;
  }

  return {
    chat: {
      port: createOpenAiCompatibleChatPort({
        apiKey: config.aiChatApiKey,
        baseUrl: config.aiChatBaseUrl,
        model: config.aiChatModel,
        defaultTimeoutMs: Math.min(config.aiChatTimeoutMs ?? 15_000, 15_000),
        temperature: 0,
        requireJsonObject: true,
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      }),
      profile: CHAT_PROFILE,
      scopeId: DEC012_SCOPE_ID,
      caps: { maxInputTokens: 32_768, maxOutputTokens: 700, timeoutMs: 15_000 },
      // Integer micro-USD/1K tokens, conservatively using the documented output rate.
      priceRate: { unitsPerThousandTokens: 150 },
    },
    embedding: {
      port: createOpenAiCompatibleEmbeddingPort({
        apiKey: config.aiEmbeddingApiKey,
        baseUrl: config.aiEmbeddingBaseUrl,
        model: config.aiEmbeddingModel,
        dimensions: config.aiEmbeddingDimensions,
        acceptedResponseModels: ['pplx-embed-v1-0.6b'],
        defaultTimeoutMs: 10_000,
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      }),
      profile: EMBEDDING_PROFILE,
      scopeId: DEC012_SCOPE_ID,
      caps: { maxInputTokens: 8_192, timeoutMs: 10_000 },
      // OpenRouter list price USD 0.004/1M tokens = 4 micro-USD/1K tokens.
      priceRate: { unitsPerThousandTokens: 4 },
    },
  };
}
