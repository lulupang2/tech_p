import { describe, expect, it } from 'vitest';
import {
  validateBackupManifest,
  createBackupRestoreService,
  CONFIRM_RESTORE_OVERWRITE_TOKEN,
  UnsafeRestoreRefusalError,
  InvalidBackupManifestError,
  type BackupManifest,
  type RestoreAuditEvent,
} from '../src/backup-restore.js';

describe('Backup Manifest Validation', () => {
  const validManifest: BackupManifest = {
    formatVersion: 'v1.0.0',
    backupId: 'backup_20260902_prod_full',
    createdAt: '2026-09-02T04:00:00.000Z',
    sourceDatabaseVersion: 'PostgreSQL 17.0 on x86_64-pc-linux-gnu',
    vectorDimensions: 1536,
    tables: [
      {
        tableName: 'sources',
        rowCount: 11,
        sha256Checksum: 'a'.repeat(64),
      },
      {
        tableName: 'documents',
        rowCount: 1500,
        sha256Checksum: 'b'.repeat(64),
      },
      {
        tableName: 'document_revisions',
        rowCount: 1550,
        sha256Checksum: 'c'.repeat(64),
      },
      {
        tableName: 'chunks',
        rowCount: 6200,
        sha256Checksum: 'd'.repeat(64),
      },
      {
        tableName: 'embeddings',
        rowCount: 6200,
        sha256Checksum: 'e'.repeat(64),
      },
    ],
    totalRows: 15461,
  };

  it('validates a correct backup manifest', () => {
    const result = validateBackupManifest(validManifest);
    expect(result.valid).toBe(true);
    expect(result.backupId).toBe('backup_20260902_prod_full');
    expect(result.tableCount).toBe(5);
    expect(result.totalRows).toBe(15461);
    expect(result.vectorDimensions).toBe(1536);
    expect(result.issues).toHaveLength(0);
  });

  it('flags invalid or corrupted backup manifests', () => {
    const invalidManifest = {
      ...validManifest,
      vectorDimensions: -1,
      tables: [
        {
          tableName: 'sources',
          rowCount: -5,
          sha256Checksum: 'invalid-hash',
        },
      ],
      totalRows: 100, // Mismatched sum
    };

    const result = validateBackupManifest(invalidManifest);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('vectorDimensions'))).toBe(true);
    expect(result.issues.some((i) => i.includes('invalid sha256Checksum'))).toBe(true);
    expect(result.issues.some((i) => i.includes('rowCount'))).toBe(true);
  });

  it('rejects completely invalid manifest payload', () => {
    const result = validateBackupManifest(null);
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain('not a valid JSON object');
  });
});

