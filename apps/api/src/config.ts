const DATABASE_PROTOCOLS: Record<string, true> = {
  'postgres:': true,
  'postgresql:': true,
};

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly aiChatApiKey?: string | undefined;
  readonly aiChatBaseUrl?: string | undefined;
  readonly aiChatModel?: string | undefined;
  readonly aiChatTimeoutMs?: number | undefined;
  readonly aiEmbeddingApiKey?: string | undefined;
  readonly aiEmbeddingBaseUrl?: string | undefined;
  readonly aiEmbeddingModel?: string | undefined;
  readonly aiEmbeddingDimensions?: number | undefined;
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
  const aiChatApiKey = env['AI_CHAT_API_KEY'] || env['RUNINFRA_API_KEY'] || env['OPENAI_API_KEY'];
  const aiChatBaseUrl = env['AI_CHAT_BASE_URL'];
  const aiChatModel = env['AI_CHAT_MODEL'];
  const aiChatTimeoutMs =
    env['AI_CHAT_TIMEOUT_MS'] && /^\d+$/u.test(env['AI_CHAT_TIMEOUT_MS'])
      ? Number(env['AI_CHAT_TIMEOUT_MS'])
      : undefined;

  const aiEmbeddingApiKey = env['AI_EMBEDDING_API_KEY'] || env['OPENROUTER_API_KEY'];
  const aiEmbeddingBaseUrl = env['AI_EMBEDDING_BASE_URL'];
  const aiEmbeddingModel = env['AI_EMBEDDING_MODEL'];
  const aiEmbeddingDimensions =
    env['AI_EMBEDDING_DIMENSIONS'] && /^\d+$/u.test(env['AI_EMBEDDING_DIMENSIONS'])
      ? Number(env['AI_EMBEDDING_DIMENSIONS'])
      : undefined;

  return {
    databaseUrl: databaseUrl as string,
    port,
    ...(aiChatApiKey ? { aiChatApiKey } : {}),
    ...(aiChatBaseUrl ? { aiChatBaseUrl } : {}),
    ...(aiChatModel ? { aiChatModel } : {}),
    ...(aiChatTimeoutMs !== undefined ? { aiChatTimeoutMs } : {}),
    ...(aiEmbeddingApiKey ? { aiEmbeddingApiKey } : {}),
    ...(aiEmbeddingBaseUrl ? { aiEmbeddingBaseUrl } : {}),
    ...(aiEmbeddingModel ? { aiEmbeddingModel } : {}),
    ...(aiEmbeddingDimensions !== undefined ? { aiEmbeddingDimensions } : {}),
  };
}
