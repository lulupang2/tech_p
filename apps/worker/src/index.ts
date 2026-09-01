import { loadWorkerConfig, type Environment, type WorkerConfig } from './config.js';
import { pathToFileURL } from 'node:url';

/**
 * Worker process entrypoint. Job registration starts after QUE-001.
 */
export const workerEntrypoint = '@techpulse/worker';

export function start(env: Environment = process.env): WorkerConfig {
  return loadWorkerConfig(env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
