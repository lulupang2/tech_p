export const CONFIRM_RESTORE_OVERWRITE_TOKEN = 'CONFIRM_RESTORE_OVERWRITE' as const;

export class UnsafeRestoreRefusalError extends Error {
  readonly code = 'UNSAFE_RESTORE_REFUSED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'UnsafeRestoreRefusalError';
  }
}

export class InvalidBackupManifestError extends Error {
  readonly code = 'INVALID_BACKUP_MANIFEST' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidBackupManifestError';
  }
}

export interface BackupTableManifest {
  readonly tableName: string;
  readonly rowCount: number;
  readonly sha256Checksum: string;
}

export interface BackupManifest {
  readonly formatVersion: string;
  readonly backupId: string;
  readonly createdAt: string;
  readonly sourceDatabaseVersion?: string;
  readonly vectorDimensions: number;
  readonly tables: readonly BackupTableManifest[];
  readonly totalRows: number;
  readonly metadata?: Record<string, unknown>;
}

export interface BackupValidationResult {
  readonly valid: boolean;
  readonly backupId: string;
  readonly formatVersion: string;
  readonly tableCount: number;
  readonly totalRows: number;
  readonly vectorDimensions: number;
  readonly issues: readonly string[];
}

/**
 * Deterministically validates the structure, row counts, checksums, and vector parameters of a backup manifest.
 */
export function validateBackupManifest(manifest: unknown): BackupValidationResult {
  const issues: string[] = [];

  if (typeof manifest !== 'object' || manifest === null) {
    return {
      valid: false,
      backupId: 'unknown',
      formatVersion: 'unknown',
      tableCount: 0,
      totalRows: 0,
      vectorDimensions: 0,
      issues: ['Manifest is not a valid JSON object'],
    };
  }

  const m = manifest as Record<string, unknown>;
  const formatVersion = typeof m['formatVersion'] === 'string' ? m['formatVersion'] : '';
  if (!formatVersion || !formatVersion.startsWith('v')) {
    issues.push(`Invalid formatVersion: ${formatVersion}`);
  }

  const backupId = typeof m['backupId'] === 'string' ? m['backupId'] : '';
  if (!backupId) {
    issues.push('Missing backupId');
  }

  const vectorDimensions = typeof m['vectorDimensions'] === 'number' ? m['vectorDimensions'] : 0;
  if (!vectorDimensions || vectorDimensions <= 0) {
    issues.push(`Invalid vectorDimensions: ${vectorDimensions}`);
  }

  const tablesRaw = m['tables'];
  if (!Array.isArray(tablesRaw) || tablesRaw.length === 0) {
    issues.push('Missing or empty tables manifest array');
  }

  let tableCount = 0;
  let calculatedRows = 0;

  if (Array.isArray(tablesRaw)) {
    tableCount = tablesRaw.length;
    for (const t of tablesRaw) {
      if (typeof t !== 'object' || t === null) {
        issues.push('Table entry in manifest is invalid');
        continue;
      }
      const tObj = t as Record<string, unknown>;
      const name = typeof tObj['tableName'] === 'string' ? tObj['tableName'] : '';
      const count = typeof tObj['rowCount'] === 'number' ? tObj['rowCount'] : -1;
      const checksum = typeof tObj['sha256Checksum'] === 'string' ? tObj['sha256Checksum'] : '';

      if (!name) issues.push('Table manifest missing tableName');
      if (count < 0) issues.push(`Table ${name || 'unknown'} has invalid rowCount: ${count}`);
      else calculatedRows += count;
      if (!checksum || !/^[0-9a-fA-F]{64}$/.test(checksum)) {
        issues.push(`Table ${name || 'unknown'} has invalid sha256Checksum`);
      }
    }
  }

  const totalRows = typeof m['totalRows'] === 'number' ? m['totalRows'] : calculatedRows;
  if (totalRows !== calculatedRows && !issues.some((i) => i.includes('rowCount'))) {
    issues.push(`Manifest totalRows (${totalRows}) does not match sum of table rowCounts (${calculatedRows})`);
  }

  return {
    valid: issues.length === 0,
    backupId,
    formatVersion,
    tableCount,
    totalRows,
    vectorDimensions,
    issues,
  };
}

export interface RestoreEnvironmentPort {
  /**
   * Checks whether the target database environment is clean/empty (0 tables or 0 data rows).
   */
  readonly isCleanEnvironment: () => Promise<boolean>;
  /**
   * Returns table names and current row counts in target database.
   */
  readonly inspectTargetCounts: () => Promise<Record<string, number>>;
  /**
   * Runs schema migrations and vector bootstrap in target database.
   */
  readonly applySchemaMigration: () => Promise<{ readonly appliedMigrationCount: number }>;
  /**
   * Restores data rows into target database tables.
   */
  readonly restoreTables: (manifest: BackupManifest) => Promise<{
    readonly restoredTableCount: number;
    readonly restoredRowCount: number;
  }>;
  /**
   * Runs integrity verification checks (foreign key sanity, vector search sanity, tombstone exclusion verification).
   */
  readonly verifyIntegrity: () => Promise<{ readonly pass: boolean; readonly details: Record<string, unknown> }>;
}

