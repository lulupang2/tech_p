import { createDatabaseClient } from '@techpulse/database';
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
  const serverApp = createApp({ databaseClient, logger: apiLogger });
  logApiStartup(config.port);
  return serverApp.listen(config.port);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
