import { createStructuredLogger, type StructuredLogger } from '@techpulse/observability';
import { type DatabaseClient } from '@techpulse/database';
import { node } from '@elysiajs/node';
import { Elysia } from 'elysia';

import { resolveRequestCorrelation } from './correlation.js';
import { formatErrorToEnvelope } from './errors.js';
import { createHealthRoutes, type DatabaseHealthCheck } from './routes/health.js';

export interface AppOptions {
  readonly databaseClient?: DatabaseClient | undefined;
  readonly checkDatabaseHealth?: DatabaseHealthCheck | undefined;
  readonly logger?: StructuredLogger | undefined;
}

export function createApp(options: AppOptions = {}) {
  const logger = options.logger ?? createStructuredLogger({ service: 'api' });
  const checkDatabaseHealth =
    options.checkDatabaseHealth ??
    (options.databaseClient ? () => options.databaseClient!.checkHealth() : undefined);

  return new Elysia({ adapter: node(), normalize: false })
    .state('requestId', '')
    .onRequest(({ request, store }) => {
      const correlation = resolveRequestCorrelation(request);
      store.requestId = correlation.requestId;
      logger.withContext(correlation.context).info('api.request.received', {
        method: request.method,
        url: request.url,
      });
    })
    .onAfterHandle(({ set, store, request }) => {
      const requestId = store.requestId || resolveRequestCorrelation(request).requestId;
      set.headers['x-request-id'] = requestId;
    })
    .onError(({ error, set, store, request }) => {
      const requestId = store.requestId || resolveRequestCorrelation(request).requestId;
      const result = formatErrorToEnvelope(error, requestId);
      set.status = result.status;
      set.headers['x-request-id'] = requestId;

      logger.withContext({ requestId }).error('api.request.error', {
        status: result.status,
        code: result.envelope.error.code,
        message: result.envelope.error.message,
      });

      return result.envelope;
    })
    .use(createHealthRoutes({ checkDatabaseHealth }));
}
