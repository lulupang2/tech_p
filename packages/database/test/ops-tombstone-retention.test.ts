import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import type { schema } from '../src/schema/index.js';
import {
  createDatabaseTombstoneTarget,
  createDatabaseRetentionTarget,
  createDatabaseRestoreEnvironment,
} from '../src/ops.js';
import {
  createTombstoneService,
  createRetentionService,
  createBackupRestoreService,
  CONFIRM_IRREVERSIBLE_PURGE_TOKEN,
  CONFIRM_RESTORE_OVERWRITE_TOKEN,
  IrreversibleActionRefusalError,
  UnsafeRestoreRefusalError,
} from '@techpulse/domain';

describe('Database Tombstone and Search Exclusion Contract', () => {
  it('tombstone on source disables source and excludes revisions from search while preserving provenance', async () => {
    // In-memory test state representing PostgreSQL state
    const sourceState = { id: 'src-1', key: 'users_rust_lang', enabled: true };
    const rawItemsState = [
      { id: 'raw-1', sourceId: 'src-1', externalId: 'post-101', payloadHash: 'a'.repeat(64) },
      { id: 'raw-2', sourceId: 'src-1', externalId: 'post-102', payloadHash: 'b'.repeat(64) },
    ];
    const revisionsState = [
      {
        id: 'rev-1',
        documentId: 'doc-1',
        rawItemId: 'raw-1',
        title: 'Rust Async Foundations',
        status: 'searchable',
        searchableAt: new Date('2026-08-01T00:00:00.000Z'),
      },
      {
        id: 'rev-2',
        documentId: 'doc-2',
        rawItemId: 'raw-2',
        title: 'Rust Cargo Workspaces',
        status: 'searchable',
        searchableAt: new Date('2026-08-02T00:00:00.000Z'),
      },
    ];

    // Mock db targeting the in-memory state
    const mockDb = {
      query: {
        sources: {
          findFirst: async () => sourceState,
        },
      },
      select: () => ({
        from: () => ({
          where: () => rawItemsState.map((r) => ({ id: r.id })),
        }),
      }),
      transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
        const tx = {
          query: {
            sources: {
              findFirst: async () => sourceState,
            },
          },
          update: () => ({
            set: (vals: { enabled?: boolean; status?: string }) => ({
              where: () => {
                if (vals.enabled !== undefined) {
                  sourceState.enabled = vals.enabled;
                }
                if (vals.status) {
                  for (const rev of revisionsState) {
                    rev.status = vals.status;
                  }
                }
                return {
                  returning: () => [{ id: 'rev-1' }, { id: 'rev-2' }],
                };
              },
            }),
          }),
          select: () => ({
            from: () => ({
              where: () => rawItemsState.map((r) => ({ id: r.id })),
            }),
          }),
        };
        return await cb(tx);
      },
    } as unknown as NeonDatabase<typeof schema>;
    const tombstoneTarget = createDatabaseTombstoneTarget(mockDb);
    const tombstoneService = createTombstoneService({ targets: tombstoneTarget });

    // Step 1: Initial state is searchable
    const searchableBefore = revisionsState.filter((r) => r.status === 'searchable');
    assert.equal(searchableBefore.length, 2);
    assert.equal(sourceState.enabled, true);

    // Step 2: Apply tombstone to source
    const result = await tombstoneService.createTombstone({
      scope: 'source',
      targetKey: 'users_rust_lang',
      reason: 'Upstream user deletion request',
      requestedBy: 'operator_dan',
    });

    assert.equal(result.scope, 'source');
    assert.equal(result.affectedRevisionCount, 2);
    assert.equal(sourceState.enabled, false);

    // Step 3: Search exclusion verification
    // FTS and Vector search filter by dr.status = 'searchable'
    const searchableAfter = revisionsState.filter((r) => r.status === 'searchable');
    assert.equal(searchableAfter.length, 0, 'Tombstoned revisions must be excluded from search');

    const tombstonedRevisions = revisionsState.filter((r) => r.status === 'tombstoned');
    assert.equal(tombstonedRevisions.length, 2, 'Revisions are marked tombstoned');

    // Step 4: Provenance preservation verification
    assert.equal(rawItemsState.length, 2, 'Raw items must NOT be deleted');
    assert.equal(revisionsState.length, 2, 'Revisions must NOT be deleted');
    assert.equal(revisionsState[0]?.rawItemId, 'raw-1', 'Provenance link is preserved');

    // Step 5: Reindex / Un-tombstone verification
    const reindexRes = await tombstoneService.reindex('source', 'users_rust_lang', 'operator_dan');
    assert.equal(reindexRes.restoredRevisionCount, 2);
    assert.equal(sourceState.enabled, true);

    const searchableRestored = revisionsState.filter((r) => r.status === 'searchable');
    assert.equal(searchableRestored.length, 2, 'Revisions are restored to searchable');
  });
});

