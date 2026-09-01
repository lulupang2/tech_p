/**
 * TechPulse database package entrypoint.
 *
 * Implements ADR-0009: Drizzle ORM + Drizzle Kit with Node PostgreSQL driver.
 * Exposes lazy client factory, schema entrypoint, and migration utilities.
 */

export {
  collectionRuns,
  pipelineEvents,
  rawItems,
  schema,
  sources,
  type DatabaseSchema,
  type RawItemInsert,
  upsertRawItem,
} from './schema/index.js';
export {
  type DatabaseConfig,
  type Environment,
  DatabaseConfigError,
  isValidDatabaseUrl,
  maskDatabaseUrl,
  validateDatabaseConfig,
  loadDatabaseConfig,
} from './config.js';
export { type DatabaseClient, createDatabaseClient } from './client.js';
export {
  type MigrateOptions,
  type MigrationResult,
  type VectorExtensionInfo,
  DEFAULT_MIGRATIONS_FOLDER,
  migrateDatabase,
  checkVectorExtension,
} from './migrate.js';
export {
  createDocumentRepository,
  createSourceRepository,
  createCollectionRunRepository,
  createRawItemRepository,
  createPipelineEventRepository,
  createMetricObservationRepository,
} from './repositories.js';
export { createSearchService } from './search.js';
