const DATABASE_PROTOCOLS: Record<string, true> = {
  'postgres:': true,
  'postgresql:': true,
};

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly port: number;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export class ApiConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`API configuration is invalid: ${issues.join('; ')}`);
    this.name = 'ApiConfigError';
    this.issues = issues;
  }
}

function parseDatabaseUrl(value: string): boolean {
  if (/\s/u.test(value)) return false;

  try {
    const url = new URL(value);
    return DATABASE_PROTOCOLS[url.protocol] === true && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function parsePort(value: string | undefined, issues: string[]): number {
  if (value === undefined || value.trim() === '') return 3000;
  if (!/^\d+$/u.test(value)) {
    issues.push('PORT must be an integer between 1 and 65535');
    return 3000;
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    issues.push('PORT must be an integer between 1 and 65535');
    return 3000;
  }
  return port;
}

export function loadApiConfig(env: Environment = process.env): ApiConfig {
  const issues: string[] = [];
  const databaseUrl = env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    issues.push('DATABASE_URL is required');
  } else if (!parseDatabaseUrl(databaseUrl)) {
    issues.push('DATABASE_URL must be a valid PostgreSQL URL');
  }

  const port = parsePort(env['PORT'], issues);
  if (issues.length > 0) throw new ApiConfigError(issues);

  return { databaseUrl: databaseUrl as string, port };
}
