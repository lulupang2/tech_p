import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  collectionHash,
  type CollectionWindow,
  type ModelProfile,
  type CollectionStatePort,
  type SearchServicePort,
  type SearchReadinessPort,
  type CoveragePort,
  type CohortPort,
} from '@techpulse/domain';
import {
  createDatabaseClient,
  createCollectionStateRepository,
  type DatabaseClient,
} from '../src/index.js';
import { createSearchService } from '../src/search.js';
import {
  createSearchReadinessRepository,
  createCoverageRepository,
  createCohortRepository,
} from '../src/coverage.js';
import {
  sources,
  collectionRuns,
  rawItems,
  documents,
  documentRevisions,
  chunks,
  embeddings,
  metricObservations,
  acquisitionMemberships,
  collectionPartitions,
  collectionTargets,
  collectionTargetRevisions,
} from '../src/schema/index.js';

const databaseUrl = process.env['DATABASE_URL_DIRECT'] ?? process.env['DATABASE_URL'];
const now = new Date('2026-09-08T23:59:50Z');
const baselineWindow: CollectionWindow = {
  from: new Date('2026-06-01T00:00:00Z'),
  to: new Date('2026-07-01T00:00:00Z'),
};
const currentWindow: CollectionWindow = {
  from: new Date('2026-07-01T00:00:00Z'),
  to: new Date('2026-08-01T00:00:00Z'),
};
const policy = {
  version: 'coverage-readiness-fixture',
  approved: true,
  fetch: true,
  store: true,
  embed: true,
  modelInput: true,
  displayExcerpt: true,
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
const approvedProfile: ModelProfile = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  version: '1',
  dimensions: 3,
  priceVersion: 'zero-1',
  tokenizerVersion: 'fixture-1',
  approvalReference: 'approved-fixture-only',
};
const wrongProfile: ModelProfile = {
  provider: 'cohere',
  model: 'embed-english-v3.0',
  version: '1',
  dimensions: 3,
  priceVersion: 'zero-1',
  tokenizerVersion: 'fixture-1',
  approvalReference: 'wrong-fixture',
};

