import { Pool } from '@neondatabase/serverless';
import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { schema } from './schema/index.js';
import { type DatabaseConfig, validateDatabaseConfig } from './config.js';
import {
  migrateDatabase,
  checkVectorExtension,
  type MigrateOptions,
  type MigrationResult,
  type VectorExtensionInfo,
} from './migrate.js';

export interface DatabaseClient {
  readonly db: NeonDatabase<typeof schema>;
  readonly pool: Pool;
  readonly isConnected: boolean;
  readonly connect: () => Promise<void>;
  readonly checkHealth: () => Promise<boolean>;
  readonly close: () => Promise<void>;
  readonly migrate: (options?: MigrateOptions) => Promise<MigrationResult>;
  readonly checkVector: () => Promise<VectorExtensionInfo>;
}

function sanitizeErrorMessage(message: string): string {
  // Redact any password patterns like :password@ or password=xxx
  return message
    .replace(/:([^/@:\s]+)@/gu, ':***@')
    .replace(/(password\s*=\s*)([^\s;]+)/giu, '$1***');
}

/**
 * Creates a lazy database client instance.
 *
 * This factory:
 * 1. Never connects to the database at import time or factory call time.
 * 2. Never logs secrets, passwords, or connection strings.
 * 3. Requires explicit .connect(), .checkHealth(), .migrate(), or query invocation to open connections.
 */
export function createDatabaseClient(input: DatabaseConfig | string): DatabaseClient {
  const normalizedConfig = typeof input === 'string' ? { databaseUrl: input } : input;
  const config = validateDatabaseConfig(normalizedConfig);

  const pool = new Pool({
    connectionString: config.databaseUrl,
    ...(config.maxConnections !== undefined ? { max: config.maxConnections } : {}),
    ...(config.idleTimeoutMillis !== undefined
      ? { idleTimeoutMillis: config.idleTimeoutMillis }
      : {}),
    ...(config.connectionTimeoutMillis !== undefined
      ? { connectionTimeoutMillis: config.connectionTimeoutMillis }
      : {}),
  });

  const db = drizzle(pool, { schema });
  let connected = false;

  return {
    get db() {
      return db;
    },
    get pool() {
      return pool;
    },
    get isConnected() {
      return connected;
    },
    async connect(): Promise<void> {
      try {
        const client = await pool.connect();
        try {
          await client.query('SELECT 1;');
          connected = true;
        } finally {
          client.release();
        }
      } catch (error) {
        connected = false;
        const rawMessage = error instanceof Error ? error.message : 'Unknown connection error';
        throw new Error(`Database connection failed: ${sanitizeErrorMessage(rawMessage)}`);
      }
    },
    async checkHealth(): Promise<boolean> {
      try {
        const result = await pool.query('SELECT 1;');
        return (result.rowCount ?? 0) > 0 || result.rows.length > 0;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      connected = false;
      await pool.end();
    },
    async migrate(options?: MigrateOptions): Promise<MigrationResult> {
      return migrateDatabase(db, options);
    },
    async checkVector(): Promise<VectorExtensionInfo> {
      return checkVectorExtension(db);
    },
  };
}
