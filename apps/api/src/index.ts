import { loadApiConfig, type Environment } from './config.js';
import {
  correlationContextFromHeaders,
  createStructuredLogger,
  type CorrelationContext,
  type StructuredEvent,
} from '@techpulse/observability';
import { node } from '@elysiajs/node';
import { Elysia } from 'elysia';
import { pathToFileURL } from 'node:url';

export const apiLogger = createStructuredLogger({ service: 'api' });

/** Extract and validate inbound correlation IDs at the HTTP boundary. */
export function requestCorrelationContext(request: Request): CorrelationContext {
  return correlationContextFromHeaders(request.headers);
}

/** Node-runtime API entrypoint. Routes are introduced by API-001. */
export const app = new Elysia({ adapter: node() }).onRequest(({ request }) => {
  apiLogger.withContext(requestCorrelationContext(request)).info('api.request.received');
});

export function logApiStartup(port: number): StructuredEvent {
  return apiLogger.info('api.starting', { port });
}

export function start(env: Environment = process.env) {
  const config = loadApiConfig(env);
  logApiStartup(config.port);
  return app.listen(config.port);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