export interface RestoreAuditEvent {
  readonly action: 'restore_drill_dry_run' | 'restore_drill_execution';
  readonly backupId: string;
  readonly targetClean: boolean;
  readonly restoredRowCount?: number;
  readonly integrityPassed?: boolean;
  readonly actor?: { readonly type: string; readonly ref: string };
  readonly occurredAt: Date;
}

export interface RestoreAuditPort {
  readonly record: (event: RestoreAuditEvent) => Promise<void>;
}

export interface RestoreDrillOptions {
  readonly manifest: BackupManifest;
  readonly dryRun?: boolean;
  readonly confirmation?: string;
  readonly actor?: { readonly type: string; readonly ref: string };
}

export interface RestoreDrillResult {
  readonly dryRun: boolean;
  readonly backupId: string;
  readonly validation: BackupValidationResult;
  readonly targetWasClean: boolean;
  readonly migrationApplied: boolean;
  readonly restoredTableCount: number;
  readonly restoredRowCount: number;
  readonly integrityVerified: boolean;
  readonly executionPlan: readonly string[];
}

export interface BackupRestoreServicePort {
  readonly executeRestoreDrill: (options: RestoreDrillOptions) => Promise<RestoreDrillResult>;
}

export function createBackupRestoreService(options: {
  readonly environment: RestoreEnvironmentPort;
  readonly audit?: RestoreAuditPort;
}): BackupRestoreServicePort {
  return {
    async executeRestoreDrill(drillOptions: RestoreDrillOptions): Promise<RestoreDrillResult> {
      const validation = validateBackupManifest(drillOptions.manifest);
      if (!validation.valid) {
        throw new InvalidBackupManifestError(
          `Backup manifest validation failed: ${validation.issues.join('; ')}`,
        );
      }

      const isClean = await options.environment.isCleanEnvironment();
      const dryRun = drillOptions.dryRun ?? true;

      const executionPlan = [
        '1. Validate backup manifest structure and table checksums',
        '2. Inspect target database environment emptiness',
        '3. Apply PostgreSQL vector extension and Drizzle migrations',
        '4. Load table datasets in dependency order (sources -> runs -> raw -> docs -> revisions -> chunks -> embeddings)',
        '5. Validate post-restore row counts and foreign key referential integrity',
        '6. Run verification search queries asserting tombstone exclusion and vector retrieval readiness',
      ];

      if (!isClean && !dryRun) {
        if (drillOptions.confirmation !== CONFIRM_RESTORE_OVERWRITE_TOKEN) {
          const currentCounts = await options.environment.inspectTargetCounts();
          const tableSummary = Object.entries(currentCounts)
            .map(([t, c]) => `${t}: ${c}`)
            .join(', ');
          throw new UnsafeRestoreRefusalError(
            `Restore over non-empty environment refused! Target contains active data (${tableSummary}). Explicit confirmation token "${CONFIRM_RESTORE_OVERWRITE_TOKEN}" is required.`,
          );
        }
      }

      if (dryRun) {
        await options.audit?.record({
          action: 'restore_drill_dry_run',
          backupId: drillOptions.manifest.backupId,
          targetClean: isClean,
          actor: drillOptions.actor,
          occurredAt: new Date(),
        });

        return {
          dryRun: true,
          backupId: drillOptions.manifest.backupId,
          validation,
          targetWasClean: isClean,
          migrationApplied: false,
          restoredTableCount: 0,
          restoredRowCount: 0,
          integrityVerified: false,
          executionPlan,
        };
      }

      // Execute live restore drill
      const migrationRes = await options.environment.applySchemaMigration();
      const restoreRes = await options.environment.restoreTables(drillOptions.manifest);
      const integrityRes = await options.environment.verifyIntegrity();

      await options.audit?.record({
        action: 'restore_drill_execution',
        backupId: drillOptions.manifest.backupId,
        targetClean: isClean,
        restoredRowCount: restoreRes.restoredRowCount,
        integrityPassed: integrityRes.pass,
        actor: drillOptions.actor,
        occurredAt: new Date(),
      });

      return {
        dryRun: false,
        backupId: drillOptions.manifest.backupId,
        validation,
        targetWasClean: isClean,
        migrationApplied: migrationRes.appliedMigrationCount > 0,
        restoredTableCount: restoreRes.restoredTableCount,
        restoredRowCount: restoreRes.restoredRowCount,
        integrityVerified: integrityRes.pass,
        executionPlan,
      };
    },
  };
}
