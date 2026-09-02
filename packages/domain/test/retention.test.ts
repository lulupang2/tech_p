import { describe, expect, it } from 'vitest';
import {
  computeRetentionCutoff,
  isRetentionCandidate,
  createRetentionService,
  CONFIRM_IRREVERSIBLE_PURGE_TOKEN,
  SOURCE_RAW_RETENTION_DAYS,
  DEFAULT_RAW_RETENTION_DAYS,
  IrreversibleActionRefusalError,
  InvalidRetentionRequestError,
  type RetentionAuditEvent,
  type RetentionCountSummary,
} from '../src/retention.js';

describe('Retention Policy and Dry-run Calculations', () => {
  const refDate = new Date('2026-09-02T12:00:00.000Z');

  it('computes exact cutoff timestamps for 90-day and 30-day retention policies', () => {
    const cutoff90 = computeRetentionCutoff(90, refDate);
    const cutoff30 = computeRetentionCutoff(30, refDate);

    // 90 days prior = 2026-06-04T12:00:00.000Z
    expect(cutoff90.toISOString()).toBe('2026-06-04T12:00:00.000Z');
    // 30 days prior = 2026-08-03T12:00:00.000Z
    expect(cutoff30.toISOString()).toBe('2026-08-03T12:00:00.000Z');

    expect(SOURCE_RAW_RETENTION_DAYS['github_releases']).toBe(90);
    expect(SOURCE_RAW_RETENTION_DAYS['users_rust_lang']).toBe(90);
    expect(SOURCE_RAW_RETENTION_DAYS['arxiv']).toBe(90);
    expect(SOURCE_RAW_RETENTION_DAYS['react_blog']).toBe(90);
    expect(SOURCE_RAW_RETENTION_DAYS['stack_exchange']).toBe(30);
    expect(SOURCE_RAW_RETENTION_DAYS['npm_registry']).toBe(30);
    expect(SOURCE_RAW_RETENTION_DAYS['github_search']).toBe(30);
    expect(SOURCE_RAW_RETENTION_DAYS['huggingface_hub']).toBe(30);
    expect(DEFAULT_RAW_RETENTION_DAYS).toBe(90);
  });

  it('rejects invalid retention days or invalid reference dates', () => {
    expect(() => computeRetentionCutoff(-5, refDate)).toThrow(InvalidRetentionRequestError);
    expect(() => computeRetentionCutoff(30, new Date('invalid'))).toThrow(InvalidRetentionRequestError);
  });

  it('evaluates retention candidate boundary conditions correctly', () => {
    const cutoff90 = computeRetentionCutoff(90, refDate); // 2026-06-04T12:00:00.000Z

    // 1 millisecond before cutoff -> candidate for purge
    const beforeCutoff = new Date(cutoff90.getTime() - 1);
    expect(isRetentionCandidate(beforeCutoff, 90, refDate)).toBe(true);

    // Exactly at cutoff -> preserved (not candidate)
    expect(isRetentionCandidate(cutoff90, 90, refDate)).toBe(false);

    // After cutoff -> preserved
    const afterCutoff = new Date(cutoff90.getTime() + 1000);
    expect(isRetentionCandidate(afterCutoff, 90, refDate)).toBe(false);

    // Null or invalid dates are not treated as candidates
    expect(isRetentionCandidate(null, 90, refDate)).toBe(false);
    expect(isRetentionCandidate('invalid-date', 90, refDate)).toBe(false);
  });
});

describe('Retention Service Dry-Run and Confirmation Guard', () => {
  const refDate = new Date('2026-09-02T12:00:00.000Z');

  const mockCounts: RetentionCountSummary = {
    rawItemsBySource: {
      github_releases: 15,
      stack_exchange: 42,
      users_rust_lang: 8,
      arxiv: 5,
      chrome_release_notes: 2,
      chrome_origin_trials: 1,
      react_blog: 0,
      npm_registry: 100,
      npm_downloads: 200,
      github_search: 50,
      huggingface_hub: 12,
    },
    pipelineEvents: 34,
    queryRuns: 88,
  };

  it('executes safe dry-run by default without executing purges', async () => {
    let purgeCalled = false;
    const auditLogs: RetentionAuditEvent[] = [];

    const service = createRetentionService({
      targets: {
        countCandidates: async () => mockCounts,
        purgeExpired: async () => {
          purgeCalled = true;
          return mockCounts;
        },
      },
      audit: {
        record: async (event) => {
          auditLogs.push(event);
        },
      },
    });

    const result = await service.evaluateAndExecute({
      referenceDate: refDate,
      dryRun: true,
      actor: { type: 'operator', ref: 'ops-user-1' },
    });

    expect(result.dryRun).toBe(true);
    expect(result.executed).toBe(false);
    expect(purgeCalled).toBe(false);
    expect(result.totalCandidates).toBe(435 + 34 + 88);
    expect(result.byCategory.rawItems).toBe(435);
    expect(result.byCategory.pipelineEvents).toBe(34);
    expect(result.byCategory.queryRuns).toBe(88);
    expect(result.bySource['stack_exchange']).toBe(42);

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]?.action).toBe('retention_dry_run');
    expect(auditLogs[0]?.dryRun).toBe(true);
    expect(auditLogs[0]?.actor?.ref).toBe('ops-user-1');
  });

  it('refuses destructive purge without explicit confirmation token', async () => {
    let purgeCalled = false;
    const auditLogs: RetentionAuditEvent[] = [];

    const service = createRetentionService({
      targets: {
        countCandidates: async () => mockCounts,
        purgeExpired: async () => {
          purgeCalled = true;
          return mockCounts;
        },
      },
      audit: {
        record: async (event) => {
          auditLogs.push(event);
        },
      },
    });

    // Case 1: dryRun: false, no confirmation
    await expect(
      service.evaluateAndExecute({
        referenceDate: refDate,
        dryRun: false,
      }),
    ).rejects.toThrow(IrreversibleActionRefusalError);

    // Case 2: dryRun: false, incorrect confirmation token
    await expect(
      service.evaluateAndExecute({
        referenceDate: refDate,
        dryRun: false,
        confirmation: 'yes_please_purge',
      }),
    ).rejects.toThrow(IrreversibleActionRefusalError);

    expect(purgeCalled).toBe(false);
    expect(auditLogs).toHaveLength(0);
  });

  it('executes destructive purge only when explicit confirmation token is passed', async () => {
    let purgeCalled = false;
    const auditLogs: RetentionAuditEvent[] = [];

    const service = createRetentionService({
      targets: {
        countCandidates: async () => mockCounts,
        purgeExpired: async () => {
          purgeCalled = true;
          return mockCounts;
        },
      },
      audit: {
        record: async (event) => {
          auditLogs.push(event);
        },
      },
    });

    const result = await service.evaluateAndExecute({
      referenceDate: refDate,
      dryRun: false,
      confirmation: CONFIRM_IRREVERSIBLE_PURGE_TOKEN,
      actor: { type: 'system_job', ref: 'retention_worker_01' },
    });

    expect(result.dryRun).toBe(false);
    expect(result.executed).toBe(true);
    expect(purgeCalled).toBe(true);
    expect(result.purgedCounts).toEqual(mockCounts);

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]?.action).toBe('retention_purge');
    expect(auditLogs[0]?.dryRun).toBe(false);
    expect(auditLogs[0]?.purgedCounts).toEqual(mockCounts);
    expect(auditLogs[0]?.actor?.ref).toBe('retention_worker_01');
  });
});