(databaseUrl ? describe : describe.skip)('COV-006 Coverage, Readiness & Search Integration', () => {
  let client: DatabaseClient;
  let db: DatabaseClient['db'];
  let state: CollectionStatePort;
  let searchService: SearchServicePort;
  let readinessRepo: SearchReadinessPort;
  let coverageRepo: CoveragePort;
  let cohortRepo: CohortPort;

  let sourceId: string;
  let admin: DatabaseClient | undefined;
  let isolatedDatabaseName: string | undefined;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error(
        'Readiness integration tests require PostgreSQL with pgvector. DATABASE_URL or DATABASE_URL_DIRECT must be configured.',
      );
    }

    const rootUrl = new URL(databaseUrl);
    const local =
      ['127.0.0.1', 'localhost', '::1', 'postgres', 'postgres-persistent'].includes(
        rootUrl.hostname,
      ) || rootUrl.hostname.startsWith('postgres-');
    if (!local && process.env['ALLOW_REMOTE_INTEGRATION_DATABASE'] !== '1') {
      throw new Error(
        'Coverage integration requires an isolated PostgreSQL server or explicit remote isolation opt-in',
      );
    }
    admin = createDatabaseClient(databaseUrl);
    const name = `coverage_isolated_${randomUUID().replaceAll('-', '')}`;
    await admin.db.execute(sql.raw(`CREATE DATABASE "${name}"`));
    isolatedDatabaseName = name;
    rootUrl.pathname = `/${name}`;
    client = createDatabaseClient(rootUrl.toString());
    db = client.db;
    state = createCollectionStateRepository(db);
    searchService = createSearchService(db);
    readinessRepo = createSearchReadinessRepository(db);
    coverageRepo = createCoverageRepository(db, { embeddingProfile: approvedProfile });
    cohortRepo = createCohortRepository(db);

    await client.connect();
    const healthy = await client.checkHealth();
    if (!healthy) {
      throw new Error('Database is unreachable for readiness integration tests.');
    }

    await client.migrate();
    const vectorInfo = await client.checkVector();
    if (!vectorInfo.installed) {
      throw new Error('pgvector extension is not installed in the target PostgreSQL instance.');
    }

    await db
      .insert(sources)
      .values({
        key: 'github_releases',
        name: 'Coverage fixture source',
        kind: 'api',
        baseUrl: 'https://api.github.com',
        policyReviewedAt: now,
      })
      .onConflictDoNothing();

    const [source] = await db.select().from(sources).where(eq(sources.key, 'github_releases'));
    if (!source) throw new Error('Fixture source missing');
    sourceId = source.id;
  }, 30000);

  afterAll(async () => {
    if (client) {
      await client.close();
    }
    if (admin) {
      if (isolatedDatabaseName && /^coverage_isolated_[a-f0-9]{32}$/u.test(isolatedDatabaseName)) {
        await admin.db.execute(sql.raw(`DROP DATABASE "${isolatedDatabaseName}" WITH (FORCE)`));
      }
      await admin.close();
    }
  });

  it('proves valid embedding-less lexical search operates independently of vector store', async () => {
    const uniqueKeyword = `EmbeddingLessLexical_${randomUUID().replace(/-/g, '')}`;

    const [doc] = await db
      .insert(documents)
      .values({
        artifactType: 'article',
        canonicalUrl: `https://example.com/embedding-less-${Date.now()}`,
      })
      .returning();
    assert(doc);

    const hash = 'a'.repeat(64);
    const [rev] = await db
      .insert(documentRevisions)
      .values({
        documentId: doc.id,
        title: `Lexical Only Title ${uniqueKeyword}`,
        bodyText: 'This document has no vector embeddings whatsoever.',
        normalizedHash: hash,
        normalizerVersion: 'v1.0.0',
        status: 'pending',
        publishedAt: new Date('2026-06-15T12:00:00Z'),
      })
      .returning();
    assert(rev);

    const [chunk] = await db
      .insert(chunks)
      .values({
        documentRevisionId: rev.id,
        ordinal: 0,
        headingPath: ['Intro'],
        content: `Detailed documentation for ${uniqueKeyword} without embeddings.`,
        tokenCount: 10,
        contentHash: hash,
        chunkerVersion: 'v1.0.0',
      })
      .returning();
    assert(chunk);

    // Before markLexicalReady: lexicalReadyAt is null, searchFts returns 0 hits
    const beforeHits = await searchService.searchFts({ query: uniqueKeyword });
    assert.equal(beforeHits.length, 0);

    // Mark lexically ready
    await readinessRepo.markLexicalReady(rev.id, now);

    // After markLexicalReady: status is searchable, lexicalReadyAt is set
    const [updatedRev] = await db
      .select()
      .from(documentRevisions)
      .where(eq(documentRevisions.id, rev.id));
    assert.equal(updatedRev?.status, 'searchable');
    assert(updatedRev?.lexicalReadyAt !== null);

    // 1. FTS search finds the document without any embedding present
    const ftsHits = await searchService.searchFts({ query: uniqueKeyword });
    assert.equal(ftsHits.length, 1);
    assert.equal(ftsHits[0]?.documentRevisionId, rev.id);
    assert(ftsHits[0]!.score > 0);

    // 2. Vector readiness is false because no embeddings exist
    const isVecReady = await readinessRepo.getVectorReadiness(rev.id, approvedProfile);
    assert.equal(isVecReady, false);

    // 3. Exact vector search returns 0 hits
    const vectorHits = await searchService.searchExactVector({
      vector: [1.0, 0.0, 0.0],
      dimensions: 3,
      provider: approvedProfile.provider,
      model: approvedProfile.model,
    });
    assert.equal(
      vectorHits.some((h) => h.documentRevisionId === rev.id),
      false,
    );
  });

  it('excludes wrong model profiles in vector readiness and exact vector search', async () => {
    const [doc] = await db
      .insert(documents)
      .values({
        artifactType: 'article',
        canonicalUrl: `https://example.com/profile-test-${Date.now()}`,
      })
      .returning();
    assert(doc);

    const hash = 'b'.repeat(64);
    const [rev] = await db
      .insert(documentRevisions)
      .values({
        documentId: doc.id,
        title: `Profile Test Document`,
        bodyText: 'Testing model profile separation.',
        normalizedHash: hash,
        normalizerVersion: 'v1.0.0',
        status: 'searchable',
        lexicalReadyAt: now,
        publishedAt: new Date('2026-06-20T12:00:00Z'),
      })
      .returning();
    assert(rev);

    const [chunk] = await db
      .insert(chunks)
      .values({
        documentRevisionId: rev.id,
        ordinal: 0,
        headingPath: ['ModelProfile'],
        content: `Target chunk with approved model profile vector.`,
        tokenCount: 8,
        contentHash: hash,
        chunkerVersion: 'v1.0.0',
      })
      .returning();
    assert(chunk);

    // Seed embedding for approvedProfile
    const profileHash = collectionHash(approvedProfile);
    await db.insert(embeddings).values({
      chunkId: chunk.id,
      provider: approvedProfile.provider,
      model: approvedProfile.model,
      profileHash,
      dimensions: approvedProfile.dimensions,
      embedding: [0.0, 1.0, 0.0],
      inputHash: hash,
    });

    // Approved profile is vector-ready
    assert.equal(await readinessRepo.getVectorReadiness(rev.id, approvedProfile), true);

    // Wrong profile is NOT vector-ready
    assert.equal(await readinessRepo.getVectorReadiness(rev.id, wrongProfile), false);

    // Exact vector search with WRONG profile returns 0 hits for this document
    const wrongHits = await searchService.searchExactVector({
      vector: [0.0, 0.99, 0.01],
      dimensions: 3,
      provider: wrongProfile.provider,
      model: wrongProfile.model,
    });
    assert.equal(
      wrongHits.some((h) => h.documentRevisionId === rev.id),
      false,
    );

    // Exact vector search with CORRECT profile finds the document
    const correctHits = await searchService.searchExactVector({
      vector: [0.0, 0.99, 0.01],
      dimensions: 3,
      provider: approvedProfile.provider,
      model: approvedProfile.model,
    });
    assert.equal(
      correctHits.some((h) => h.documentRevisionId === rev.id),
      true,
    );
  });

  it('excludes tombstones on both lexical FTS and exact vector search paths', async () => {
    const uniqueKeyword = `TombstoneTarget_${randomUUID().replace(/-/g, '')}`;

    const [doc] = await db
      .insert(documents)
      .values({
        artifactType: 'article',
        canonicalUrl: `https://example.com/tombstone-test-${Date.now()}`,
      })
      .returning();
    assert(doc);

    const hash = 'c'.repeat(64);
    const [rev] = await db
      .insert(documentRevisions)
      .values({
        documentId: doc.id,
        title: `Tombstone Test ${uniqueKeyword}`,
        bodyText: 'This document will be tombstoned.',
        normalizedHash: hash,
        normalizerVersion: 'v1.0.0',
        status: 'searchable',
        lexicalReadyAt: now,
        publishedAt: new Date('2026-06-25T12:00:00Z'),
      })
      .returning();
    assert(rev);

    const [chunk] = await db
      .insert(chunks)
      .values({
        documentRevisionId: rev.id,
        ordinal: 0,
        headingPath: ['Tombstone'],
        content: `Searchable before tombstone ${uniqueKeyword}.`,
        tokenCount: 8,
        contentHash: hash,
        chunkerVersion: 'v1.0.0',
      })
      .returning();
    assert(chunk);

    await db.insert(embeddings).values({
      chunkId: chunk.id,
      provider: approvedProfile.provider,
      model: approvedProfile.model,
      profileHash: collectionHash(approvedProfile),
      dimensions: approvedProfile.dimensions,
      embedding: [0.0, 0.0, 1.0],
      inputHash: hash,
    });

    // Confirm it is searchable before tombstone
    const ftsBefore = await searchService.searchFts({ query: uniqueKeyword });
    assert.equal(ftsBefore.length, 1);
    const vecBefore = await searchService.searchExactVector({
      vector: [0.0, 0.0, 0.99],
      dimensions: 3,
      provider: approvedProfile.provider,
      model: approvedProfile.model,
    });
    assert.equal(
      vecBefore.some((h) => h.documentRevisionId === rev.id),
      true,
    );

    // Apply tombstone
    await db
      .update(documentRevisions)
      .set({ status: 'tombstoned' })
      .where(eq(documentRevisions.id, rev.id));

    // Excluded on lexical path
    const ftsAfter = await searchService.searchFts({ query: uniqueKeyword });
    assert.equal(ftsAfter.length, 0);

    // Excluded on vector path
    const vecAfter = await searchService.searchExactVector({
      vector: [0.0, 0.0, 0.99],
      dimensions: 3,
      provider: approvedProfile.provider,
      model: approvedProfile.model,
    });
    assert.equal(
      vecAfter.some((h) => h.documentRevisionId === rev.id),
      false,
    );

    // Readiness operations reject tombstoned revision
    await assert.rejects(() => readinessRepo.markLexicalReady(rev.id, now), /invalid_state/u);
    assert.equal(await readinessRepo.getVectorReadiness(rev.id, approvedProfile), false);
  });

  it('reports deterministic coverage counts and shortage reasons', async () => {
    const report = await coverageRepo.getCoverage(baselineWindow, [], now);
    assert(Number.isInteger(report.rawDocuments));
    assert(Number.isInteger(report.lexicalDocuments));
    assert(Number.isInteger(report.vectorDocuments));
    assert(Number.isInteger(report.partitionsChecked));
    assert(Number.isInteger(report.partitionsCompleted));
    assert(Number.isInteger(report.partitionsPartial));
    assert(Array.isArray(report.reasons));
  });

  it('COV-011 isolates exact target counts, rights, publication windows and approved profile readiness', async () => {
    const key = randomUUID();
    const scopeKey = `coverage-exact-${key}`;
    const topicA = `coverage-a-${key}`;
    const topicB = `coverage-b-${key}`;
    const topicZero = `coverage-zero-${key}`;
    async function target(topic: string) {
      const revision = await state.registerTarget({
        sourceId,
        sourceKey: 'github_releases',
        canonicalIdentity: `fixture/${topic}`,
        selector: { kind: 'repository', owner: 'fixture', repository: topic },
        capability,
        policy,
        topicIds: [topic],
        taxonomyVersion: 'v1.0.0',
        enabled: false,
        cadenceMs: 60000,
        overlapMs: 0,
      });
      await state.setTargetEnabled(revision.targetId, true, now);
      const partition = await state.planPartition(
        {
          targetRevisionId: revision.id,
          mode: 'backfill',
          scopeKey,
          window: baselineWindow,
          timeBasis: 'published_at',
          workflowVersion: '1',
        },
        now,
      );
      await db
        .update(collectionPartitions)
        .set({ state: 'completed' })
        .where(eq(collectionPartitions.id, partition.id));
      return { revision, partition };
    }
    async function corpus(
      partitionId: string,
      rawOptions: { rightsMetadata?: typeof policy; publishedAt?: Date | null } = {},
    ) {
      const id = randomUUID();
      const [run] = await db
        .insert(collectionRuns)
        .values({ sourceId, scheduledAt: now, status: 'succeeded' })
        .returning();
      assert(run);
      const publishedAt = new Date('2026-06-15T12:00:00Z');
      const [raw] = await db
        .insert(rawItems)
        .values({
          sourceId,
          runId: run.id,
          externalId: id,
          canonicalUrl: `https://example.com/${id}`,
          payload: { fixture: id },
          payloadHash: '1'.repeat(64),
          publishedAt: rawOptions.publishedAt === undefined ? publishedAt : rawOptions.publishedAt,
          collectedAt: publishedAt,
          rightsMetadata: rawOptions.rightsMetadata ?? policy,
        })
        .returning();
      assert(raw);
      const [doc] = await db
        .insert(documents)
        .values({ artifactType: 'release_note', canonicalUrl: `https://example.com/${id}` })
        .returning();
      assert(doc);
      const [revision] = await db
        .insert(documentRevisions)
        .values({
          documentId: doc.id,
          rawItemId: raw.id,
          title: 'Coverage fixture',
          bodyText: 'Coverage fixture body',
          normalizedHash: '1'.repeat(64),
          normalizerVersion: 'fixture',
          status: 'searchable',
          lexicalReadyAt: now,
          publishedAt,
        })
        .returning();
      assert(revision);
      const [chunk] = await db
        .insert(chunks)
        .values({
          documentRevisionId: revision.id,
          ordinal: 0,
          headingPath: [],
          content: 'Coverage evidence',
          tokenCount: 3,
          contentHash: '1'.repeat(64),
          chunkerVersion: 'fixture',
        })
        .returning();
      assert(chunk);
      const [embedding] = await db
        .insert(embeddings)
        .values({
          chunkId: chunk.id,
          provider: approvedProfile.provider,
          model: approvedProfile.model,
          dimensions: approvedProfile.dimensions,
          profileHash: collectionHash(approvedProfile),
          embedding: [1, 0, 0],
          inputHash: chunk.contentHash,
        })
        .returning();
      assert(embedding);
      await db
        .insert(acquisitionMemberships)
        .values({ partitionId, rawItemId: raw.id, revisionId: revision.id, runId: run.id });
      return { raw, revision, chunk, embedding, run };
    }
    const a = await target(topicA);
    const b = await target(topicB);
    await target(topicZero);
    const evidenceA = await corpus(a.partition.id);
    await corpus(b.partition.id);
    const options = { embeddingProfile: approvedProfile, scopeKeys: [scopeKey] };
    const repo = createCoverageRepository(db, options);
    const counts = async (topics: string[], expected: number[]) => {
      const report = await repo.getCoverage(baselineWindow, topics, now);
      assert.deepEqual(
        [
          report.rawDocuments,
          report.lexicalDocuments,
          report.vectorDocuments,
          report.partitionsChecked,
          report.partitionsCompleted,
        ],
        expected,
      );
      return report;
    };
    await counts([topicA], [1, 1, 1, 1, 1]);
    await counts([topicB], [1, 1, 1, 1, 1]);
    assert.deepEqual((await counts([topicZero], [0, 0, 0, 1, 1])).reasons, ['raw_shortage']);
    assert.deepEqual((await counts([`missing-${key}`], [0, 0, 0, 0, 0])).reasons, ['unknown']);
    await counts([topicA, topicB, topicZero], [2, 2, 2, 3, 3]);
    const byIdentity = createCoverageRepository(db, {
      ...options,
      targetIdentities: [a.revision.canonicalIdentity],
    });
    assert.equal((await byIdentity.getCoverage(baselineWindow, [], now)).rawDocuments, 1);
    assert.equal((await byIdentity.getCoverage(baselineWindow, [topicB], now)).rawDocuments, 0);
    assert.equal(
      (
        await createCoverageRepository(db, { ...options, targetIdentities: [] }).getCoverage(
          baselineWindow,
          [],
          now,
        )
      ).rawDocuments,
      0,
    );

    await db
      .update(collectionTargets)
      .set({ enabled: false })
      .where(eq(collectionTargets.id, a.revision.targetId));
    await counts([topicA], [0, 0, 0, 0, 0]);
    await db
      .update(collectionTargets)
      .set({ enabled: true })
      .where(eq(collectionTargets.id, a.revision.targetId));
    await db.update(sources).set({ enabled: false }).where(eq(sources.id, sourceId));
    await counts([topicA], [0, 0, 0, 0, 0]);
    await db.update(sources).set({ enabled: true }).where(eq(sources.id, sourceId));
    await db.update(sources).set({ policyReviewedAt: null }).where(eq(sources.id, sourceId));
    await counts([topicA], [0, 0, 0, 0, 0]);
    await db.update(sources).set({ policyReviewedAt: now }).where(eq(sources.id, sourceId));
    for (const denied of ['approved', 'store', 'modelInput', 'displayExcerpt'] as const) {
      await db
        .update(collectionTargetRevisions)
        .set({ policy: { ...policy, [denied]: false } })
        .where(eq(collectionTargetRevisions.id, a.revision.id));
      await counts([topicA], [0, 0, 0, 0, 0]);
    }
    await db
      .update(collectionTargetRevisions)
      .set({ policy: { ...policy, embed: false } })
      .where(eq(collectionTargetRevisions.id, a.revision.id));
    await counts([topicA], [1, 1, 0, 1, 1]);
    await db
      .update(collectionTargetRevisions)
      .set({ policy })
      .where(eq(collectionTargetRevisions.id, a.revision.id));
    for (const denied of ['approved', 'store', 'modelInput', 'displayExcerpt'] as const) {
      const topic = `${topicA}-${denied}`;
      const fixture = await target(topic);
      await corpus(fixture.partition.id, { rightsMetadata: { ...policy, [denied]: false } });
      await counts([topic], [0, 0, 0, 1, 1]);
    }
    const noEmbedTopic = `${topicA}-no-embed`;
    const noEmbed = await target(noEmbedTopic);
    await corpus(noEmbed.partition.id, { rightsMetadata: { ...policy, embed: false } });
    await counts([noEmbedTopic], [1, 1, 0, 1, 1]);
    await db
      .update(embeddings)
      .set({ profileHash: collectionHash(wrongProfile) })
      .where(eq(embeddings.id, evidenceA.embedding.id));
    await counts([topicA], [1, 1, 0, 1, 1]);
    await db
      .update(embeddings)
      .set({ profileHash: collectionHash(approvedProfile), inputHash: '2'.repeat(64) })
      .where(eq(embeddings.id, evidenceA.embedding.id));
    await counts([topicA], [1, 1, 0, 1, 1]);
    await db
      .update(embeddings)
      .set({ inputHash: evidenceA.chunk.contentHash })
      .where(eq(embeddings.id, evidenceA.embedding.id));
    const [unembedded] = await db
      .insert(chunks)
      .values({
        documentRevisionId: evidenceA.revision.id,
        ordinal: 1,
        headingPath: [],
        content: 'Second coverage block',
        tokenCount: 3,
        contentHash: '2'.repeat(64),
        chunkerVersion: 'fixture',
      })
      .returning();
    assert(unembedded);
    await counts([topicA], [1, 1, 0, 1, 1]);
    await db.insert(embeddings).values({
      chunkId: unembedded.id,
      provider: approvedProfile.provider,
      model: approvedProfile.model,
      dimensions: 3,
      profileHash: collectionHash(approvedProfile),
      embedding: [0, 1, 0],
      inputHash: unembedded.contentHash,
    });
    await counts([topicA], [1, 1, 1, 1, 1]);
    await db
      .update(documentRevisions)
      .set({ status: 'tombstoned' })
      .where(eq(documentRevisions.id, evidenceA.revision.id));
    await counts([topicA], [1, 0, 0, 1, 1]);
    await db
      .update(documentRevisions)
      .set({ status: 'searchable', lexicalReadyAt: null })
      .where(eq(documentRevisions.id, evidenceA.revision.id));
    await counts([topicA], [1, 0, 0, 1, 1]);
    await db
      .update(documentRevisions)
      .set({ lexicalReadyAt: now })
      .where(eq(documentRevisions.id, evidenceA.revision.id));
    for (const publishedAt of [null, baselineWindow.to]) {
      const topic = `${topicA}-date-${publishedAt === null ? 'null' : 'exclusive-end'}`;
      const fixture = await target(topic);
      await corpus(fixture.partition.id, { publishedAt });
      await counts([topic], [0, 0, 0, 1, 1]);
    }
    const noProfile = await createCoverageRepository(db, { scopeKeys: [scopeKey] }).getCoverage(
      baselineWindow,
      [topicA],
      now,
    );
    assert.equal(noProfile.vectorDocuments, 0);
    const emptyScope = await createCoverageRepository(db, {
      ...options,
      scopeKeys: [],
    }).getCoverage(baselineWindow, [topicA], now);
    assert.equal(emptyScope.rawDocuments, 0);
    const knownMisses = [
      {
        from: baselineWindow.from.toISOString(),
        to: baselineWindow.to.toISOString(),
        topicIds: [topicA],
        labelReference: 'fixture-label-only',
        missingRevisionIds: [evidenceA.revision.id],
      },
    ];
    const labeled = createCoverageRepository(db, { ...options, knownMisses });
    assert(
      (await labeled.getCoverage(baselineWindow, [topicA], now)).reasons.includes('retrieval_miss'),
    );
    assert(
      !(await labeled.getCoverage(baselineWindow, [topicB], now)).reasons.includes(
        'retrieval_miss',
      ),
    );
    assert(
      !(await repo.getCoverage(baselineWindow, [topicA], now)).reasons.includes('retrieval_miss'),
    );
    const outsideMiss = createCoverageRepository(db, {
      ...options,
      knownMisses: [{ ...knownMisses[0]!, missingRevisionIds: [randomUUID()] }],
    });
    assert(
      !(await outsideMiss.getCoverage(baselineWindow, [topicA], now)).reasons.includes(
        'retrieval_miss',
      ),
    );
    const wrongWindowMiss = createCoverageRepository(db, {
      ...options,
      knownMisses: [
        {
          ...knownMisses[0]!,
          from: currentWindow.from.toISOString(),
          to: currentWindow.to.toISOString(),
        },
      ],
    });
    assert(
      !(await wrongWindowMiss.getCoverage(baselineWindow, [topicA], now)).reasons.includes(
        'retrieval_miss',
      ),
    );
    const unlabeledMiss = createCoverageRepository(db, {
      ...options,
      knownMisses: [{ ...knownMisses[0]!, labelReference: ' ' }],
    });
    assert(
      !(await unlabeledMiss.getCoverage(baselineWindow, [topicA], now)).reasons.includes(
        'retrieval_miss',
      ),
    );

    const onDemand = await state.planPartition(
      {
        targetRevisionId: a.revision.id,
        mode: 'on_demand',
        scopeKey,
        window: baselineWindow,
        timeBasis: 'published_at',
        workflowVersion: '1',
      },
      now,
    );
    await corpus(onDemand.id);
    await counts([topicA], [1, 1, 1, 1, 1]);
    const repeated = await state.planPartition(
      {
        targetRevisionId: a.revision.id,
        mode: 'incremental',
        scopeKey,
        window: baselineWindow,
        timeBasis: 'published_at',
        workflowVersion: '1',
      },
      now,
    );
    await db
      .update(collectionPartitions)
      .set({ state: 'completed' })
      .where(eq(collectionPartitions.id, repeated.id));
    await db.insert(acquisitionMemberships).values({
      partitionId: repeated.id,
      rawItemId: evidenceA.raw.id,
      revisionId: evidenceA.revision.id,
      runId: evidenceA.run.id,
    });
    await counts([topicA], [1, 1, 1, 2, 2]);
  }, 30000);

  it('performs cohort comparison over common covered targets and ignores on-demand additions', async () => {
    // 1. Register two target revisions
    const tr1 = await state.registerTarget({
      sourceId,
      sourceKey: 'github_releases',
      canonicalIdentity: `fixture/cohort-tr1-${randomUUID()}`,
      selector: { kind: 'repository', owner: 'fixture', repository: 'cohort1' },
      capability,
      policy,
      topicIds: [],
      taxonomyVersion: 'v1.0.0',
      enabled: false,
      cadenceMs: 60000,
      overlapMs: 0,
    });
    await state.setTargetEnabled(tr1.targetId, true, now);

    const tr2 = await state.registerTarget({
      sourceId,
      sourceKey: 'github_releases',
      canonicalIdentity: `fixture/cohort-tr2-${randomUUID()}`,
      selector: { kind: 'repository', owner: 'fixture', repository: 'cohort2' },
      capability,
      policy,
      topicIds: [],
      taxonomyVersion: 'v1.0.0',
      enabled: false,
      cadenceMs: 60000,
      overlapMs: 0,
    });
    await state.setTargetEnabled(tr2.targetId, true, now);

    // 2. Create partitions: tr1 completed in both windows; tr2 completed in baseline but missing in current
    const p1Baseline = await state.planPartition(
      {
        targetRevisionId: tr1.id,
        mode: 'backfill',
        scopeKey: 'baseline-run',
        window: baselineWindow,
        timeBasis: 'published_at',
        workflowVersion: '1',
      },
      now,
    );
    const claim1B = await state.claimPage(p1Baseline.id, 0, now, 10000);
    assert(claim1B);
    await state.commitPage({
      claim: claim1B,
      result: {
        disposition: 'complete',
        nextCursor: null,
        reason: null,
        retryAt: null,
        requests: 1,
        bytes: 100,
        items: [],
      },
      now,
    });

    const p1Current = await state.planPartition(
      {
        targetRevisionId: tr1.id,
        mode: 'incremental',
        scopeKey: 'current-run',
        window: currentWindow,
        timeBasis: 'published_at',
        workflowVersion: '1',
      },
      now,
    );
    const claim1C = await state.claimPage(p1Current.id, 0, now, 10000);
    assert(claim1C);
    await state.commitPage({
      claim: claim1C,
      result: {
        disposition: 'complete',
        nextCursor: null,
        reason: null,
        retryAt: null,
        requests: 1,
        bytes: 100,
        items: [],
      },
      now,
    });

    // tr2 only completed in baseline
    const p2Baseline = await state.planPartition(
      {
        targetRevisionId: tr2.id,
        mode: 'backfill',
        scopeKey: 'baseline-run-2',
        window: baselineWindow,
        timeBasis: 'published_at',
        workflowVersion: '1',
      },
      now,
    );
    const claim2B = await state.claimPage(p2Baseline.id, 0, now, 10000);
    assert(claim2B);
    await state.commitPage({
      claim: claim2B,
      result: {
        disposition: 'complete',
        nextCursor: null,
        reason: null,
        retryAt: null,
        requests: 1,
        bytes: 100,
        items: [],
      },
      now,
    });

    // 3. Seed metric observations for tr1
    const querySig = `sig-${randomUUID()}`;
    await db.insert(metricObservations).values([
      {
        sourceId,
        subjectKey: 'test-subject',
        metricType: 'release_activity',
        unit: 'releases',
        windowStart: baselineWindow.from,
        windowEnd: baselineWindow.to,
        value: 10,
        querySignature: querySig,
      },
      {
        sourceId,
        subjectKey: 'test-subject',
        metricType: 'release_activity',
        unit: 'releases',
        windowStart: currentWindow.from,
        windowEnd: currentWindow.to,
        value: 15,
        querySignature: querySig,
      },
    ]);

    // 4. Create Cohort containing tr1 and tr2
    const cohortId = randomUUID();
    await cohortRepo.createCohortVersion({
      id: cohortId,
      version: `v1-${Date.now()}`,
      effectiveAt: now,
      members: [
        {
          targetRevisionId: tr1.id,
          metric: 'release_activity',
          unit: 'releases',
          querySignature: querySig,
          cadenceMs: 60000,
        },
        {
          targetRevisionId: tr2.id,
          metric: 'release_activity',
          unit: 'releases',
          querySignature: `sig-tr2-${Date.now()}`,
          cadenceMs: 60000,
        },
      ],
    });

    // 5. Compare windows before on-demand additions
    const initialComparison = await cohortRepo.compareWindows(
      cohortId,
      'release_activity',
      'releases',
      baselineWindow,
      currentWindow,
    );

    // tr1 is included (covered in both), tr2 is excluded (missing current) -> denominator = 1, excludedTargets = 1
    assert.equal(initialComparison.denominator, 1);
    assert.equal(initialComparison.excludedTargets, 1);
    assert.equal(initialComparison.baseline, 10);
    assert.equal(initialComparison.current, 15);
    assert.equal(initialComparison.partial, true);

    // 6. Now add an ON-DEMAND partition and raw items / metric observations
    const pOnDemand = await state.planPartition(
      {
        targetRevisionId: tr1.id,
        mode: 'on_demand',
        scopeKey: 'on-demand-query-run-1',
        window: currentWindow,
        timeBasis: 'published_at',
        workflowVersion: '1',
      },
      now,
    );

    const [run] = await db
      .insert(collectionRuns)
      .values({
        sourceId,
        scheduledAt: now,
        startedAt: now,
        endedAt: now,
        status: 'succeeded',
      })
      .returning();
    assert(run);

    const onDemandRaw = await db
      .insert(rawItems)
      .values({
        sourceId,
        runId: run.id,
        externalId: `on-demand-raw-${Date.now()}`,
        canonicalUrl: `https://example.com/on-demand-${Date.now()}`,
        payload: { test: true },
        payloadHash: 'f'.repeat(64),
      })
      .returning();
    assert(onDemandRaw[0]);
    await db.insert(acquisitionMemberships).values({
      partitionId: pOnDemand.id,
      rawItemId: onDemandRaw[0].id,
      runId: onDemandRaw[0].runId,
    });

    // Insert metric observation tied to on-demand raw item
    await db.insert(metricObservations).values({
      sourceId,
      subjectKey: 'test-subject',
      metricType: 'release_activity',
      unit: 'releases',
      windowStart: currentWindow.from,
      windowEnd: currentWindow.to,
      value: 9999, // Big outlier that would alter metric if included
      rawItemId: onDemandRaw[0].id,
    });

    // 7. Compare windows after on-demand additions: cohort values MUST remain completely unchanged!
    const afterComparison = await cohortRepo.compareWindows(
      cohortId,
      'release_activity',
      'releases',
      baselineWindow,
      currentWindow,
    );

    assert.equal(afterComparison.denominator, initialComparison.denominator);
    assert.equal(afterComparison.excludedTargets, initialComparison.excludedTargets);
    assert.equal(afterComparison.baseline, initialComparison.baseline);
    assert.equal(afterComparison.current, initialComparison.current);
    assert.equal(afterComparison.partial, initialComparison.partial);
  });
});
