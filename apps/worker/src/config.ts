const REDIS_PROTOCOLS: Record<string, true> = {
  'redis:': true,
  'rediss:': true,
};
const DATABASE_PROTOCOLS: Record<string, true> = {
  'postgres:': true,
  'postgresql:': true,
};

export interface WorkerEmbeddingConfig {
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly model?: string | undefined;
  readonly version?: string | undefined;
  readonly dimensions?: number | undefined;
  readonly provider?: string | undefined;
  readonly scopeId?: string | undefined;
  readonly priceVersion?: string | undefined;
  readonly tokenizerVersion?: string | undefined;
  readonly approvalReference?: string | undefined;
}

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly concurrency: number;
  readonly incrementalConcurrency: number;
  readonly backfillConcurrency: number;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly allowFixtureProviders: boolean;
  readonly healthPort?: number | undefined;
  readonly embedding: WorkerEmbeddingConfig;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export class WorkerConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Worker configuration is invalid: ${issues.join('; ')}`);
    this.name = 'WorkerConfigError';
    this.issues = issues;
  }
}

function isConnectionUrl(value: string, protocols: Readonly<Record<string, true>>): boolean {
  if (/\s/u.test(value)) return false;

  try {
    const url = new URL(value);
    return protocols[url.protocol] === true && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function parseIntegerWithDefault(
  value: string | undefined,
  defaultValue: number,
  name: string,
  min: number,
  max: number,
  issues: string[],
): number {
  if (value === undefined || value.trim() === '') return defaultValue;
  if (!/^\d+$/u.test(value)) {
    issues.push(`${name} must be an integer between ${min} and ${max}`);
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    issues.push(`${name} must be an integer between ${min} and ${max}`);
    return defaultValue;
  }
  return parsed;
}
export function loadWorkerConfig(env: Environment = process.env): WorkerConfig {
  const issues: string[] = [];
  const databaseUrl = env['DATABASE_URL'];
  const redisUrl = env['REDIS_URL'];

  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    issues.push('DATABASE_URL is required');
  } else if (!isConnectionUrl(databaseUrl, DATABASE_PROTOCOLS)) {
    issues.push('DATABASE_URL must be a valid PostgreSQL URL');
  }

  if (redisUrl === undefined || redisUrl.trim() === '') {
    issues.push('REDIS_URL is required');
  } else if (!isConnectionUrl(redisUrl, REDIS_PROTOCOLS)) {
    issues.push('REDIS_URL must be a valid Redis URL');
  }

  const concurrency = parseIntegerWithDefault(
    env['WORKER_CONCURRENCY'],
    1,
    'WORKER_CONCURRENCY',
    1,
    100,
    issues,
  );
  const incrementalConcurrency = parseIntegerWithDefault(
    env['WORKER_INCREMENTAL_CONCURRENCY'],
    5,
    'WORKER_INCREMENTAL_CONCURRENCY',
    1,
    100,
    issues,
  );
  const backfillConcurrency = parseIntegerWithDefault(
    env['WORKER_BACKFILL_CONCURRENCY'],
    2,
    'WORKER_BACKFILL_CONCURRENCY',
    1,
    100,
    issues,
  );
  const pollIntervalMs = parseIntegerWithDefault(
    env['WORKER_POLL_INTERVAL_MS'],
    1_000,
    'WORKER_POLL_INTERVAL_MS',
    10,
    60_000,
    issues,
  );
  const leaseMs = parseIntegerWithDefault(
    env['WORKER_LEASE_MS'],
    30_000,
    'WORKER_LEASE_MS',
    1_000,
    300_000,
    issues,
  );

  const healthPort = env['WORKER_HEALTH_PORT']
    ? parseIntegerWithDefault(
        env['WORKER_HEALTH_PORT'],
        3001,
        'WORKER_HEALTH_PORT',
        1,
        65535,
        issues,
      )
    : undefined;
  const allowFixtureProviders =
    env['TECHPULSE_ALLOW_FIXTURE_PROVIDERS'] === 'true' ||
    env['WORKER_FIXTURE_MODE'] === 'true' ||
    env['TECHPULSE_FIXTURE_MODE'] === 'true';

  const embeddingDimensions = env['EMBEDDING_DIMENSIONS']
    ? parseIntegerWithDefault(
        env['EMBEDDING_DIMENSIONS'],
        1536,
        'EMBEDDING_DIMENSIONS',
        1,
        16000,
        issues,
      )
    : undefined;

  const embeddingModel = env['EMBEDDING_MODEL']?.trim() || undefined;
  const approvedEmbedding = embeddingModel === 'perplexity/pplx-embed-v1-0.6b';
  const embedding: WorkerEmbeddingConfig = {
    apiKey: env['EMBEDDING_API_KEY']?.trim() || undefined,
    baseUrl: env['EMBEDDING_BASE_URL']?.trim() || undefined,
    model: embeddingModel,
    version: env['EMBEDDING_VERSION']?.trim() || (approvedEmbedding ? '2026-03-16' : undefined),
    dimensions: embeddingDimensions ?? (approvedEmbedding ? 1024 : undefined),
    provider:
      env['EMBEDDING_PROVIDER']?.trim() ||
      (approvedEmbedding ? 'openrouter-perplexity' : undefined),
    scopeId:
      env['EMBEDDING_SCOPE_ID']?.trim() || (approvedEmbedding ? 'dec-012-cov009' : undefined),
    priceVersion:
      env['EMBEDDING_PRICE_VERSION']?.trim() ||
      (approvedEmbedding ? 'openrouter-pplx-embed-2026-09-10' : undefined),
    tokenizerVersion:
      env['EMBEDDING_TOKENIZER_VERSION']?.trim() ||
      (approvedEmbedding ? 'provider-reported-v1' : undefined),
    approvalReference:
      env['EMBEDDING_APPROVAL_REFERENCE']?.trim() ||
      (approvedEmbedding ? 'DEC-007-2026-09-10' : undefined),
  };

  if (issues.length > 0) throw new WorkerConfigError(issues);

  return {
    databaseUrl: databaseUrl as string,
    redisUrl: redisUrl as string,
    concurrency,
    incrementalConcurrency,
    backfillConcurrency,
    pollIntervalMs,
    leaseMs,
    allowFixtureProviders,
    ...(healthPort !== undefined ? { healthPort } : {}),
    embedding,
  };
}
