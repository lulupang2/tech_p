import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  parseCollectionDelivery,
  parseCoverageQuery,
  parsePartitionPlan,
  RegisterTargetSchema,
  ReviewCandidateSchema,
  ReconcileModelWorkSchema,
} from '../src/coverage.js';

describe('coverage input boundaries', () => {
  it('rejects legacy queues, arbitrary payloads and non-ID deliveries', () => {
    const deliveryId = '11111111-1111-4111-8111-111111111111';
    expect(parseCollectionDelivery({ schemaVersion: 2, deliveryId }).deliveryId).toBe(deliveryId);
    expect(() => parseCollectionDelivery({ schemaVersion: 1, deliveryId })).toThrow();
    expect(() =>
      parseCollectionDelivery({ schemaVersion: 2, deliveryId, rawPayload: 'untrusted' }),
    ).toThrow();
    expect(() =>
      parseCollectionDelivery({ schemaVersion: 2, deliveryId: '../../secret' }),
    ).toThrow();
  });
  it('rejects backwards, unbounded and non-UTC windows', () => {
    const query = { from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' };
    expect(parseCoverageQuery(query).from).toBe(query.from);
    expect(() => parseCoverageQuery({ from: query.to, to: query.from })).toThrow();
    expect(() => parseCoverageQuery({ ...query, from: '2024-08-01T00:00:00Z' })).toThrow();
    expect(() => parseCoverageQuery({ ...query, from: '2026-08-01T09:00:00+09:00' })).toThrow();
  });
  it('rejects rights grants through target registration and requires bounded ops commands', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const target = {
      sourceId: id,
      sourceKey: 'github_releases',
      canonicalIdentity: 'fixture/repo',
      selector: { kind: 'repository', owner: 'fixture', repository: 'repo' },
      capability: {
        historyMode: 'paginated_history',
        timeBasis: 'published_at',
        cursorVersion: 1,
        stablePagination: true,
        canCollect: true,
        reviewedAt: '2026-09-08T00:00:00Z',
        earliestAvailableAt: null,
        canSearch: true,
        canDiscover: true,
      },
      policyVersion: 'reviewed-fixture',
      topicIds: [],
      taxonomyVersion: 'fixture-1',
      enabled: false,
      cadenceMs: 60000,
      overlapMs: 0,
    };
    expect(Value.Check(RegisterTargetSchema, target)).toBe(true);
    expect(
      Value.Check(RegisterTargetSchema, { ...target, policy: { approved: true, embed: true } }),
    ).toBe(false);
    expect(Value.Check(RegisterTargetSchema, { ...target, enabled: true })).toBe(false);
    expect(
      Value.Check(ReviewCandidateSchema, {
        actor: 'operator',
        idempotencyKey: 'review-1',
        decision: 'accepted',
        targetId: id,
      }),
    ).toBe(true);
    expect(Value.Check(ReviewCandidateSchema, { decision: 'accepted', targetId: id })).toBe(false);
    expect(
      Value.Check(ReconcileModelWorkSchema, {
        actor: 'operator',
        idempotencyKey: 'reconcile-1',
        expectedEpoch: 1,
        evidenceReference: 'provider-receipt-1',
        actualUnits: -1,
        actualTokens: 1,
        outcome: 'completed',
      }),
    ).toBe(false);
    expect(() =>
      parsePartitionPlan({
        targetRevisionId: id,
        mode: 'backfill',
        scopeKey: 'fixture',
        from: '2026-09-08T00:00:00Z',
        to: '2026-09-07T00:00:00Z',
        timeBasis: 'published_at',
        workflowVersion: '1',
        dryRun: true,
      }),
    ).toThrow();
  });
});
