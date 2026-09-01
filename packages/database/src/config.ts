const POSTGRES_PROTOCOLS: Readonly<Record<string, true>> = {
  'postgres:': true,
  'postgresql:': true,
};

export interface DatabaseConfig {
  readonly databaseUrl: string;
  readonly maxConnections?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export class DatabaseConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Database configuration is invalid: ${issues.join('; ')}`);
    this.name = 'DatabaseConfigError';
    this.issues = issues;
  }
}

/**
 * Validates whether the given string is a valid PostgreSQL connection URL.
 * Never throws and never logs or leaks secrets.
 */
export function isValidDatabaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '' || /\s/u.test(value)) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return POSTGRES_PROTOCOLS[parsed.protocol] === true && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Redacts passwords or userinfo credentials from a database URL.
 * Returns '[REDACTED_INVALID_URL]' if the input cannot be parsed as a URL,
 * ensuring no secret or malformed credential string can ever leak into logs or errors.
 */
export function maskDatabaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return '[EMPTY]';
  }

  try {
    const parsed = new URL(value);
    if (POSTGRES_PROTOCOLS[parsed.protocol] !== true || parsed.hostname.length === 0) {
      return '[REDACTED_INVALID_URL]';
    }
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '[REDACTED_INVALID_URL]';
  }
}
function parsePositiveInteger(
  value: unknown,
  fieldName: string,
  issues: string[],
): number | undefined {
  if (value === undefined || value === null) return undefined;

  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(num) || num <= 0) {
    issues.push(`${fieldName} must be a positive integer`);
    return undefined;
  }
  return num;
}

function parseNonNegativeInteger(
  value: unknown,
  fieldName: string,
  issues: string[],
): number | undefined {
  if (value === undefined || value === null) return undefined;

  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(num) || num < 0) {
    issues.push(`${fieldName} must be a non-negative integer`);
    return undefined;
  }
  return num;
}

/**
 * Validates database client configuration without leaking secrets.
 */
export function validateDatabaseConfig(input: unknown): DatabaseConfig {
  if (typeof input !== 'object' || input === null) {
    throw new DatabaseConfigError(['Database configuration must be an object']);
  }

  const record = input as Record<string, unknown>;
  const issues: string[] = [];

  const rawUrl = record['databaseUrl'];
  if (
    rawUrl === undefined ||
    rawUrl === null ||
    (typeof rawUrl === 'string' && rawUrl.trim() === '')
  ) {
    issues.push('DATABASE_URL is required');
  } else if (!isValidDatabaseUrl(rawUrl)) {
    issues.push('DATABASE_URL must be a valid PostgreSQL URL');
  }

  const maxConnections = parsePositiveInteger(record['maxConnections'], 'maxConnections', issues);
  const idleTimeoutMillis = parseNonNegativeInteger(
    record['idleTimeoutMillis'],
    'idleTimeoutMillis',
    issues,
  );
  const connectionTimeoutMillis = parseNonNegativeInteger(
    record['connectionTimeoutMillis'],
    'connectionTimeoutMillis',
    issues,
  );

  if (issues.length > 0) {
    throw new DatabaseConfigError(issues);
  }

  return {
    databaseUrl: rawUrl as string,
    ...(maxConnections !== undefined ? { maxConnections } : {}),
    ...(idleTimeoutMillis !== undefined ? { idleTimeoutMillis } : {}),
    ...(connectionTimeoutMillis !== undefined ? { connectionTimeoutMillis } : {}),
  };
}

/**
 * Loads database configuration from environment variables without side-effects or logging.
 */
export function loadDatabaseConfig(env: Environment = process.env): DatabaseConfig {
  const issues: string[] = [];
  const databaseUrl = env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    issues.push('DATABASE_URL is required');
  } else if (!isValidDatabaseUrl(databaseUrl)) {
    issues.push('DATABASE_URL must be a valid PostgreSQL URL');
  }

  const maxConnections = parsePositiveInteger(
    env['DATABASE_MAX_CONNECTIONS'],
    'DATABASE_MAX_CONNECTIONS',
    issues,
  );
  const idleTimeoutMillis = parseNonNegativeInteger(
    env['DATABASE_IDLE_TIMEOUT_MS'],
    'DATABASE_IDLE_TIMEOUT_MS',
    issues,
  );
  const connectionTimeoutMillis = parseNonNegativeInteger(
    env['DATABASE_CONNECTION_TIMEOUT_MS'],
    'DATABASE_CONNECTION_TIMEOUT_MS',
    issues,
  );

  if (issues.length > 0) {
    throw new DatabaseConfigError(issues);
  }

  return {
    databaseUrl: databaseUrl as string,
    ...(maxConnections !== undefined ? { maxConnections } : {}),
    ...(idleTimeoutMillis !== undefined ? { idleTimeoutMillis } : {}),
    ...(connectionTimeoutMillis !== undefined ? { connectionTimeoutMillis } : {}),
  };
}
