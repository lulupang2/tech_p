import { describe, expect, it } from 'vitest';
import {
  CollectionStateError,
  type CollectionDelivery,
  type CollectionMode,
  type CollectionPageRequest,
  type CollectionPageResult,
  type CollectionPartition,
  type CollectionStatePort,
  type CollectionTargetRevision,
  type CollectorPagePort,
  type DocumentRepositoryPort,
  type DocumentRevisionRecord,
  type MetricObservationRepositoryPort,
  type NormalizationServicePort,
  type PageCommit,
  type PipelineEventRepositoryPort,
  type RawItemRepositoryPort,
} from '@techpulse/domain';
import { createPartitionRuntime, planTargetPartitions } from '../src/partition-runtime.js';
import {
  DELIVERY_JOB_SCHEMA_VERSION,
  WorkerJobValidationError,
  createCollectionDeliveryJobData,
  parseCollectionDeliveryJobData,
} from '../src/jobs.js';

interface FakeRawItem {
  id: string;
  sourceId: string;
  externalId: string;
  canonicalUrl: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  publishedAt: Date;
}

interface FakeMembership {
  partitionId: string;
  rawItemId: string;
  revisionId: string | null;
}

interface FakeCheckpoint {
  partitionId: string;
  pageSequence: number;
  disposition: string;
  itemsCount: number;
}