describe('Database Retention Target & Confirmation Protections', () => {
  it('counts retention candidates and enforces irreversible confirmation guard', async () => {
    // Mock raw items state

    const mockDb = {
      select: () => {
        const chain: unknown = {
          from: () => {
            const inner: unknown = {
              where: () => [{ count: 1 }],
              [Symbol.iterator]: function* () {
                yield { id: 'src-1', key: 'github_releases' };
              },
            };
            return inner;
          },
        };
        return chain;
      },
      transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
        const tx = {
          select: () => ({
            from: () => [{ id: 'src-1', key: 'github_releases' }],
          }),
          delete: () => ({
            where: () => ({
              returning: () => [{ id: 'raw-1' }],
            }),
          }),
        };
        return await cb(tx);
      },
    } as unknown as NeonDatabase<typeof schema>;
    const retentionTarget = createDatabaseRetentionTarget(mockDb);
    const retentionService = createRetentionService({ targets: retentionTarget });

    // 1. Dry-run without execution
    const dryRunResult = await retentionService.evaluateAndExecute({
      dryRun: true,
      referenceDate: new Date('2026-09-02T00:00:00.000Z'),
    });

    assert.equal(dryRunResult.dryRun, true);
    assert.equal(dryRunResult.executed, false);

    // 2. Refusal without confirmation token
    await assert.rejects(async () => {
      await retentionService.evaluateAndExecute({
        dryRun: false,
        referenceDate: new Date('2026-09-02T00:00:00.000Z'),
      });
    }, IrreversibleActionRefusalError);

    // 3. Execution with valid token
    const purgeResult = await retentionService.evaluateAndExecute({
      dryRun: false,
      confirmation: CONFIRM_IRREVERSIBLE_PURGE_TOKEN,
      referenceDate: new Date('2026-09-02T00:00:00.000Z'),
    });

    assert.equal(purgeResult.dryRun, false);
    assert.equal(purgeResult.executed, true);
  });
});

describe('Database Restore Environment & Drill Safety', () => {
  it('safely handles empty vs non-empty target environment in restore drill', async () => {
    let cleanEnv = true;

    const mockDb = {
      select: () => ({
        from: () => [{ count: cleanEnv ? 0 : 50 }],
      }),
    } as unknown as NeonDatabase<typeof schema>;
    const envAdapter = createDatabaseRestoreEnvironment(mockDb);
    const restoreService = createBackupRestoreService({ environment: envAdapter });

    const manifest = {
      formatVersion: 'v1.0.0',
      backupId: 'backup_drill_test',
      createdAt: '2026-09-02T00:00:00.000Z',
      vectorDimensions: 1536,
      tables: [{ tableName: 'sources', rowCount: 11, sha256Checksum: 'f'.repeat(64) }],
      totalRows: 11,
    };

    // 1. Clean environment drill passes
    cleanEnv = true;
    const cleanDrill = await restoreService.executeRestoreDrill({
      manifest,
      dryRun: false,
    });
    assert.equal(cleanDrill.targetWasClean, true);
    assert.equal(cleanDrill.restoredRowCount, 11);

    // 2. Non-empty environment drill refuses overwrite without explicit token
    cleanEnv = false;
    await assert.rejects(async () => {
      await restoreService.executeRestoreDrill({
        manifest,
        dryRun: false,
      });
    }, UnsafeRestoreRefusalError);

    // 3. Non-empty environment with CONFIRM_RESTORE_OVERWRITE succeeds
    const forceDrill = await restoreService.executeRestoreDrill({
      manifest,
      dryRun: false,
      confirmation: CONFIRM_RESTORE_OVERWRITE_TOKEN,
    });
    assert.equal(forceDrill.restoredRowCount, 11);
  });
});
