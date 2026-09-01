import { createDatabaseClient, createSearchService } from '@techpulse/database';
import {
  createOpenAiCompatibleChatPort,
  createOpenAiCompatibleEmbeddingPort,
} from '@techpulse/domain';
import { createAnswerService, type AnswerServicePort } from '@techpulse/rag';
import {
  correlationContextFromHeaders,
  createStructuredLogger,
  type CorrelationContext,
  type StructuredEvent,
} from '@techpulse/observability';
import { node } from '@elysiajs/node';
import { Elysia } from 'elysia';
import { pathToFileURL } from 'node:url';

import { loadApiConfig, type Environment } from './config.js';
import { createApp, type AppOptions } from './app.js';

export { createApp, type AppOptions };

export const apiLogger = createStructuredLogger({ service: 'api' });

/** Extract and validate inbound correlation IDs at the HTTP boundary. */
export function requestCorrelationContext(request: Request): CorrelationContext {
  return correlationContextFromHeaders(request.headers);
}

/** Node-runtime API default shell instance. */
export const app = new Elysia({ adapter: node() }).use(createApp({ logger: apiLogger }));

export function logApiStartup(port: number): StructuredEvent {
  return apiLogger.info('api.starting', { port });
}

export function start(env: Environment = process.env) {
  const config = loadApiConfig(env);
  const databaseClient = createDatabaseClient(config.databaseUrl);

  let answerService: AnswerServicePort | undefined;
  if (config.aiChatApiKey) {
    const chatPort = createOpenAiCompatibleChatPort({
      apiKey: config.aiChatApiKey,
      ...(config.aiChatBaseUrl ? { baseUrl: config.aiChatBaseUrl } : {}),
      ...(config.aiChatModel ? { model: config.aiChatModel } : {}),
      ...(config.aiChatTimeoutMs !== undefined ? { defaultTimeoutMs: config.aiChatTimeoutMs } : {}),
    });
    const embeddingPort = config.aiEmbeddingApiKey
      ? createOpenAiCompatibleEmbeddingPort({
          apiKey: config.aiEmbeddingApiKey,
          ...(config.aiEmbeddingBaseUrl ? { baseUrl: config.aiEmbeddingBaseUrl } : {}),
          ...(config.aiEmbeddingModel ? { model: config.aiEmbeddingModel } : {}),
          ...(config.aiEmbeddingDimensions !== undefined
            ? { dimensions: config.aiEmbeddingDimensions }
            : {}),
        })
      : undefined;
    const searchService = createSearchService(databaseClient.db);
    answerService = createAnswerService({
      chatPort,
      searchService,
      embeddingPort,
      logger: apiLogger,
    });
  }

  const serverApp = createApp({ databaseClient, answerService, logger: apiLogger });
  logApiStartup(config.port);
  return serverApp.listen(config.port);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
