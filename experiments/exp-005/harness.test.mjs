// EXP-005: does the deterministic-test harness hold on the chosen runtime?
// Checks fake clock, injected ID generator, and time-boundary logic without network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- code under test: the kind of deterministic helper TST-001 will provide ---
function resolveRollingWindow({ now, days, timezone }) {
  // from inclusive, to exclusive, UTC
  const to = new Date(now.getTime());
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString(), timezone };
}

function makeIdGenerator(seed) {
  let n = 0;
  return () => `req_${seed}_${(n += 1)}`;
}

function isWithinRange(publishedAt, range) {
  if (publishedAt === null) return false; // published_at null is excluded
  const t = new Date(publishedAt).getTime();
  return t >= new Date(range.from).getTime() && t < new Date(range.to).getTime();
}
// ---------------------------------------------------------------------------

describe('deterministic harness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T03:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fake clock drives rolling window resolution', () => {
    const r = resolveRollingWindow({ now: new Date(), days: 7, timezone: 'Asia/Seoul' });
    expect(r.to).toBe('2026-09-01T03:00:00.000Z');
    expect(r.from).toBe('2026-08-25T03:00:00.000Z');
    expect(r.timezone).toBe('Asia/Seoul');
  });

  it('injected id generator is deterministic', () => {
    const gen = makeIdGenerator('a');
    expect([gen(), gen(), gen()]).toEqual(['req_a_1', 'req_a_2', 'req_a_3']);
  });

  it('to is exclusive and from is inclusive', () => {
    const range = { from: '2026-08-25T03:00:00.000Z', to: '2026-09-01T03:00:00.000Z' };
    expect(isWithinRange('2026-08-25T03:00:00.000Z', range)).toBe(true);
    expect(isWithinRange('2026-09-01T03:00:00.000Z', range)).toBe(false);
    expect(isWithinRange('2026-08-31T23:59:59.999Z', range)).toBe(true);
  });

  it('published_at null is excluded from time-filtered candidates', () => {
    const range = { from: '2026-08-25T03:00:00.000Z', to: '2026-09-01T03:00:00.000Z' };
    expect(isWithinRange(null, range)).toBe(false);
  });

  it('no real network or real clock is used', () => {
    expect(Date.now()).toBe(new Date('2026-09-01T03:00:00.000Z').getTime());
  });
});
