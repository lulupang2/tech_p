import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  buildCanonicalIdentity,
  createCollectorPageAdapter,
  resolveTargetCapability,
} from '@techpulse/collectors';
import {
  collectionHash,
  type CollectionPartition,
  type CollectionTargetRevision,
  type CollectorPagePort,
  type ModelProfile,
} from '@techpulse/domain';
import {
  collectionCheckpoints,
  collectionPartitions,
  createCollectionStateRepository,
  createDatabaseClient,
  createProviderBudgetRepository,
  deliveryOutbox,
  providerBudgetReservations,
  sources,
} from '@techpulse/database';
import { licenses } from '../packages/database/src/schema/index.js';
import { createApprovedApiModelBindings } from '../apps/api/src/approved-models.js';
import { loadApiConfig } from '../apps/api/src/config.js';
import { loadWorkerConfig } from '../apps/worker/src/config.js';
import { createWorkerRuntime, type WorkerRuntime } from '../apps/worker/src/index.js';

const DAY = 86_400_000;
const RUN_KEY = 'cov009-20260910-live-v1';
const targets = [
  { owner: 'microsoft', repository: 'TypeScript', licenseId: 'apache-2.0' },
  { owner: 'nodejs', repository: 'node', licenseId: 'mit' },
  { owner: 'microsoft', repository: 'playwright', licenseId: 'apache-2.0' },
  { owner: 'facebook', repository: 'react', licenseId: 'mit' },
  { owner: 'pgvector', repository: 'pgvector', licenseId: 'postgresql' },
] as const;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const windowTo = process.env['COV009_WINDOW_TO']
    ? new Date(required('COV009_WINDOW_TO'))
    : new Date(Math.floor(startedAt.getTime() / 1000) * 1000);
  if (!Number.isFinite(windowTo.getTime()))
    throw new Error('COV009_WINDOW_TO must be an ISO timestamp');
  const windowFrom = process.env['COV009_WINDOW_FROM']
    ? new Date(required('COV009_WINDOW_FROM'))
    : new Date(windowTo.getTime() - 90 * DAY);
  if (!Number.isFinite(windowFrom.getTime()) || windowFrom >= windowTo) {
    throw new Error('COV009_WINDOW_FROM must be an ISO timestamp before COV009_WINDOW_TO');
  }
  const outputPath =
    process.env['COV009_OUTPUT_PATH']?.trim() || 'docs/experiments/cov-009/live-measurement.json';
  const databaseUrl = process.env.DATABASE_URL_DIRECT?.trim() || required('DATABASE_URL');
  const redisUrl = required('REDIS_URL');
  const githubPat = required('GITHUB_PAT');
  const dbClient = createDatabaseClient(databaseUrl);
  await dbClient.connect();
  assert.equal((await dbClient.checkVector()).installed, true, 'pgvector extension is required');
  const db = dbClient.db;
  const state = createCollectionStateRepository(db);

  await db
    .insert(licenses)
    .values([
      {
        id: 'apache-2.0',
        spdxId: 'Apache-2.0',
        name: 'Apache License 2.0',
        url: 'https://www.apache.org/licenses/LICENSE-2.0',
      },
      { id: 'mit', spdxId: 'MIT', name: 'MIT License', url: 'https://opensource.org/license/mit' },
      {
        id: 'postgresql',
        spdxId: 'PostgreSQL',
        name: 'PostgreSQL License',
        url: 'https://opensource.org/license/postgresql',
      },
    ])
    .onConflictDoNothing();

  let [source] = await db.select().from(sources).where(eq(sources.key, 'github_releases'));
  if (!source) {
    [source] = await db
      .insert(sources)
      .values({
        key: 'github_releases',
        name: 'GitHub Releases',
        kind: 'api',
        baseUrl: 'https://api.github.com',
        enabled: true,
        policyReviewedAt: startedAt,
      })
      .returning();
  } else {
    await db
      .update(sources)
      .set({ enabled: true, policyReviewedAt: source.policyReviewedAt ?? startedAt })
      .where(eq(sources.id, source.id));
  }
  assert(source, 'github_releases source could not be created');

  const apiBindings = createApprovedApiModelBindings(loadApiConfig(process.env));
  assert(apiBindings?.embedding, 'approved API model bindings are required');
  const workerConfig = loadWorkerConfig(process.env);
  const workerEmbeddingProfile: ModelProfile = {
    provider: requiredValue(workerConfig.embedding.provider, 'embedding provider'),
    model: requiredValue(workerConfig.embedding.model, 'embedding model'),
    version: requiredValue(workerConfig.embedding.version, 'embedding version'),
    dimensions: requiredNumber(workerConfig.embedding.dimensions, 'embedding dimensions'),
    priceVersion: requiredValue(workerConfig.embedding.priceVersion, 'embedding price version'),
    tokenizerVersion: requiredValue(
      workerConfig.embedding.tokenizerVersion,
      'embedding tokenizer version',
    ),
    approvalReference: requiredValue(
      workerConfig.embedding.approvalReference,
      'embedding approval reference',
    ),
  };
  assert.equal(
    collectionHash(workerEmbeddingProfile),
    collectionHash(apiBindings.embedding.profile),
    'API and worker embedding profiles must match exactly',
  );

  await createProviderBudgetRepository(db).configureScope({
    id: 'dec-012-cov009',
    approved: true,
    currency: 'USD',
    maxDailyUnits: 2_000_000,
    maxOutstandingUnits: 2_000_000,
    maxDailyTokens: 1_650_000,
    approvedModelProfiles: [
      collectionHash(apiBindings.chat.profile),
      collectionHash(workerEmbeddingProfile),
    ],
    laneLimits: {
      ingestion_embedding: { maxDailyUnits: 100_000, maxDailyTokens: 1_000_000 },
      query_embedding: { maxDailyUnits: 50_000, maxDailyTokens: 100_000 },
      chat: { maxDailyUnits: 1_000_000, maxDailyTokens: 550_000 },
    },
  });

  const targetRevisions: CollectionTargetRevision[] = [];
  for (const target of targets) {
    const selector = {
      kind: 'repository' as const,
      owner: target.owner,
      repository: target.repository,
    };
    const revision = await state.registerTarget({
      sourceId: source.id,
      sourceKey: 'github_releases',
      canonicalIdentity: buildCanonicalIdentity('github_releases', selector),
      selector,
      capability: resolveTargetCapability('github_releases'),
      policy: {
        version: '1.0.0',
        approved: true,
        fetch: true,
        store: true,
        embed: true,
        modelInput: true,
        displayExcerpt: true,
        licenseId: target.licenseId,
        verbatimOnly: false,
      },
      topicIds: [],
      taxonomyVersion: '2026-09-01.1',
      enabled: false,
      cadenceMs: 6 * 60 * 60 * 1000,
      overlapMs: 15 * 60 * 1000,
    });
    await state.setTargetEnabled(revision.targetId, true, startedAt);
    const enabled = await state.getTargetRevision(revision.id);
    assert(enabled?.enabled, `${revision.canonicalIdentity} was not enabled`);
    targetRevisions.push(enabled);
  }

  const baseCollector = createCollectorPageAdapter({ pat: githubPat });
  let sourceRequests = 0;
  let sourceBytes = 0;
  const boundedCollector: CollectorPagePort = {
    async collectPage(request) {
      if (sourceRequests >= 200) throw new Error('COV-009 GitHub daily request cap reached');
      // Reserve one request before I/O so failed HTTP attempts also consume the cap.
      sourceRequests += 1;
      const result = await baseCollector.collectPage({
        ...request,
        limit: 10,
        maxRequests: Math.min(request.maxRequests, 1),
        maxBytes: Math.min(request.maxBytes, 25 * 1024 * 1024 - sourceBytes),
      });
      sourceRequests += Math.max(0, result.requests - 1);
      sourceBytes += result.bytes;
      if (sourceRequests > 200 || sourceBytes > 25 * 1024 * 1024)
        throw new Error('COV-009 daily source budget exceeded');
      return result;
    },
  };

  const backfills = await findScopedPartitions(db, state, RUN_KEY);
  if (backfills.length === 0) {
    for (const target of targetRevisions) {
      backfills.push(
        await state.planPartition(
          {
            targetRevisionId: target.id,
            mode: 'backfill',
            scopeKey: RUN_KEY,
            window: { from: windowFrom, to: windowTo },
            timeBasis: 'published_at',
            workflowVersion: 'cov009-live-v1',
          },
          startedAt,
        ),
      );
    }
  }
  assert.equal(backfills.length, targets.length, 'COV-009 must have exactly five backfills');

  const runtimeConfig = {
    ...workerConfig,
    databaseUrl,
    redisUrl,
    concurrency: 1,
    incrementalConcurrency: 1,
    backfillConcurrency: 1,
    pollIntervalMs: 200,
    leaseMs: 30_000,
    embedding: { ...workerConfig.embedding, version: workerEmbeddingProfile.version },
  };
  const startWorker = () =>
    createWorkerRuntime({
      config: runtimeConfig,
      databaseClient: dbClient,
      collectorResolver: () => boundedCollector,
      enableHealthServer: false,
      enableDualLaneScheduler: true,
    });

  const backfillNeedsRuntime = await scopedNeedsRuntime(
    db,
    backfills.map((partition) => partition.id),
  );
  let worker: WorkerRuntime | null = backfillNeedsRuntime ? await startWorker() : null;
  let restartSnapshot: Record<string, unknown> = {};
  try {
    if (worker) {
      await waitUntil(
        async () => {
          const rows = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(collectionCheckpoints)
            .where(
              inArray(
                collectionCheckpoints.partitionId,
                backfills.map((p) => p.id),
              ),
            );
          return (rows[0]?.count ?? 0) >= targets.length;
        },
        180_000,
        'first page canaries',
      );

      restartSnapshot = await scopedSnapshot(
        db,
        backfills.map((p) => p.id),
      );
      await worker.stop();
      worker = null;
      await sleep(750);
      worker = await startWorker();
    } else {
      restartSnapshot = await scopedSnapshot(
        db,
        backfills.map((partition) => partition.id),
      );
    }

    await waitForPartitions(db, backfills, 360_000);

    const incrementals = await findScopedPartitions(db, state, `${RUN_KEY}-incremental`);
    const incrementalTo = new Date();
    const incrementalFrom = new Date(incrementalTo.getTime() - 6 * 60 * 60 * 1000 - 15 * 60 * 1000);
    if (incrementals.length === 0) {
      for (const target of targetRevisions) {
        incrementals.push(
          await state.planPartition(
            {
              targetRevisionId: target.id,
              mode: 'incremental',
              scopeKey: `${RUN_KEY}-incremental`,
              window: { from: incrementalFrom, to: incrementalTo },
              timeBasis: 'published_at',
              workflowVersion: 'cov009-live-v1',
            },
            incrementalTo,
          ),
        );
      }
    }
    assert.equal(
      incrementals.length,
      targets.length,
      'COV-009 must have exactly five incrementals',
    );
    const allPartitions = [...backfills, ...incrementals];
    if (
      !worker &&
      (await scopedNeedsRuntime(
        db,
        allPartitions.map((partition) => partition.id),
      ))
    ) {
      worker = await startWorker();
    }
    await waitForPartitions(db, incrementals, 240_000);
    await waitUntil(
      async () => {
        const rows = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(deliveryOutbox)
          .where(
            and(
              inArray(
                deliveryOutbox.partitionId,
                allPartitions.map((p) => p.id),
              ),
              isNull(deliveryOutbox.completedAt),
            ),
          );
        return (rows[0]?.count ?? 0) === 0;
      },
      1_800_000,
      'downstream outbox completion',
    );

    const finalSnapshot = await scopedSnapshot(
      db,
      allPartitions.map((p) => p.id),
    );
    const datasetRows = await db.execute<{ payload_hash: string }>(sql`
      SELECT DISTINCT r.payload_hash
      FROM raw_items r
      JOIN acquisition_memberships a ON a.raw_item_id = r.id
      WHERE a.partition_id IN (${sql.join(
        allPartitions.map((p) => sql`${p.id}::uuid`),
        sql`, `,
      )})
      ORDER BY r.payload_hash`);
    const datasetHash = createHash('sha256')
      .update(datasetRows.rows.map((row) => row.payload_hash).join('\n'))
      .digest('hex');
    const targetCoverageRows = await db.execute<{
      canonical_identity: string;
      raw_items: number;
      revisions: number;
      chunks: number;
      embeddings: number;
    }>(sql`
      SELECT ct.canonical_identity,
             count(DISTINCT a.raw_item_id)::int AS raw_items,
             count(DISTINCT a.revision_id)::int AS revisions,
             count(DISTINCT c.id)::int AS chunks,
             count(DISTINCT e.id)::int AS embeddings
      FROM collection_partitions p
      JOIN collection_target_revisions ctr ON ctr.id = p.target_revision_id
      JOIN collection_targets ct ON ct.id = ctr.target_id
      LEFT JOIN acquisition_memberships a ON a.partition_id = p.id
      LEFT JOIN document_revisions dr ON dr.id = a.revision_id
      LEFT JOIN chunks c ON c.document_revision_id = dr.id
      LEFT JOIN embeddings e ON e.chunk_id = c.id
      WHERE p.id IN (${sql.join(
        allPartitions.map((partition) => sql`${partition.id}::uuid`),
        sql`, `,
      )})
      GROUP BY ct.canonical_identity
      ORDER BY ct.canonical_identity`);
    const budgetRows = await db
      .select({
        state: providerBudgetReservations.state,
        actualUnits: providerBudgetReservations.actualUnits,
        actualTokens: providerBudgetReservations.actualTokens,
      })
      .from(providerBudgetReservations)
      .where(eq(providerBudgetReservations.scopeId, 'dec-012-cov009'));
    const actualUnits = budgetRows.reduce((sum, row) => sum + (row.actualUnits ?? 0), 0);
    const actualTokens = budgetRows.reduce((sum, row) => sum + (row.actualTokens ?? 0), 0);
    const unknownReservations = budgetRows.filter((row) => row.state === 'outcome_unknown').length;

    const measurement = {
      schemaVersion: 1,
      task: 'COV-009',
      runKey: RUN_KEY,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      window: { from: windowFrom.toISOString(), to: windowTo.toISOString() },
      targets: targetRevisions.map((target) => ({
        canonicalIdentity: target.canonicalIdentity,
        licenseId: target.policy.licenseId,
        targetRevisionId: target.id,
      })),
      configuration: {
        source: 'github_releases',
        pageSize: 10,
        backfillConcurrency: 1,
        incrementalConcurrency: 1,
        cadenceMs: 21_600_000,
        jitterMs: 900_000,
        onDemandEnabled: false,
        sourceRequestDailyCap: 200,
        sourceRequestTotalCap: 1_000,
        sourceByteDailyCap: 26_214_400,
        sourceByteTotalCap: 262_144_000,
        providerSpendCapUsd: 2,
        usdKrwConversion: null,
      },
      models: {
        chat: apiBindings.chat.profile,
        embedding: workerEmbeddingProfile,
      },
      sourceUsage: {
        requests: finalSnapshot.requests,
        bytes: finalSnapshot.bytes,
        requestsDuringThisProcess: sourceRequests,
        bytesDuringThisProcess: sourceBytes,
      },
      providerUsage: {
        actualMicroUsd: actualUnits,
        actualUsd: actualUnits / 1_000_000,
        actualTokens,
        unknownReservations,
      },
      restart: { performed: true, snapshotBeforeRestart: restartSnapshot },
      final: finalSnapshot,
      targetCoverage: targetCoverageRows.rows,
      dataset: { distinctRawItems: datasetRows.rows.length, sha256: datasetHash },
      notes: [
        'Existing PostgreSQL and Redis data were preserved.',
        'No Docker service, on-demand acquisition, bulk target expansion, or deployment was used.',
        'USD is authoritative; no KRW conversion was displayed.',
      ],
    };
    await mkdir(outputPath.replace(/[\\/][^\\/]+$/u, '') || '.', { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(measurement, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `${JSON.stringify({
        status: 'passed',
        sourceUsage: measurement.sourceUsage,
        providerUsage: measurement.providerUsage,
        dataset: measurement.dataset,
        final: measurement.final,
      })}\n`,
    );
  } finally {
    if (worker) await worker.stop();
    await dbClient.close();
  }
}

function requiredValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function requiredNumber(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is required`);
  return value as number;
}

async function waitUntil(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForPartitions(
  db: ReturnType<typeof createDatabaseClient>['db'],
  partitions: readonly CollectionPartition[],
  timeoutMs: number,
): Promise<void> {
  await waitUntil(
    async () => {
      const rows = await db
        .select({ id: collectionPartitions.id, state: collectionPartitions.state })
        .from(collectionPartitions)
        .where(
          inArray(
            collectionPartitions.id,
            partitions.map((p) => p.id),
          ),
        );
      const failed = rows.filter((row) => ['failed', 'cancelled', 'partial'].includes(row.state));
      if (failed.length > 0) throw new Error(`Partitions failed: ${JSON.stringify(failed)}`);
      return rows.length === partitions.length && rows.every((row) => row.state === 'completed');
    },
    timeoutMs,
    `${partitions.length} partitions`,
  );
}

async function findScopedPartitions(
  db: ReturnType<typeof createDatabaseClient>['db'],
  state: ReturnType<typeof createCollectionStateRepository>,
  scopeKey: string,
): Promise<CollectionPartition[]> {
  const rows = await db
    .select({ id: collectionPartitions.id })
    .from(collectionPartitions)
    .where(eq(collectionPartitions.scopeKey, scopeKey));
  const partitions = await Promise.all(rows.map((row) => state.getPartition(row.id)));
  return partitions.filter((partition): partition is CollectionPartition => partition !== null);
}

async function scopedNeedsRuntime(
  db: ReturnType<typeof createDatabaseClient>['db'],
  partitionIds: readonly string[],
): Promise<boolean> {
  const [partitionState] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionPartitions)
    .where(
      and(
        inArray(collectionPartitions.id, partitionIds),
        sql`${collectionPartitions.state} <> 'completed'`,
      ),
    );
  const [pendingDelivery] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deliveryOutbox)
    .where(
      and(inArray(deliveryOutbox.partitionId, partitionIds), isNull(deliveryOutbox.completedAt)),
    );
  return (partitionState?.count ?? 0) > 0 || (pendingDelivery?.count ?? 0) > 0;
}

interface ScopedSnapshot {
  partitions: number;
  completed_partitions: number;
  checkpoints: number;
  requests: number;
  bytes: number;
  raw_items: number;
  revisions: number;
  chunks: number;
  embeddings: number;
  pending_deliveries: number;
}

async function scopedSnapshot(
  db: ReturnType<typeof createDatabaseClient>['db'],
  partitionIds: readonly string[],
): Promise<ScopedSnapshot> {
  const ids = sql.join(
    partitionIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = await db.execute<ScopedSnapshot>(sql`
    WITH scoped_partitions AS (
      SELECT id, state FROM collection_partitions WHERE id IN (${ids})
    ), checkpoint_totals AS (
      SELECT count(*)::int AS checkpoints,
             coalesce(sum(requests), 0)::int AS requests,
             coalesce(sum(bytes), 0)::bigint AS bytes
      FROM collection_checkpoints WHERE partition_id IN (SELECT id FROM scoped_partitions)
    ), acquisition_totals AS (
      SELECT count(DISTINCT raw_item_id)::int AS raw_items,
             count(DISTINCT revision_id)::int AS revisions
      FROM acquisition_memberships WHERE partition_id IN (SELECT id FROM scoped_partitions)
    ), content_totals AS (
      SELECT count(DISTINCT c.id)::int AS chunks,
             count(DISTINCT e.id)::int AS embeddings
      FROM chunks c
      JOIN document_revisions r ON r.id = c.document_revision_id
      JOIN acquisition_memberships a ON a.revision_id = r.id
      LEFT JOIN embeddings e ON e.chunk_id = c.id
      WHERE a.partition_id IN (SELECT id FROM scoped_partitions)
    ), delivery_totals AS (
      SELECT count(*) FILTER (WHERE completed_at IS NULL)::int AS pending_deliveries
      FROM delivery_outbox WHERE partition_id IN (SELECT id FROM scoped_partitions)
    )
    SELECT count(*)::int AS partitions,
           count(*) FILTER (WHERE state = 'completed')::int AS completed_partitions,
           checkpoint_totals.checkpoints, checkpoint_totals.requests, checkpoint_totals.bytes,
           acquisition_totals.raw_items, acquisition_totals.revisions,
           content_totals.chunks, content_totals.embeddings,
           delivery_totals.pending_deliveries
    FROM scoped_partitions, checkpoint_totals, acquisition_totals, content_totals, delivery_totals
    GROUP BY checkpoint_totals.checkpoints, checkpoint_totals.requests, checkpoint_totals.bytes,
             acquisition_totals.raw_items, acquisition_totals.revisions,
             content_totals.chunks, content_totals.embeddings,
             delivery_totals.pending_deliveries`);
  const snapshot = result.rows[0];
  if (!snapshot) throw new Error('COV-009 scoped snapshot is empty');
  return snapshot;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
