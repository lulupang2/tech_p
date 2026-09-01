import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { schema } from './schema/index.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_FOLDER = resolve(currentDir, '../drizzle');

export interface MigrateOptions {
  readonly migrationsFolder?: string;
  readonly migrationsTable?: string;
  readonly migrationsSchema?: string;
}

export interface MigrationResult {
  readonly applied: boolean;
  readonly durationMs: number;
}

export interface VectorExtensionInfo {
  readonly installed: boolean;
  readonly version?: string;
}

/**
 * Runs Drizzle ORM migrations against the given database instance.
 * Reads committed SQL migrations and journal metadata from the migrations folder.
 */
export async function migrateDatabase(
  db: NodePgDatabase<typeof schema>,
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  const start = performance.now();
  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;

  await migrate(db, {
    migrationsFolder,
    ...(options.migrationsTable !== undefined ? { migrationsTable: options.migrationsTable } : {}),
    ...(options.migrationsSchema !== undefined
      ? { migrationsSchema: options.migrationsSchema }
      : {}),
  });

  const durationMs = Math.round(performance.now() - start);
  return { applied: true, durationMs };
}

/**
 * Verifies whether the pgvector extension is currently installed in the target database.
 */
export async function checkVectorExtension(
  db: NodePgDatabase<typeof schema>,
): Promise<VectorExtensionInfo> {
  const result = await db.execute(
    sql`SELECT extname, extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1;`,
  );

  if (result.rows.length === 0) {
    return { installed: false };
  }

  const row = result.rows[0] as { extname?: string; extversion?: string } | undefined;
  return {
    installed: true,
    ...(row?.extversion !== undefined ? { version: String(row.extversion) } : {}),
  };
}
