import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { collectionHash, type CollectionPageResult, type ModelProfile } from '@techpulse/domain';
import {
  createDatabaseClient,
  createCollectionStateRepository,
  createProviderBudgetRepository,
  createEmbeddingWorkRepository,
  createCohortPersistenceRepository,
  createDiscoveryStateRepository,
} from '../src/index.js';
import {
  sources,
  rawItems,
  acquisitionMemberships,
  collectionCheckpoints,
  deliveryOutbox,
  documents,
  documentRevisions,
  chunks,
  providerBudgetReservations,
} from '../src/schema/index.js';

// Authored synthetic fixture; no external payload or personal information. Local PG only.
const databaseUrl = process.env['DATABASE_URL_DIRECT'] ?? process.env['DATABASE_URL'];
const suite = databaseUrl ? describe : describe.skip;
const now = new Date('2026-09-08T23:59:50Z');
const later = new Date('2026-09-09T00:00:10Z');
const window = { from: new Date('2026-06-10T00:00:00Z'), to: new Date('2026-09-08T00:00:00Z') };
const policy = {
  version: 'authored-fixture',
  approved: true,
  fetch: true,
  store: true,
  embed: true,
  modelInput: true,
  displayExcerpt: false,
  licenseId: null,
  verbatimOnly: false,
};
const capability = {
  historyMode: 'paginated_history' as const,
  timeBasis: 'published_at' as const,
  cursorVersion: 1,
  stablePagination: true,
  canCollect: true,
  reviewedAt: now.toISOString(),
  earliestAvailableAt: null,
  canSearch: true,
  canDiscover: true,
};
const profile: ModelProfile = {
  provider: 'deterministic',
  model: 'fixture',
  version: '1',
  dimensions: 3,
  priceVersion: 'zero-1',
  tokenizerVersion: 'fixture-1',
  approvalReference: 'authored-fixture-only',
};

