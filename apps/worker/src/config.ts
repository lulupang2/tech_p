const REDIS_PROTOCOLS: Record<string, true> = {
  'redis:': true,
  'rediss:': true,
};
const DATABASE_PROTOCOLS: Record<string, true> = {
  'postgres:': true,
  'postgresql:': true,
};

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly concurrency: number;
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

function parseConcurrency(value: string | undefined, issues: string[]): number {
  if (value === undefined || value.trim() === '') return 1;
  if (!/^\d+$/u.test(value)) {
    issues.push('WORKER_CONCURRENCY must be an integer between 1 and 100');
    return 1;
  }

  const concurrency = Number(value);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    issues.push('WORKER_CONCURRENCY must be an integer between 1 and 100');
    return 1;
  }
  return concurrency;
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

  const concurrency = parseConcurrency(env['WORKER_CONCURRENCY'], issues);
  if (issues.length > 0) throw new WorkerConfigError(issues);

  return { databaseUrl: databaseUrl as string, redisUrl: redisUrl as string, concurrency };
}
