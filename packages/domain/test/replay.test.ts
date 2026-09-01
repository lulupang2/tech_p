import { describe, expect, it } from 'vitest';
import { classifyFailure, createReplayService, redactErrorSummary } from '../src/replay.js';

describe('replay', () => {
  const at = new Date('2026-09-02T00:00:00.000Z');
  it('queues deterministic run replay and reports duplicate delivery', async () => {
    const jobs: unknown[] = [];
    const service = createReplayService({
      targets: { exists: async () => true, isEnabled: async () => true },
      publisher: { publish: async (job) => { jobs.push(job); return { duplicate: jobs.length > 1 }; } },
    });
    const first = await service.replay({ scope: 'run', targetId: 'run-1', requestedAt: at });
    const second = await service.replay({ scope: 'run', targetId: 'run-1', requestedAt: at });
    expect(first.status).toBe('queued');
    expect(second.status).toBe('duplicate');
    expect(first.jobs[0]?.naturalKey).toBe('replay:v1:run:run-1:normalization');
    expect(first.jobs[0]?.requestedAt).toBe(at.toISOString());
  });
  it('does not enqueue disabled or unknown targets', async () => {
    let published = 0;
    const service = createReplayService({ targets: { exists: async (scope, id) => id !== 'missing', isEnabled: async () => false }, publisher: { publish: async () => { published++; return { duplicate: false }; } } });
    await expect(service.replay({ scope: 'raw', targetId: 'missing', requestedAt: at })).rejects.toThrow('missing');
    expect((await service.replay({ scope: 'raw', targetId: 'disabled', requestedAt: at })).status).toBe('skipped_disabled');
    expect(published).toBe(0);
  });
  it('requires stage and classifies bounded failures', async () => {
    await expect(createReplayService({ targets: { exists: async () => true, isEnabled: async () => true }, publisher: { publish: async () => ({ duplicate: false }) } }).replay({ scope: 'stage', targetId: 'raw-1', requestedAt: at })).rejects.toThrow('Stage replay requires stage');
    expect(classifyFailure({ isTransient: true }, 1, 3)).toBe('retryable');
    expect(classifyFailure({ isTransient: true }, 3, 3)).toBe('dead_letter');
    expect(classifyFailure({ code: 'POLICY_VIOLATION' }, 1, 3)).toBe('quarantined');
    expect(redactErrorSummary('token=abc cookie=def')).toContain('[REDACTED]');
  });
});