suite('coverage persistence on PostgreSQL + pgvector', () => {
  if (!databaseUrl) return;
  const client = createDatabaseClient(databaseUrl);
  const db = client.db;
  const state = createCollectionStateRepository(db);
  const budget = createProviderBudgetRepository(db);
  let sourceId: string;
  beforeAll(async () => {
    await client.migrate();
    expect((await client.checkVector()).installed).toBe(true);
    await db
      .insert(sources)
      .values({
        key: 'github_releases',
        name: 'Authored coverage fixture',
        kind: 'api',
        baseUrl: 'https://api.github.com',
        policyReviewedAt: now,
      })
      .onConflictDoNothing();
    const [source] = await db.select().from(sources).where(eq(sources.key, 'github_releases'));
    if (!source) throw new Error('fixture source missing');
    sourceId = source.id;
  }, 30000);
  afterAll(async () => {
    await client.close();
  });

  it('persists immutable cohort definitions and rolls back invalid membership', async () => {
    const revision = await target();
    const cohortState = createCohortPersistenceRepository(db);
    const cohort = {
      id: randomUUID(),
      version: randomUUID(),
      effectiveAt: now,
      members: [
        {
          targetRevisionId: revision.id,
          metric: 'release_activity',
          unit: 'releases',
          querySignature: 'fixture-release-v1',
          cadenceMs: 60000,
        },
      ],
    };
    await Promise.all([
      cohortState.createCohortVersion(cohort),
      cohortState.createCohortVersion(cohort),
    ]);
    expect(await cohortState.getCohortVersion(cohort.id)).toEqual(cohort);
    await expect(
      cohortState.createCohortVersion({
        ...cohort,
        members: [{ ...cohort.members[0]!, cadenceMs: 120000 }],
      }),
    ).rejects.toThrow('invalid_state');
    const invalid = {
      ...cohort,
      id: randomUUID(),
      version: randomUUID(),
      members: [{ ...cohort.members[0]!, targetRevisionId: randomUUID() }],
    };
    await expect(cohortState.createCohortVersion(invalid)).rejects.toThrow('not_found');
    expect(await cohortState.getCohortVersion(invalid.id)).toBeNull();
  });

  it('reviews discovery candidates without enabling targets or changing a settled decision', async () => {
    const revision = await target();
    await state.setTargetEnabled(revision.targetId, false, now);
    const candidates = createDiscoveryStateRepository(db);
    const input = {
      canonicalIdentity: revision.canonicalIdentity,
      sourceKey: revision.sourceKey,
      selector: revision.selector,
      evidenceUrl: 'https://github.com/fixture/coverage',
    };
    const candidate = await candidates.recordCandidate(input, now);
    expect((await candidates.recordCandidate(input, later)).id).toBe(candidate.id);
    await expect(
      candidates.reviewCandidate(candidate.id, 'accepted', randomUUID(), 'fixture-operator', now),
    ).rejects.toThrow('invalid_state');
    await candidates.reviewCandidate(
      candidate.id,
      'accepted',
      revision.targetId,
      'fixture-operator',
      now,
    );
    await candidates.reviewCandidate(
      candidate.id,
      'accepted',
      revision.targetId,
      'fixture-operator',
      later,
    );
    expect((await state.getTargetRevision(revision.id))?.enabled).toBe(false);
    await expect(
      candidates.reviewCandidate(candidate.id, 'rejected', null, 'fixture-operator', later),
    ).rejects.toThrow('invalid_state');
  });

  async function target() {
    const targetRevision = await state.registerTarget({
      sourceId,
      sourceKey: 'github_releases',
      canonicalIdentity: `fixture/${randomUUID()}`,
      selector: { kind: 'repository', owner: 'fixture', repository: 'coverage' },
      capability,
      policy,
      topicIds: [],
      taxonomyVersion: 'fixture-1',
      enabled: false,
      cadenceMs: 60000,
      overlapMs: 0,
    });
    await state.setTargetEnabled(targetRevision.targetId, true, now);
    return targetRevision;
  }
  async function plan(targetRevisionId: string) {
    return state.planPartition(
      {
        targetRevisionId,
        mode: 'backfill',
        scopeKey: 'fixture',
        window,
        timeBasis: 'published_at',
        workflowVersion: '1',
      },
      now,
    );
  }
  function page(externalId: string): CollectionPageResult {
    const payload = { title: 'Synthetic fixture release', body: 'Coverage atomicity fixture.' };
    return {
      disposition: 'complete',
      nextCursor: null,
      reason: null,
      retryAt: null,
      requests: 1,
      bytes: 80,
      items: [
        {
          externalId,
          payload,
          rawHash: collectionHash(payload),
          publishedAt: window.from,
          cursor: null,
          metadata: { canonicalUrl: `https://github.com/fixture/coverage/releases/${externalId}` },
        },
      ],
    };
  }

  it('commits raw, acquisition, checkpoint and repairable delivery atomically across targets', async () => {
    const a = await target();
    const b = await target();
    const pa = await plan(a.id);
    const pb = await plan(b.id);
    expect(pa.id).not.toBe(pb.id);
    expect((await plan(a.id)).id).toBe(pa.id);
    const claims = await Promise.all([
      state.claimPage(pa.id, 0, now, 10000),
      state.claimPage(pa.id, 0, now, 10000),
    ]);
    const claim = claims.find((value) => value !== null);
    expect(claims.filter(Boolean)).toHaveLength(1);
    if (!claim) throw new Error('missing claim');
    const result = page(randomUUID());
    const item = result.items[0];
    if (!item) throw new Error('missing fixture');
    await expect(
      state.commitPage({
        claim,
        now,
        result: { ...result, items: [item, { ...item, externalId: randomUUID(), metadata: {} }] },
      }),
    ).rejects.toThrow('invalid_page');
    expect(
      await db.select().from(rawItems).where(eq(rawItems.externalId, item.externalId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(collectionCheckpoints)
        .where(eq(collectionCheckpoints.partitionId, pa.id)),
    ).toHaveLength(0);
    expect((await state.getPartition(pa.id))?.pageSequence).toBe(0);
    await state.commitPage({ claim, result, now });
    await expect(state.commitPage({ claim, result, now })).rejects.toThrow('stale_lease');
    const second = await state.claimPage(pb.id, 0, now, 10000);
    if (!second) throw new Error('missing second claim');
    await state.commitPage({ claim: second, result, now });
    const raw = await db.select().from(rawItems).where(eq(rawItems.externalId, item.externalId));
    expect(raw).toHaveLength(1);
    const rawId = raw[0]?.id as string;
    expect(
      await db
        .select()
        .from(acquisitionMemberships)
        .where(eq(acquisitionMemberships.rawItemId, rawId)),
    ).toHaveLength(2);
    const deliveries = await db
      .select()
      .from(deliveryOutbox)
      .where(and(eq(deliveryOutbox.rawItemId, rawId), eq(deliveryOutbox.kind, 'normalization')));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.completedAt).toBeNull();
    const delivery = deliveries[0];
    if (!delivery) throw new Error('missing delivery');
    await expect(state.completeDelivery(delivery.id, now)).rejects.toThrow('invalid_state');
    const claimedDelivery = (await state.claimDeliveries(now, 100, 10000)).find(
      (entry) => entry.id === delivery.id,
    );
    if (!claimedDelivery) throw new Error('delivery not claimed');
    expect(
      (await state.claimDeliveries(now, 100, 10000)).some((entry) => entry.id === delivery.id),
    ).toBe(false);
    await state.markSent(delivery.id, claimedDelivery.leaseEpoch, now);
    const recovered = (
      await createCollectionStateRepository(db).claimDeliveries(
        new Date(now.getTime() + 31000),
        100,
        10000,
      )
    ).find((entry) => entry.id === delivery.id);
    expect(recovered?.leaseEpoch).toBe(claimedDelivery.leaseEpoch + 1);
    await expect(
      state.markSent(delivery.id, claimedDelivery.leaseEpoch, new Date(now.getTime() + 31000)),
    ).rejects.toThrow('stale_lease');
  });

  it('fences expired workers and denies writes after target disable', async () => {
    const revision = await target();
    const partition = await plan(revision.id);
    const oldClaim = await state.claimPage(partition.id, 0, now, 1000);
    const nextTime = new Date(now.getTime() + 2000);
    const currentClaim = await state.claimPage(partition.id, 0, nextTime, 10000);
    if (!oldClaim || !currentClaim) throw new Error('missing claims');
    await expect(
      state.commitPage({ claim: oldClaim, result: page(randomUUID()), now: nextTime }),
    ).rejects.toThrow('stale_lease');
    const unrelated = await target();
    await expect(
      state.commitPage({
        claim: { ...currentClaim, target: { ...currentClaim.target, id: unrelated.id } },
        result: page(randomUUID()),
        now: nextTime,
      }),
    ).rejects.toThrow('stale_lease');
    await state.setTargetEnabled(revision.targetId, false, nextTime);
    await expect(
      state.commitPage({ claim: currentClaim, result: page(randomUUID()), now: nextTime }),
    ).rejects.toThrow('policy_blocked');
    await expect(state.renewPage(currentClaim, nextTime, 10000)).rejects.toThrow('policy_blocked');
    expect((await state.getPartition(partition.id))?.pageSequence).toBe(0);
    await state.setTargetEnabled(revision.targetId, true, nextTime);
    await db.update(sources).set({ enabled: false }).where(eq(sources.id, sourceId));
    try {
      await expect(
        state.commitPage({ claim: currentClaim, result: page(randomUUID()), now: nextTime }),
      ).rejects.toThrow('policy_blocked');
      await expect(state.renewPage(currentClaim, nextTime, 10000)).rejects.toThrow(
        'policy_blocked',
      );
      expect(await state.claimDeliveries(nextTime, 100, 1000)).toEqual([]);
    } finally {
      await db.update(sources).set({ enabled: true }).where(eq(sources.id, sourceId));
    }
  });

  it('serializes reservations and keeps unknown exposure across UTC rollover and restarts', async () => {
    const scopeId = randomUUID();
    await budget.configureScope({
      id: scopeId,
      approved: true,
      currency: 'USD',
      maxDailyUnits: 100,
      maxOutstandingUnits: 100,
      maxDailyTokens: 100,
      approvedModelProfiles: [],
      laneLimits: { ingestion_embedding: { maxDailyUnits: 100, maxDailyTokens: 100 } },
    });
    const results = await Promise.allSettled([
      budget.reserve(scopeId, randomUUID(), 'ingestion_embedding', 60, 1, now),
      budget.reserve(scopeId, randomUUID(), 'ingestion_embedding', 60, 1, now),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const granted = results.find((result) => result.status === 'fulfilled');
    if (!granted || granted.status !== 'fulfilled') throw new Error('missing reservation');
    await budget.holdUnknown(granted.value.id, now);
    const restarted = createProviderBudgetRepository(db);
    await expect(
      restarted.reserve(scopeId, randomUUID(), 'ingestion_embedding', 50, 1, later),
    ).rejects.toThrow('budget_exhausted');
    await expect(restarted.releaseUnsent(granted.value.id, later)).rejects.toThrow(
      'outcome_unknown',
    );
    const allowed = await restarted.reserve(
      scopeId,
      randomUUID(),
      'ingestion_embedding',
      40,
      1,
      later,
    );
    expect(allowed.units).toBe(40);
    await restarted.settle(granted.value.id, 110, 1, later);
    const [stored] = await db
      .select()
      .from(providerBudgetReservations)
      .where(eq(providerBudgetReservations.id, granted.value.id));
    expect(stored?.actualUnits).toBe(110);
    expect(stored?.utcDay).toBe('2026-09-08');
    await expect(
      restarted.reserve(scopeId, randomUUID(), 'ingestion_embedding', 0, 1, later),
    ).rejects.toThrow('budget_exhausted');
  });

  it('reuses completed profile results and holds post-call crashes without another claim', async () => {
    const revision = await target();
    const partition = await plan(revision.id);
    const claim = await state.claimPage(partition.id, 0, now, 10000);
    if (!claim) throw new Error('missing claim');
    const result = page(randomUUID());
    await state.commitPage({ claim, result, now });
    const [acquisition] = await db
      .select()
      .from(acquisitionMemberships)
      .where(eq(acquisitionMemberships.partitionId, partition.id));
    const [doc] = await db
      .insert(documents)
      .values({ artifactType: 'release_note', canonicalUrl: 'https://github.com/fixture/coverage' })
      .returning();
    if (!acquisition || !doc) throw new Error('missing fixture');
    const hash = collectionHash('Synthetic embedding input');
    const [document] = await db
      .insert(documentRevisions)
      .values({
        documentId: doc.id,
        rawItemId: acquisition.rawItemId,
        title: 'Fixture',
        bodyText: 'Synthetic embedding input',
        normalizedHash: hash,
        normalizerVersion: '1',
        status: 'processing',
      })
      .returning();
    if (!document) throw new Error('missing revision');
    const [chunk] = await db
      .insert(chunks)
      .values({
        documentRevisionId: document.id,
        ordinal: 0,
        content: 'Synthetic embedding input',
        tokenCount: 3,
        contentHash: hash,
        chunkerVersion: '1',
      })
      .returning();
    if (!chunk) throw new Error('missing chunk');
    await state.attachRevision(acquisition.rawItemId, document.id, now);
    const [embeddingDelivery] = await db
      .select()
      .from(deliveryOutbox)
      .where(and(eq(deliveryOutbox.revisionId, document.id), eq(deliveryOutbox.kind, 'embedding')));
    if (!embeddingDelivery) throw new Error('missing embedding delivery');
    await expect(state.completeDelivery(embeddingDelivery.id, now, profile)).rejects.toThrow(
      'invalid_state',
    );
    const key = { chunkId: chunk.id, inputHash: hash, profile };
    const work = createEmbeddingWorkRepository(db);
    const claims = await Promise.all([
      work.claimOrReadCompleted(key, now, 10000),
      work.claimOrReadCompleted(key, now, 10000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owned = claims.find(Boolean);
    if (!owned) throw new Error('missing work');
    const scopeId = randomUUID();
    await budget.configureScope({
      id: scopeId,
      approved: true,
      currency: 'USD',
      maxDailyUnits: 0,
      maxOutstandingUnits: 0,
      maxDailyTokens: 100,
      approvedModelProfiles: [
        collectionHash(profile),
        collectionHash({ ...profile, version: '2' }),
      ],
      laneLimits: { ingestion_embedding: { maxDailyUnits: 0, maxDailyTokens: 100 } },
    });
    const reservation = await budget.reserve(
      scopeId,
      `${owned.id}:${owned.epoch}`,
      'ingestion_embedding',
      0,
      3,
      now,
    );
    await work.beginCall(owned.id, owned.epoch, reservation.id, now);
    await work.completeWork(owned.id, owned.epoch, [0.1, 0.2, 0.3], now);
    await expect(
      state.completeDelivery(embeddingDelivery.id, now, { ...profile, version: '2' }),
    ).rejects.toThrow('invalid_state');
    await state.completeDelivery(embeddingDelivery.id, now, profile);
    expect((await state.getDelivery(embeddingDelivery.id))?.completedAt).toEqual(now);
    const cached = await createEmbeddingWorkRepository(db).claimOrReadCompleted(key, later, 10000);
    expect(cached?.state).toBe('completed');
    expect(cached?.vector).toEqual([0.1, 0.2, 0.3]);
    const restricted = await state.registerTarget({
      ...revision,
      policy: { ...policy, embed: false },
    });
    await state.setTargetEnabled(restricted.targetId, true, later);
    await expect(work.claimOrReadCompleted(key, later, 10000)).rejects.toThrow('approval_required');
    await state.registerTarget(revision);
    await state.setTargetEnabled(revision.targetId, true, later);
    const changedKey = { ...key, profile: { ...profile, version: '2' } };
    const changed = await work.claimOrReadCompleted(changedKey, now, 1000);
    if (!changed) throw new Error('missing changed-profile work');
    expect(changed.state).toBe('claimed');
    const nextReservation = await budget.reserve(
      scopeId,
      `${changed.id}:${changed.epoch}`,
      'ingestion_embedding',
      0,
      3,
      now,
    );
    await work.beginCall(changed.id, changed.epoch, nextReservation.id, now);
    const unknown = await work.claimOrReadCompleted(changedKey, later, 10000);
    expect(unknown?.state).toBe('outcome_unknown');
    expect(
      (await createEmbeddingWorkRepository(db).claimOrReadCompleted(changedKey, later, 10000))
        ?.state,
    ).toBe('outcome_unknown');
    await expect(
      work.completeWork(changed.id, changed.epoch, [0.1, 0.2, 0.3], later),
    ).rejects.toThrow('stale_work');
    const unapproved = await work.claimOrReadCompleted(
      { ...key, profile: { ...profile, version: 'unapproved' } },
      later,
      10000,
    );
    if (!unapproved) throw new Error('missing unapproved-profile work');
    const deniedReservation = await budget.reserve(
      scopeId,
      `${unapproved.id}:${unapproved.epoch}`,
      'ingestion_embedding',
      0,
      3,
      later,
    );
    await expect(
      work.beginCall(unapproved.id, unapproved.epoch, deniedReservation.id, later),
    ).rejects.toThrow('approval_required');
    await budget.releaseUnsent(deniedReservation.id, later);
  });
});