function createFakeCollectionState(): CollectionStatePort & {
  targets: Map<string, CollectionTargetRevision>;
  partitions: Map<string, CollectionPartition>;
  deliveries: Map<
    string,
    CollectionDelivery & { mode?: CollectionMode; notBefore: Date; sentAt: Date | null }
  >;
  rawItems: Map<string, FakeRawItem>;
  memberships: FakeMembership[];
  checkpoints: FakeCheckpoint[];
  runs: Map<string, { status: string; partitionId: string }>;
} {
  const targets = new Map<string, CollectionTargetRevision>();
  const partitions = new Map<string, CollectionPartition>();
  const deliveries = new Map<
    string,
    CollectionDelivery & { mode?: CollectionMode; notBefore: Date; sentAt: Date | null }
  >();
  const rawItems = new Map<string, FakeRawItem>();
  const memberships: FakeMembership[] = [];
  const checkpoints: FakeCheckpoint[] = [];
  const runs = new Map<string, { status: string; partitionId: string }>();

  let idCounter = 1;
  const nextId = (prefix: string) => `${prefix}-${idCounter++}`;

  const state: CollectionStatePort & {
    targets: Map<string, CollectionTargetRevision>;
    partitions: Map<string, CollectionPartition>;
    deliveries: Map<
      string,
      CollectionDelivery & { mode?: CollectionMode; notBefore: Date; sentAt: Date | null }
    >;
    rawItems: Map<string, FakeRawItem>;
    memberships: FakeMembership[];
    checkpoints: FakeCheckpoint[];
    runs: Map<string, { status: string; partitionId: string }>;
  } = {
    targets,
    partitions,
    deliveries,
    rawItems,
    memberships,
    checkpoints,
    runs,

    async registerTarget(input) {
      const id = nextId('revision');
      const target: CollectionTargetRevision = {
        ...input,
        id,
        targetId: nextId('target'),
        configHash: `hash-${id}`,
        createdAt: new Date(),
      };
      targets.set(id, target);
      return target;
    },

    async getTargetRevision(id) {
      return targets.get(id) ?? null;
    },

    async setTargetEnabled(targetId, enabled) {
      for (const [id, target] of targets.entries()) {
        if (target.targetId === targetId || target.id === targetId) {
          targets.set(id, { ...target, enabled });
        }
      }
    },

    async listTargets() {
      return Array.from(targets.values());
    },
    async planPartition(plan, now) {
      const target = targets.get(plan.targetRevisionId);
      if (!target) throw new CollectionStateError('not_found');
      if (
        !target.enabled ||
        !target.policy.approved ||
        !target.policy.fetch ||
        !target.policy.store
      ) {
        throw new CollectionStateError('policy_blocked');
      }

      const id = nextId('partition');
      const partition: CollectionPartition = {
        ...plan,
        id,
        state: 'pending',
        pageSequence: 0,
        cursor: null,
        leaseEpoch: 0,
        leaseUntil: null,
        nextDueAt: now,
        reason: null,
      };
      partitions.set(id, partition);

      const deliveryId = nextId('del');
      deliveries.set(deliveryId, {
        id: deliveryId,
        kind: 'collection',
        partitionId: id,
        pageSequence: 0,
        rawItemId: null,
        revisionId: null,
        completedAt: null,
        leaseEpoch: 0,
        leaseUntil: null,
        notBefore: now,
        sentAt: null,
        mode: plan.mode,
      });

      return partition;
    },

    async getPartition(id) {
      return partitions.get(id) ?? null;
    },

    async listPartitions() {
      return Array.from(partitions.values());
    },

    async claimPage(partitionId, pageSequence, now, leaseMs) {
      const partition = partitions.get(partitionId);
      if (!partition) return null;
      const target = targets.get(partition.targetRevisionId);
      if (!target || !target.enabled || !target.policy.approved) return null;

      if (partition.pageSequence !== pageSequence) return null;
      if (['completed', 'failed', 'cancelled'].includes(partition.state)) return null;
      if (partition.leaseUntil && partition.leaseUntil > now) return null;

      const leaseEpoch = partition.leaseEpoch + 1;
      const leaseUntil = new Date(now.getTime() + leaseMs);
      const runId = nextId('run');

      const updated: CollectionPartition = {
        ...partition,
        state: 'running',
        leaseEpoch,
        leaseUntil,
      };
      partitions.set(partitionId, updated);
      runs.set(runId, { status: 'running', partitionId });

      return {
        partition: updated,
        target,
        runId,
      };
    },

    async renewPage(claim, now, leaseMs) {
      const partition = partitions.get(claim.partition.id);
      if (!partition) return false;
      const target = targets.get(claim.target.id);
      if (!target || !target.enabled) return false;

      if (partition.leaseEpoch !== claim.partition.leaseEpoch || partition.state !== 'running') {
        return false;
      }

      partitions.set(partition.id, {
        ...partition,
        leaseUntil: new Date(now.getTime() + leaseMs),
      });
      return true;
    },

    async commitPage({ claim, result, now }: PageCommit) {
      const partition = partitions.get(claim.partition.id);
      if (!partition) throw new CollectionStateError('not_found');
      const target = targets.get(claim.target.id);
      if (!target || !target.enabled || !target.policy.approved) {
        throw new CollectionStateError('policy_blocked');
      }

      // Fencing check: ensure lease was not stolen / expired
      if (
        partition.leaseEpoch !== claim.partition.leaseEpoch ||
        partition.state !== 'running' ||
        (partition.leaseUntil && partition.leaseUntil < now)
      ) {
        throw new CollectionStateError('stale_lease');
      }

      // Persist raw items & memberships & normalization outbox
      for (const item of result.items) {
        const rawId = nextId('raw');
        rawItems.set(rawId, {
          id: rawId,
          sourceId: target.sourceId,
          externalId: item.externalId,
          canonicalUrl:
            (item.metadata?.['canonicalUrl'] as string) ?? `https://example.com/${item.externalId}`,
          payloadHash: item.rawHash,
          payload: item.payload,
          publishedAt: item.publishedAt,
        });

        memberships.push({
          partitionId: partition.id,
          rawItemId: rawId,
          revisionId: null,
        });

        const normDelId = nextId('del');
        deliveries.set(normDelId, {
          id: normDelId,
          kind: 'normalization',
          partitionId: partition.id,
          pageSequence: partition.pageSequence,
          rawItemId: rawId,
          revisionId: null,
          completedAt: null,
          leaseEpoch: 0,
          leaseUntil: null,
          notBefore: now,
          sentAt: null,
          mode: partition.mode,
        });
      }

      checkpoints.push({
        partitionId: partition.id,
        pageSequence: partition.pageSequence,
        disposition: result.disposition,
        itemsCount: result.items.length,
      });

      const nextSequence = partition.pageSequence + 1;
      const nextState =
        result.disposition === 'continue'
          ? 'pending'
          : result.disposition === 'complete'
            ? 'completed'
            : result.disposition === 'deferred'
              ? 'deferred'
              : 'partial';

      partitions.set(partition.id, {
        ...partition,
        pageSequence: nextSequence,
        cursor: result.nextCursor,
        state: nextState,
        leaseUntil: null,
        nextDueAt: result.retryAt ?? now,
        reason: result.reason,
      });

      // Complete current collection delivery outbox
      for (const [delId, del] of deliveries.entries()) {
        if (
          del.partitionId === partition.id &&
          del.kind === 'collection' &&
          del.pageSequence === partition.pageSequence
        ) {
          deliveries.set(delId, { ...del, completedAt: now });
        }
      }

      // If continue or deferred, stage next collection delivery
      if (result.disposition === 'continue' || result.disposition === 'deferred') {
        const nextDelId = nextId('del');
        deliveries.set(nextDelId, {
          id: nextDelId,
          kind: 'collection',
          partitionId: partition.id,
          pageSequence: nextSequence,
          rawItemId: null,
          revisionId: null,
          completedAt: null,
          leaseEpoch: 0,
          leaseUntil: null,
          notBefore: result.retryAt ?? now,
          sentAt: null,
          mode: partition.mode,
        });
      }
    },

    async failPage(claim, reason, retryAt, now) {
      const partition = partitions.get(claim.partition.id);
      if (!partition) throw new CollectionStateError('not_found');

      if (partition.leaseEpoch !== claim.partition.leaseEpoch || partition.state !== 'running') {
        throw new CollectionStateError('stale_lease');
      }

      partitions.set(partition.id, {
        ...partition,
        state: retryAt ? 'deferred' : 'failed',
        reason: reason.slice(0, 128),
        nextDueAt: retryAt ?? now,
        leaseUntil: null,
      });
    },

    async resumePartition(id, now) {
      const partition = partitions.get(id);
      if (!partition) throw new CollectionStateError('not_found');
      const updated: CollectionPartition = {
        ...partition,
        state: 'pending',
        nextDueAt: now,
        leaseUntil: null,
      };
      partitions.set(id, updated);
      return updated;
    },

    async claimDeliveries(now, limit, leaseMs, mode) {
      const claimed: CollectionDelivery[] = [];
      for (const [id, del] of deliveries.entries()) {
        if (claimed.length >= limit) break;
        if (del.completedAt !== null) continue;
        if (del.notBefore > now) continue;
        if (del.leaseUntil && del.leaseUntil > now) continue;

        // Redis delivery loss recovery: if sentAt is set, only re-claim if sent > 30s ago
        if (del.sentAt && now.getTime() - del.sentAt.getTime() < 30_000) continue;

        // Filter by mode if specified
        if (mode && del.mode && del.mode !== mode) continue;

        const targetRev = targets.get(partitions.get(del.partitionId)?.targetRevisionId ?? '');
        if (targetRev && (!targetRev.enabled || !targetRev.policy.approved)) continue;

        const newEpoch = del.leaseEpoch + 1;
        const newLease = new Date(now.getTime() + leaseMs);
        const updated = {
          ...del,
          leaseEpoch: newEpoch,
          leaseUntil: newLease,
        };
        deliveries.set(id, updated);
        claimed.push(updated);
      }
      return claimed;
    },

    async getDelivery(id) {
      return deliveries.get(id) ?? null;
    },

    async markSent(id, leaseEpoch, now) {
      const del = deliveries.get(id);
      if (!del || del.leaseEpoch !== leaseEpoch || (del.leaseUntil && del.leaseUntil <= now)) {
        throw new CollectionStateError('stale_lease');
      }
      deliveries.set(id, { ...del, sentAt: now, leaseUntil: null });
    },

    async completeDelivery(id, now) {
      const del = deliveries.get(id);
      if (!del) throw new CollectionStateError('not_found');
      deliveries.set(id, { ...del, completedAt: now, leaseUntil: null });
    },

    async attachRevision(rawItemId, revisionId, now) {
      for (let i = 0; i < memberships.length; i++) {
        if (memberships[i]!.rawItemId === rawItemId) {
          memberships[i] = { ...memberships[i]!, revisionId };
          const embDelId = nextId('del');
          deliveries.set(embDelId, {
            id: embDelId,
            kind: 'embedding',
            partitionId: memberships[i]!.partitionId,
            pageSequence: 0,
            rawItemId: null,
            revisionId,
            completedAt: null,
            leaseEpoch: 0,
            leaseUntil: null,
            notBefore: now,
            sentAt: null,
          });
        }
      }
    },
  };

  return state;
}

