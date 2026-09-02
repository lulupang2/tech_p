import { describe, expect, it } from 'vitest';
import {
  createTombstoneService,
  InvalidTombstoneRequestError,
  TombstoneTargetNotFoundError,
  type CreateTombstoneInput,
  type TombstoneAuditEvent,
} from '../src/tombstone.js';

describe('Tombstone Service and Audit Trail', () => {
  it('rejects invalid tombstone requests with empty fields', async () => {
    const service = createTombstoneService({
      targets: {
        exists: async () => true,
        applyTombstone: async () => ({ affectedRevisionCount: 1 }),
        restoreSearchable: async () => ({ restoredRevisionCount: 1 }),
      },
    });

    await expect(
      service.createTombstone({
        scope: 'source',
        targetKey: '',
        reason: 'Valid reason',
        requestedBy: 'operator',
      }),
    ).rejects.toThrow(InvalidTombstoneRequestError);

    await expect(
      service.createTombstone({
        scope: 'source',
        targetKey: 'users_rust_lang',
        reason: '   ',
        requestedBy: 'operator',
      }),
    ).rejects.toThrow(InvalidTombstoneRequestError);

    await expect(
      service.createTombstone({
        scope: 'source',
        targetKey: 'users_rust_lang',
        reason: 'Valid reason',
        requestedBy: '',
      }),
    ).rejects.toThrow(InvalidTombstoneRequestError);
  });

  it('rejects tombstone creation when target does not exist', async () => {
    const service = createTombstoneService({
      targets: {
        exists: async () => false,
        applyTombstone: async () => ({ affectedRevisionCount: 0 }),
        restoreSearchable: async () => ({ restoredRevisionCount: 0 }),
      },
    });

    await expect(
      service.createTombstone({
        scope: 'source',
        targetKey: 'non_existent_source',
        reason: 'Upstream DMCA takedown',
        requestedBy: 'compliance_team',
      }),
    ).rejects.toThrow(TombstoneTargetNotFoundError);
  });

  it('applies tombstone and generates immutable audit event', async () => {
    const auditLogs: TombstoneAuditEvent[] = [];
    let appliedInput: CreateTombstoneInput | null = null;

    const service = createTombstoneService({
      targets: {
        exists: async (scope, key) => key === 'users_rust_lang',
        applyTombstone: async (input) => {
          appliedInput = input;
          return { affectedRevisionCount: 14 };
        },
        restoreSearchable: async () => ({ restoredRevisionCount: 0 }),
      },
      audit: {
        record: async (event) => {
          auditLogs.push(event);
        },
      },
    });

    const result = await service.createTombstone({
      scope: 'source',
      targetKey: 'users_rust_lang',
      reason: 'Community forum content deletion notice',
      requestedBy: 'compliance_officer_42',
    });

    expect(result.scope).toBe('source');
    expect(result.targetKey).toBe('users_rust_lang');
    expect(result.affectedRevisionCount).toBe(14);
    expect(result.reason).toBe('Community forum content deletion notice');
    expect(appliedInput?.scope).toBe('source');

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]?.action).toBe('tombstone_create');
    expect(auditLogs[0]?.scope).toBe('source');
    expect(auditLogs[0]?.targetKey).toBe('users_rust_lang');
    expect(auditLogs[0]?.affectedCount).toBe(14);
    expect(auditLogs[0]?.requestedBy).toBe('compliance_officer_42');
  });

  it('reindexes and restores searchable status with audit log', async () => {
    const auditLogs: TombstoneAuditEvent[] = [];

    const service = createTombstoneService({
      targets: {
        exists: async (scope, key) => key === 'users_rust_lang',
        applyTombstone: async () => ({ affectedRevisionCount: 0 }),
        restoreSearchable: async (scope, key) => {
          expect(scope).toBe('source');
          expect(key).toBe('users_rust_lang');
          return { restoredRevisionCount: 14 };
        },
      },
      audit: {
        record: async (event) => {
          auditLogs.push(event);
        },
      },
    });

    const result = await service.reindex('source', 'users_rust_lang', 'admin_lead');

    expect(result.scope).toBe('source');
    expect(result.targetKey).toBe('users_rust_lang');
    expect(result.restoredRevisionCount).toBe(14);

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]?.action).toBe('tombstone_reindex');
    expect(auditLogs[0]?.scope).toBe('source');
    expect(auditLogs[0]?.targetKey).toBe('users_rust_lang');
    expect(auditLogs[0]?.affectedCount).toBe(14);
    expect(auditLogs[0]?.requestedBy).toBe('admin_lead');
  });
});