describe('Restore Drill Service & Empty Environment Safety Guard', () => {
  const validManifest: BackupManifest = {
    formatVersion: 'v1.0.0',
    backupId: 'backup_drill_01',
    createdAt: '2026-09-02T04:00:00.000Z',
    vectorDimensions: 1536,
    tables: [
      {
        tableName: 'sources',
        rowCount: 11,
        sha256Checksum: 'a'.repeat(64),
      },
      {
        tableName: 'documents',
        rowCount: 50,
        sha256Checksum: 'b'.repeat(64),
      },
    ],
    totalRows: 61,
  };

  it('executes dry-run without mutating clean target environment', async () => {
    const auditLogs: RestoreAuditEvent[] = [];
    let migrationRun = false;
    let tablesRestored = false;

    const service = createBackupRestoreService({
      environment: {
        isCleanEnvironment: async () => true,
        inspectTargetCounts: async () => ({ sources: 0, documents: 0 }),
        applySchemaMigration: async () => {
          migrationRun = true;
          return { appliedMigrationCount: 1 };
        },
        restoreTables: async () => {
          tablesRestored = true;
          return { restoredTableCount: 2, restoredRowCount: 61 };
        },
        verifyIntegrity: async () => ({ pass: true, details: { status: 'ok' } }),
      },
      audit: {
        record: async (event) => {
          auditLogs.push(event);
        },
      },
    });

    const result = await service.executeRestoreDrill({
      manifest: validManifest,
      dryRun: true,
      actor: { type: 'operator', ref: 'driller' },
    });

    expect(result.dryRun).toBe(true);
    expect(result.targetWasClean).toBe(true);
    expect(result.migrationApplied).toBe(false);
    expect(migrationRun).toBe(false);
    expect(tablesRestored).toBe(false);
    expect(result.executionPlan).toHaveLength(6);

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]?.action).toBe('restore_drill_dry_run');
    expect(auditLogs[0]?.targetClean).toBe(true);
  });

  it('refuses restore drill over non-empty environment without explicit overwrite confirmation token', async () => {
    const auditLogs: RestoreAuditEvent[] = [];
    let tablesRestored = false;

    const service = createBackupRestoreService({
      environment: {
        isCleanEnvironment: async () => false,
        inspectTargetCounts: async () => ({ sources: 11, documents: 4500, raw_items: 4500 }),
        applySchemaMigration: async () => ({ appliedMigrationCount: 0 }),
        restoreTables: async () => {
          tablesRestored = true;
          return { restoredTableCount: 2, restoredRowCount: 61 };
        },
        verifyIntegrity: async () => ({ pass: true, details: {} }),
      },
      audit: {
        record: async (event) => {
          auditLogs.push(event);
        },
      },
    });

    await expect(
      service.executeRestoreDrill({
        manifest: validManifest,
        dryRun: false,
      }),
    ).rejects.toThrow(UnsafeRestoreRefusalError);

    expect(tablesRestored).toBe(false);
    expect(auditLogs).toHaveLength(0);
  });

  it('successfully executes restore drill in a clean empty environment', async () => {
    const auditLogs: RestoreAuditEvent[] = [];
    let migrationRun = false;
    let tablesRestored = false;

    const service = createBackupRestoreService({
      environment: {
        isCleanEnvironment: async () => true,
        inspectTargetCounts: async () => ({ sources: 0, documents: 0 }),
        applySchemaMigration: async () => {
          migrationRun = true;
          return { appliedMigrationCount: 3 };
        },
        restoreTables: async () => {
          tablesRestored = true;
          return { restoredTableCount: 2, restoredRowCount: 61 };
        },
        verifyIntegrity: async () => ({
          pass: true,
          details: { searchableRevisions: 50, tombstonedRevisions: 0 },
        }),
      },
      audit: {
        record: async (event) => {
          auditLogs.push(event);
        },
      },
    });

    const result = await service.executeRestoreDrill({
      manifest: validManifest,
      dryRun: false,
      actor: { type: 'ci_pipeline', ref: 'restore_drill_job_812' },
    });

    expect(result.dryRun).toBe(false);
    expect(result.targetWasClean).toBe(true);
    expect(result.migrationApplied).toBe(true);
    expect(migrationRun).toBe(true);
    expect(tablesRestored).toBe(true);
    expect(result.restoredRowCount).toBe(61);
    expect(result.integrityVerified).toBe(true);

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]?.action).toBe('restore_drill_execution');
    expect(auditLogs[0]?.integrityPassed).toBe(true);
    expect(auditLogs[0]?.restoredRowCount).toBe(61);
  });

  it('permits restore over non-empty environment when explicit CONFIRM_RESTORE_OVERWRITE is supplied', async () => {
    let tablesRestored = false;

    const service = createBackupRestoreService({
      environment: {
        isCleanEnvironment: async () => false,
        inspectTargetCounts: async () => ({ sources: 5 }),
        applySchemaMigration: async () => ({ appliedMigrationCount: 1 }),
        restoreTables: async () => {
          tablesRestored = true;
          return { restoredTableCount: 2, restoredRowCount: 61 };
        },
        verifyIntegrity: async () => ({ pass: true, details: {} }),
      },
    });

    const result = await service.executeRestoreDrill({
      manifest: validManifest,
      dryRun: false,
      confirmation: CONFIRM_RESTORE_OVERWRITE_TOKEN,
    });

    expect(result.dryRun).toBe(false);
    expect(tablesRestored).toBe(true);
    expect(result.restoredRowCount).toBe(61);
  });
});