function sampleTarget(overrides: Partial<CollectionTargetRevision> = {}): CollectionTargetRevision {
  return {
    id: 'rev-1',
    targetId: 'target-1',
    sourceId: 'source-1',
    sourceKey: 'github_releases',
    canonicalIdentity: 'https://github.com/techpulse/sample',
    configHash: 'hash-1',
    selector: { kind: 'repository', owner: 'techpulse', repository: 'sample' },
    capability: {
      cursorVersion: 1,
      historyMode: 'paginated_history',
      timeBasis: 'published_at',
      canCollect: true,
      reviewedAt: '2026-09-01T00:00:00Z',
      stablePagination: true,
      earliestAvailableAt: null,
      canSearch: false,
      canDiscover: false,
      itemUrlTemplate: 'https://github.com/techpulse/sample/releases/{externalId}',
    },
    policy: {
      approved: true,
      fetch: true,
      store: true,
      embed: true,
      modelInput: true,
      displayExcerpt: true,
      verbatimOnly: false,
      licenseId: 'MIT',
      retentionDays: null,
    },
    topicIds: ['topic-1'],
    cadenceMs: 3600000,
    overlapMs: 60000,
    taxonomyVersion: '1',
    enabled: true,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

describe('COV-004 Partition Runtime & Scheduling', () => {
  it('1. Duplicate scheduler/consumer idempotency: handles concurrent/repeat dispatch safely', async () => {
    const state = createFakeCollectionState();
    const target = await state.registerTarget(sampleTarget());
    await state.setTargetEnabled(target.targetId, true, new Date());

    const partitions = await planTargetPartitions(
      { stateRepository: state },
      {
        target,
        mode: 'incremental',
        window: {
          from: new Date('2026-09-01T00:00:00Z'),
          to: new Date('2026-09-01T01:00:00Z'),
        },
      },
    );
    expect(partitions).toHaveLength(1);
    const partitionId = partitions[0]!.id;

    let collectCallCount = 0;
    const fakeCollector: CollectorPagePort = {
      async collectPage(): Promise<CollectionPageResult> {
        collectCallCount++;
        return {
          items: [
            {
              externalId: 'v1.0.0',
              rawHash: 'hash-v1',
              payload: { title: 'Release 1.0.0' },
              publishedAt: new Date('2026-09-01T00:30:00Z'),
              metadata: { canonicalUrl: 'https://example.com/v1.0.0' },
            },
          ],
          nextCursor: null,
          disposition: 'complete',
          reason: null,
          retryAt: null,
          requests: 1,
          bytes: 1024,
        };
      },
    };

    const runtime = createPartitionRuntime({
      stateRepository: state,
      collectorResolver: () => fakeCollector,
    });

    // First cycle executes collection and marks completed
    const cycle1 = await runtime.tick();
    expect(cycle1.incremental.processedCount).toBe(1);
    expect(collectCallCount).toBe(1);

    // Second cycle: delivery is completed, should not re-execute
    const cycle2 = await runtime.tick();
    expect(cycle2.incremental.claimedCount).toBe(0);
    expect(cycle2.incremental.processedCount).toBe(0);
    expect(collectCallCount).toBe(1);

    const partition = await state.getPartition(partitionId);
    expect(partition?.state).toBe('completed');
    expect(state.checkpoints).toHaveLength(1);
  });

  it('2. Outbox sent-only recovery: recovers uncompleted deliveries after Redis loss or timeout', async () => {
    const state = createFakeCollectionState();
    const target = await state.registerTarget(sampleTarget());
    await state.setTargetEnabled(target.targetId, true, new Date('2026-09-01T00:00:00Z'));

    const now1 = new Date('2026-09-01T00:00:00Z');
    await planTargetPartitions(
      { stateRepository: state, now: () => now1 },
      {
        target,
        mode: 'incremental',
        window: {
          from: new Date('2026-09-01T00:00:00Z'),
          to: new Date('2026-09-01T01:00:00Z'),
        },
      },
    );
    // Claim and mark sent (simulating Redis dispatch)
    const claimed = await state.claimDeliveries(now1, 10, 10_000);
    expect(claimed).toHaveLength(1);
    await state.markSent(claimed[0]!.id, claimed[0]!.leaseEpoch, now1);

    // Redis message was lost! Delivery was sent at now1, but never committed.
    // At now1 + 5s (less than 30s timeout and lease active): claimDeliveries will NOT reclaim it
    const earlyClaim = await state.claimDeliveries(new Date('2026-09-01T00:00:05Z'), 10, 10_000);
    expect(earlyClaim).toHaveLength(0);

    // At now1 + 35s (> 30s timeout and lease expired): claimDeliveries successfully re-claims!
    const recoveredTime = new Date('2026-09-01T00:00:35Z');
    const recoveredClaim = await state.claimDeliveries(recoveredTime, 10, 10_000);
    expect(recoveredClaim).toHaveLength(1);
    expect(recoveredClaim[0]!.id).toBe(claimed[0]!.id);
    expect(recoveredClaim[0]!.leaseEpoch).toBe(claimed[0]!.leaseEpoch + 1);
  });

  it('3. Page commit-before/after kill behavior: ensures clean crash recovery', async () => {
    const state = createFakeCollectionState();
    const target = await state.registerTarget(sampleTarget());
    await state.setTargetEnabled(target.targetId, true, new Date());

    const [partition] = await planTargetPartitions(
      { stateRepository: state },
      {
        target,
        mode: 'backfill',
        window: {
          from: new Date('2026-08-01T00:00:00Z'),
          to: new Date('2026-09-01T00:00:00Z'),
        },
      },
    );

    const now = new Date('2026-09-01T00:00:00Z');
    // Case A: Worker claims page 0, then crashes BEFORE commitPage
    const claim1 = await state.claimPage(partition!.id, 0, now, 5_000);
    expect(claim1).not.toBeNull();
    // (Worker crashes here, lease expires at now + 5000)

    // Another worker tries before expiry -> returns null (fenced by lease)
    const tooEarly = await state.claimPage(
      partition!.id,
      0,
      new Date(now.getTime() + 2_000),
      5_000,
    );
    expect(tooEarly).toBeNull();

    // After lease expiry -> new worker claims same page sequence 0
    const claim2 = await state.claimPage(partition!.id, 0, new Date(now.getTime() + 6_000), 5_000);
    expect(claim2).not.toBeNull();
    expect(claim2!.partition.pageSequence).toBe(0);

    // Case B: Worker commits page 0 with 'continue'
    await state.commitPage({
      claim: claim2!,
      result: {
        items: [
          {
            externalId: 'item-1',
            rawHash: 'hash-1',
            payload: {},
            publishedAt: now,
            metadata: { canonicalUrl: 'https://example.com/1' },
          },
        ],
        nextCursor: 'cursor-page-2',
        disposition: 'continue',
        reason: null,
        retryAt: null,
        requests: 1,
        bytes: 100,
      },
      now: new Date(now.getTime() + 7_000),
    });

    // Partition is now at pageSequence 1
    const pAfterCommit = await state.getPartition(partition!.id);
    expect(pAfterCommit?.pageSequence).toBe(1);
    expect(pAfterCommit?.state).toBe('pending');

    // (If worker crashes after commit, next worker claims pageSequence 1, never re-executes page 0)
    const claimPage1 = await state.claimPage(
      partition!.id,
      1,
      new Date(now.getTime() + 8_000),
      5_000,
    );
    expect(claimPage1).not.toBeNull();
    expect(claimPage1!.partition.pageSequence).toBe(1);
  });

  it('4. Source / Target disable: rejects planning and claiming disabled targets', async () => {
    const state = createFakeCollectionState();
    const target = await state.registerTarget(sampleTarget({ enabled: false }));

    // Planning on disabled target throws policy_blocked
    await expect(
      planTargetPartitions(
        { stateRepository: state },
        {
          target,
          mode: 'incremental',
          window: {
            from: new Date('2026-09-01T00:00:00Z'),
            to: new Date('2026-09-01T01:00:00Z'),
          },
        },
      ),
    ).rejects.toThrow('policy_blocked');

    // Enable target and plan partition
    await state.setTargetEnabled(target.targetId, true, new Date());
    const enabledTarget = (await state.getTargetRevision(target.id))!;
    const [partition] = await planTargetPartitions(
      { stateRepository: state },
      {
        target: enabledTarget,
        mode: 'incremental',
        window: {
          from: new Date('2026-09-01T00:00:00Z'),
          to: new Date('2026-09-01T01:00:00Z'),
        },
      },
    );

    // Disable target mid-flight
    await state.setTargetEnabled(target.targetId, false, new Date());

    // claimPage returns null for disabled target
    const claim = await state.claimPage(partition!.id, 0, new Date(), 5_000);
    expect(claim).toBeNull();
  });

  it('5. Stale lease rejection: rejects commit or fail from expired/fenced workers', async () => {
    const state = createFakeCollectionState();
    const target = await state.registerTarget(sampleTarget());
    await state.setTargetEnabled(target.targetId, true, new Date());

    const [partition] = await planTargetPartitions(
      { stateRepository: state },
      {
        target,
        mode: 'incremental',
        window: {
          from: new Date('2026-09-01T00:00:00Z'),
          to: new Date('2026-09-01T01:00:00Z'),
        },
      },
    );

    const now = new Date('2026-09-01T00:00:00Z');
    // Worker 1 claims with 2-second lease
    const worker1Claim = await state.claimPage(partition!.id, 0, now, 2_000);
    expect(worker1Claim).not.toBeNull();

    // Worker 1 stalls for 5 seconds. Lease expires.
    // Worker 2 claims partition at now + 3s (lease epoch increments)
    const worker2Claim = await state.claimPage(
      partition!.id,
      0,
      new Date(now.getTime() + 3_000),
      5_000,
    );
    expect(worker2Claim).not.toBeNull();
    expect(worker2Claim!.partition.leaseEpoch).toBe(worker1Claim!.partition.leaseEpoch + 1);

    // Worker 1 wakes up and attempts to commitPage -> MUST throw stale_lease
    await expect(
      state.commitPage({
        claim: worker1Claim!,
        result: {
          items: [],
          nextCursor: null,
          disposition: 'complete',
          reason: null,
          retryAt: null,
          requests: 1,
          bytes: 0,
        },
        now: new Date(now.getTime() + 4_000),
      }),
    ).rejects.toThrow('stale_lease');
  });

  it('6. Missing downstream stage recovery: outbox consumer normalizes raw item and stages embedding', async () => {
    const state = createFakeCollectionState();
    const target = await state.registerTarget(sampleTarget());
    await state.setTargetEnabled(target.targetId, true, new Date());

    const [partition] = await planTargetPartitions(
      { stateRepository: state },
      {
        target,
        mode: 'incremental',
        window: {
          from: new Date('2026-09-01T00:00:00Z'),
          to: new Date('2026-09-01T01:00:00Z'),
        },
      },
    );

    const claim = (await state.claimPage(partition!.id, 0, new Date(), 10_000))!;
    await state.commitPage({
      claim,
      result: {
        items: [
          {
            externalId: 'post-100',
            rawHash: 'hash-100',
            payload: { title: 'Deep Dive into TypeScript 5.9', body: 'New features...' },
            publishedAt: new Date(),
            metadata: { canonicalUrl: 'https://techpulse.dev/posts/100' },
          },
        ],
        nextCursor: null,
        disposition: 'complete',
        reason: null,
        retryAt: null,
        requests: 1,
        bytes: 2048,
      },
      now: new Date(),
    });

    // commitPage automatically enqueued normalization delivery in outbox!
    const normDeliveries = Array.from(state.deliveries.values()).filter(
      (d) => d.kind === 'normalization',
    );
    expect(normDeliveries).toHaveLength(1);
    const rawItemId = normDeliveries[0]!.rawItemId!;

    // Set up mock normalization repositories
    const fakeRawRepo: RawItemRepositoryPort = {
      async findById(id) {
        const item = state.rawItems.get(id);
        if (!item) return null;
        return {
          id: item.id,
          sourceId: item.sourceId,
          runId: 'run-1',
          externalId: item.externalId,
          canonicalUrl: item.canonicalUrl,
          payload: item.payload,
          payloadHash: item.payloadHash,
          collectedAt: new Date(),
          publishedAt: item.publishedAt,
          httpMetadata: {},
          rightsMetadata: {},
          createdAt: new Date(),
        };
      },
      async upsert() {
        throw new Error('not implemented');
      },
      async findByExternalId() {
        return null;
      },
    };

    const savedDocs: DocumentRevisionRecord[] = [];
    const fakeDocRepo: DocumentRepositoryPort = {
      async saveNormalizedDocument(input) {
        const revisionId = `rev-${savedDocs.length + 1}`;
        const rev: DocumentRevisionRecord = {
          id: revisionId,
          documentId: `doc-${savedDocs.length + 1}`,
          rawItemId: input.rawItemId,
          title: input.title,
          bodyText: input.bodyText,
          author: input.author,
          language: input.language,
          publishedAt: input.publishedAt,
          licenseId: input.licenseId,
          normalizedHash: input.normalizedHash,
          normalizerVersion: input.normalizerVersion,
          status: 'searchable',
          searchableAt: new Date(),
          createdAt: new Date(),
        };
        savedDocs.push(rev);
        return {
          document: {
            id: rev.documentId,
            artifactType: input.artifactType,
            canonicalUrl: input.canonicalUrl,
            duplicateClusterId: null,
            currentRevisionId: rev.id,
            createdAt: new Date(),
          },
          revision: rev,
          isNewRevision: true,
        };
      },
      async findById() {
        return null;
      },
      async findByCanonicalUrl() {
        return null;
      },
      async findRevisionById() {
        return null;
      },
      async listRevisions() {
        return [];
      },
      async listAllRevisions() {
        return [];
      },
      async updateRevisionStatus() {
        return null;
      },
      async quarantineRevision() {
        return null;
      },
      async deleteDocument() {},
    };

    const fakeMetricRepo: MetricObservationRepositoryPort = {
      async upsert() {
        return {
          id: 'metric-1',
          sourceId: 'source-1',
          subjectKey: 'key',
          metricType: 'releases_count',
          windowStart: new Date(),
          windowEnd: new Date(),
          value: 1,
          unit: 'count',
          rawItemId: null,
          querySignature: null,
          isIncomplete: false,
          observedAt: new Date(),
          createdAt: new Date(),
        };
      },
      async list() {
        return [];
      },
    };

    const fakePipelineRepo: PipelineEventRepositoryPort = {
      async create(input) {
        return {
          id: 'event-1',
          rawItemId: input.rawItemId ?? null,
          stage: input.stage,
          processorVersion: input.processorVersion,
          status: input.status,
          errorCode: input.errorCode ?? null,
          errorSummary: input.errorSummary ?? null,
          attempt: input.attempt ?? 1,
          occurredAt: new Date(),
        };
      },
      async listByRawItemId() {
        return [];
      },
    };

    const fakeNormService: NormalizationServicePort = {
      normalizerVersion: '1.0.0',
      normalize(rawItem) {
        return {
          documents: [
            {
              rawItemId: rawItem.id,
              artifactType: 'release',
              canonicalUrl: rawItem.canonicalUrl,
              title: (rawItem.payload['title'] as string) ?? 'Title',
              bodyText: (rawItem.payload['body'] as string) ?? 'Body',
              author: 'techpulse',
              language: 'en',
              publishedAt: rawItem.publishedAt,
              licenseId: 'MIT',
              normalizedHash: 'normhash-1',
              normalizerVersion: '1.0.0',
              status: 'searchable',
            },
          ],
          metrics: [],
        };
      },
    };
    const runtime = createPartitionRuntime({
      stateRepository: state,
      collectorResolver: () => undefined,
      normalizationOptions: {
        normalizationService: fakeNormService,
        rawItemRepository: fakeRawRepo,
        documentRepository: fakeDocRepo,
        metricObservationRepository: fakeMetricRepo,
        pipelineEventRepository: fakePipelineRepo,
      },
      embeddingHandler: async () => {},
    });

    // Outbox runner ticks: claims normalization delivery, executes normalization,
    // calls attachRevision (which creates embedding outbox), and completes delivery.
    const tickResult = await runtime.tick();
    const totalProcessed =
      tickResult.incremental.processedCount +
      tickResult.backfill.processedCount +
      tickResult.general.processedCount;
    expect(totalProcessed).toBeGreaterThan(0);
    expect(savedDocs).toHaveLength(1);
    // Verify membership was linked to revision
    const membership = state.memberships.find((m) => m.rawItemId === rawItemId);
    expect(membership?.revisionId).toBe(savedDocs[0]!.id);

    // Verify embedding delivery outbox was created
    const embeddingDeliveries = Array.from(state.deliveries.values()).filter(
      (d) => d.kind === 'embedding',
    );
    expect(embeddingDeliveries).toHaveLength(1);
    expect(embeddingDeliveries[0]!.revisionId).toBe(savedDocs[0]!.id);
  });

  it('7. Backfill plus incremental fairness: prevents incremental starvation during large backfills', async () => {
    const state = createFakeCollectionState();
    const target = await state.registerTarget(sampleTarget());
    await state.setTargetEnabled(target.targetId, true, new Date());

    // Plan 10 backfill partitions
    await planTargetPartitions(
      { stateRepository: state, defaultSliceDurationMs: 24 * 3600 * 1000 },
      {
        target,
        mode: 'backfill',
        window: {
          from: new Date('2026-08-01T00:00:00Z'),
          to: new Date('2026-08-11T00:00:00Z'),
        },
        sliceDurationMs: 24 * 3600 * 1000,
      },
    );

    // Plan 1 incremental partition
    await planTargetPartitions(
      { stateRepository: state },
      {
        target,
        mode: 'incremental',
        window: {
          from: new Date('2026-09-01T00:00:00Z'),
          to: new Date('2026-09-01T01:00:00Z'),
        },
      },
    );

    const executedModes: CollectionMode[] = [];
    const fakeCollector: CollectorPagePort = {
      async collectPage(req: CollectionPageRequest): Promise<CollectionPageResult> {
        executedModes.push(req.partition.mode);
        return {
          items: [],
          nextCursor: null,
          disposition: 'complete',
          reason: null,
          retryAt: null,
          requests: 1,
          bytes: 0,
        };
      },
    };

    const runtime = createPartitionRuntime({
      stateRepository: state,
      collectorResolver: () => fakeCollector,
      incrementalConcurrency: 5,
      backfillConcurrency: 2,
    });

    // Run 1 tick: incremental lane must run FIRST, followed by bounded backfill
    const tickResult = await runtime.tick();

    expect(tickResult.incremental.processedCount).toBe(1);
    expect(tickResult.backfill.processedCount).toBeGreaterThanOrEqual(1);

    // First executed mode was incremental, proving zero starvation
    expect(executedModes[0]).toBe('incremental');
  });

  it('8. Job schemas and helpers parse version 2 delivery payloads and reject malformed/partition payloads', () => {
    const deliveryId = '11111111-1111-4111-8111-111111111111';
    const deliveryJob = createCollectionDeliveryJobData(deliveryId);
    expect(deliveryJob.schemaVersion).toBe(DELIVERY_JOB_SCHEMA_VERSION);
    expect(deliveryJob.deliveryId).toBe(deliveryId);

    const parsedDelivery = parseCollectionDeliveryJobData(deliveryJob);
    expect(parsedDelivery.deliveryId).toBe(deliveryId);
    expect(parsedDelivery.schemaVersion).toBe(2);

    expect(() => parseCollectionDeliveryJobData({ schemaVersion: 1, deliveryId })).toThrow(
      WorkerJobValidationError,
    );
    expect(() =>
      parseCollectionDeliveryJobData({ schemaVersion: 2, deliveryId: 'invalid-id' }),
    ).toThrow(WorkerJobValidationError);
    expect(() =>
      parseCollectionDeliveryJobData({
        schemaVersion: 2,
        deliveryId,
        partitionId: 'part-456',
      }),
    ).toThrow(WorkerJobValidationError);
  });
});
