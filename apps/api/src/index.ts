import { loadApiConfig, type Environment } from './config.js';
import { node } from '@elysiajs/node';
import { Elysia } from 'elysia';
import { pathToFileURL } from 'node:url';

/** Node-runtime API entrypoint. Routes are introduced by API-001. */
export const app = new Elysia({ adapter: node() });

export function start(env: Environment = process.env) {
  const config = loadApiConfig(env);
  return app.listen(config.port);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
