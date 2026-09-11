import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import {
  collectionHash,
  type ChatPort,
  type EmbeddingPort,
  createEmbeddingService,
  encodePageCursor,
  type CollectorPagePort,
  type CollectedRawItem,
  type ModelProfile,
} from '@techpulse/domain';
import {
  createDatabaseClient,
  sources,
  collectionPartitions,
  collectionCheckpoints,
  rawItems,
  documentRevisions,
  chunks,
  embeddings,
  deliveryOutbox,
  createEmbeddingWorkRepository,
  createProviderBudgetRepository,
  providerBudgetScopes,
  type DatabaseClient,
} from '@techpulse/database';
import { licenses } from '../packages/database/src/schema/index.js';
import { start as startApi, type ApiModelBindings } from '../apps/api/src/index.js';
import { createWorkerRuntime, type WorkerRuntime } from '../apps/worker/src/index.js';

interface SmokeEnvironment {
  databaseUrl: string;
  redisUrl: string;
  apiPort: number;
  workerHealthPort: number;
  opsApiKey: string;
}

const env: SmokeEnvironment = {
  databaseUrl:
    process.env.SMOKE_DATABASE_URL ||
    'postgresql://postgres:cov008-fixture-only@127.0.0.1:55439/cov008',
  redisUrl: process.env.SMOKE_REDIS_URL || 'redis://127.0.0.1:56439',
  apiPort: 34567,
  workerHealthPort: 34568,
  opsApiKey: 'smoke-ops-secret-key-32chars-minimum-token',
};

const fakeProfile: ModelProfile = {
  provider: 'fixture',
  model: 'fixture-embed-v1',
  version: '2026-09-01',
  dimensions: 8,
  priceVersion: 'fixture-free',
  tokenizerVersion: 'fixture-tok',
  approvalReference: 'SMOKE-COV008-APPROVAL',
};
const fakeProfileHash = collectionHash(fakeProfile);

const fakeChatPort: ChatPort = {
  async complete() {
    return {
      content: 'Grounded response for smoke testing citing [C1].',
      metadata: {
        model: 'fixture-chat-v1',
        usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
        latencyMs: 10,
      },
    };
  },
};

const fakeEmbeddingPort: EmbeddingPort = {
  async embed() {
    embeddingCalls++;
    return {
      vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      metadata: {
        model: fakeProfile.model,
        dimensions: fakeProfile.dimensions,
        latencyMs: 5,
      },
    };
  },
  async embedMany(requests) {
    return Promise.all(requests.map((r) => this.embed(r)));
  },
};
let embeddingCalls = 0;

const scopeId = 'smoke-budget-scope-cov008';
const laneLimits = Object.fromEntries(
  ['ingestion_embedding', 'query_embedding', 'chat'].map((lane) => [
    lane,
    { maxDailyUnits: 1000000, maxDailyTokens: 1000000 },
  ]),
);

const models: ApiModelBindings = {
  chat: {
    port: fakeChatPort,
    profile: {
      provider: 'fixture',
      model: 'fixture-chat-v1',
      version: '2026-09-01',
      dimensions: 1536,
      priceVersion: 'fixture-free',
      tokenizerVersion: 'fixture-tok',
      approvalReference: 'SMOKE-COV008-APPROVAL',
    },
    scopeId,
    caps: { maxInputTokens: 4000, maxOutputTokens: 2000 },
    priceRate: { unitsPerThousandTokens: 0 },
  },
  embedding: {
    port: fakeEmbeddingPort,
    profile: fakeProfile,
    scopeId,
    caps: { maxInputTokens: 8192 },
    priceRate: { unitsPerThousandTokens: 0 },
  },
};

async function runStep(name: string, fn: () => Promise<void>) {
  process.stdout.write(`\n--- [SMOKE STEP] ${name} ---\n`);
  const start = Date.now();
  await fn();
  process.stdout.write(`[PASS] ${name} (${Date.now() - start}ms)\n`);
}

async function main() {
  const databaseLocation = new URL(env.databaseUrl);
  const redisLocation = new URL(env.redisUrl);
  assert.equal(databaseLocation.hostname, '127.0.0.1', 'Smoke requires local PostgreSQL');
  assert.match(
    databaseLocation.pathname,
    /^\/cov008_[a-z0-9_]+$/,
    'Use a new cov008_ fixture database',
  );
  assert.equal(redisLocation.hostname, '127.0.0.1', 'Smoke requires local Redis');
  const dbClient: DatabaseClient = createDatabaseClient(env.databaseUrl);
  await dbClient.connect();
  const db = dbClient.db;
  const existing = await db.execute(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  assert.equal(
    existing.rows.length,
    0,
    'Use an empty fixture database; existing data is preserved',
  );

  process.stdout.write('Applying forward migrations on isolated database...\n');
  const migrationResult = await dbClient.migrate();
  assert.equal(migrationResult.applied, true, 'Migration failed');
  const vectorCheck = await dbClient.checkVector();
  assert.equal(vectorCheck.installed, true, 'Vector extension missing');

  await db
    .insert(licenses)
    .values({
      id: 'mit',
      spdxId: 'MIT',
      name: 'MIT License',
      url: 'https://opensource.org/licenses/MIT',
    })
    .onConflictDoNothing();

  // Seed approved budget scope for model calls
  await db
    .insert(providerBudgetScopes)
    .values({
      id: scopeId,
      approved: true,
      currency: 'USD',
      maxDailyUnits: 1_000_000,
      maxOutstandingUnits: 1_000_000,
      maxDailyTokens: 1_000_000,
      approvedModelProfiles: [collectionHash(models.chat.profile), fakeProfileHash],
      laneLimits,
    })
    .onConflictDoUpdate({
      target: providerBudgetScopes.id,
      set: {
        approved: true,
        laneLimits,
        approvedModelProfiles: [collectionHash(models.chat.profile), fakeProfileHash],
      },
    });

  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  await redis.ping();
  assert.equal(
    await redis.dbsize(),
    0,
    'Use an empty Redis logical DB; existing data is preserved',
  );

  let apiServer: ReturnType<typeof startApi> | undefined;
  let worker: WorkerRuntime | null = null;

  // Mock collector state
  const mockPageItems: CollectedRawItem[] = [
    {
      externalId: 'fixture-item-1',
      payload: {
        license: 'MIT',
        name: 'TypeScript Performance and Compiler Architecture',
        body: 'Comprehensive overview of TypeScript compiler internals and AST transforms.',
        url: 'https://example.com/fixture/1',
      },
      rawHash: '1'.repeat(64),
      publishedAt: new Date('2026-07-01T10:00:00Z'),
      cursor: 'cursor-1',
      metadata: {
        canonicalUrl: 'https://example.com/fixture/1',
      },
    },
  ];

  let resumeBackfill = false;
  let backfillPartitionId = '';
  let backfillCalls = 0;
  let incrementalCalls = 0;

  const mockCollector: CollectorPagePort = {
    async collectPage(req) {
      if (req.partition.mode === 'backfill') {
        backfillCalls++;
        if (req.partition.pageSequence === 0) {
          return {
            items: mockPageItems.slice(0, 1),
            nextCursor: encodePageCursor(
              req.partition,
              req.target.capability.cursorVersion,
              'page-2',
            ),
            disposition: 'continue',
            reason: null,
            retryAt: null,
            requests: 1,
            bytes: 1024,
          };
        }
        if (!resumeBackfill) throw new Error('fixture_pause');
        return {
          items: [],
          nextCursor: null,
          disposition: 'complete',
          reason: null,
          retryAt: null,
          requests: 1,
          bytes: 512,
        };
      }
      if (req.partition.mode === 'incremental') {
        incrementalCalls++;
        return {
          items: [
            {
              externalId: 'fixture-incremental-1',
              payload: {
                license: 'MIT',
                name: 'TypeScript Language Updates in Modern Tooling',
                body: 'New compiler features and incremental checking workflows.',
                url: 'https://example.com/fixture/incremental-1',
              },
              rawHash: '2'.repeat(64),
              publishedAt: new Date('2026-09-08T09:00:00Z'),
              cursor: 'cursor-inc-1',
              metadata: {
                canonicalUrl: 'https://example.com/fixture/incremental-1',
              },
            },
          ],
          nextCursor: null,
          disposition: 'complete',
          reason: null,
          retryAt: null,
          requests: 1,
          bytes: 800,
        };
      }
      return {
        items: [],
        nextCursor: null,
        disposition: 'complete',
        reason: null,
        retryAt: null,
        requests: 0,
        bytes: 0,
      };
    },
  };

  const collectorResolver = () => mockCollector;

  async function startWorker() {
    return createWorkerRuntime({
      databaseClient: dbClient,
      config: {
        databaseUrl: env.databaseUrl,
        redisUrl: env.redisUrl,
        concurrency: 2,
        incrementalConcurrency: 5,
        backfillConcurrency: 2,
        pollIntervalMs: 20,
        leaseMs: 5000,
        allowFixtureProviders: true,
        healthPort: env.workerHealthPort,
        embedding: { dimensions: fakeProfile.dimensions },
      },
      embeddingService: createEmbeddingService({
        workPort: createEmbeddingWorkRepository(dbClient.db),
        budgetPort: createProviderBudgetRepository(dbClient.db),
        embeddingPort: fakeEmbeddingPort,
        scopeId,
        priceTable: {
          'fixture-free': { unitsPerThousandTokens: 0 },
        },
        caps: { maxInputTokens: 8192, leaseMs: 30000 },
      }),
      embeddingProfile: fakeProfile,
      collectorResolver,
      enableHealthServer: true,
      enableDualLaneScheduler: true,
    });
  }

  let targetRevisionId = '';
  let incCompleted = false;

  try {
    await runStep('1. Start API Server with Injected Models and Routes', async () => {
      apiServer = startApi({
        env: {
          DATABASE_URL: env.databaseUrl,
          REDIS_URL: env.redisUrl,
          PORT: String(env.apiPort),
          OPS_API_KEY: env.opsApiKey,
          WORKER_HEALTH_URL: '',
          CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:4173',
        },
        models,
        resolveTargetPolicy: async () => ({
          version: '1.0.0',
          approved: true,
          fetch: true,
          store: true,
          embed: true,
          modelInput: true,
          displayExcerpt: true,
          licenseId: 'MIT',
          verbatimOnly: false,
        }),
      });
      assert(apiServer, 'API server returned null');

      const liveRes = await fetch(`http://127.0.0.1:${env.apiPort}/health/live`);
      assert.equal(liveRes.status, 200);
      const readyRes = await fetch(`http://127.0.0.1:${env.apiPort}/health/ready`);
      assert.equal(readyRes.status, 200);
    });

    await runStep('2. Register Target & Enable via Protected Ops Route', async () => {
      // Seed parent source first
      const sourceKey = 'github_releases' as const;
      let [src] = await db.select().from(sources).where(eq(sources.key, sourceKey));
      if (!src) {
        [src] = await db
          .insert(sources)
          .values({
            id: randomUUID(),
            key: sourceKey,
            name: 'Smoke GitHub Releases',
            kind: 'api',
            baseUrl: 'https://api.github.com',
            enabled: true,
            policyReviewedAt: new Date(),
          })
          .returning();
      }
      const sourceId = src!.id;
      const registerRes = await fetch(`http://127.0.0.1:${env.apiPort}/api/v1/ops/targets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.opsApiKey}`,
          'Idempotency-Key': `reg-${randomUUID()}`,
        },
        body: JSON.stringify({
          sourceId,
          sourceKey,
          canonicalIdentity: `${sourceKey}:microsoft/typescript`,
          selector: { kind: 'repository', owner: 'microsoft', repository: 'typescript' },
          enabled: false,
          cadenceMs: 3600000,
          overlapMs: 60000,
          policyVersion: '1.0.0',
          taxonomyVersion: '2026-09-01.1',
          topicIds: [randomUUID()],
          capability: {
            historyMode: 'paginated_history',
            timeBasis: 'published_at',
            cursorVersion: 1,
            stablePagination: true,
            canCollect: true,
            canSearch: true,
            canDiscover: false,
            reviewedAt: '2026-09-01T00:00:00Z',
            earliestAvailableAt: '2020-01-01T00:00:00Z',
          },
        }),
      });
      const registerText = await registerRes.text();
      assert.equal(registerRes.status, 200, `Register target failed: ${registerText}`);
      const registered = JSON.parse(registerText);
      targetRevisionId = registered.id;
      assert.equal(registered.enabled, false);

      // Enable target
      const enableRes = await fetch(
        `http://127.0.0.1:${env.apiPort}/api/v1/ops/targets/${registered.targetId}/enable`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.opsApiKey}`,
            'Idempotency-Key': `enable-${randomUUID()}`,
          },
          body: JSON.stringify({ reason: 'Smoke test target activation' }),
        },
      );
      const enableText = await enableRes.text();
      assert.equal(enableRes.status, 200, `Enable target failed: ${enableText}`);
    });

    await runStep(
      '3. Start Worker Runtime with Dual-Lane Scheduler and Injected Fake Embeddings',
      async () => {
        worker = await startWorker();

        const workerLiveRes = await fetch(`http://127.0.0.1:${env.workerHealthPort}/health/live`);
        assert.equal(workerLiveRes.status, 200);
        const workerReadyRes = await fetch(`http://127.0.0.1:${env.workerHealthPort}/health/ready`);
        assert.equal(workerReadyRes.status, 200);
      },
    );

    await runStep('4. Paginated Backfill: Checkpoint, Pause, and Worker Restart', async () => {
      // Plan a backfill partition
      const planRes = await fetch(`http://127.0.0.1:${env.apiPort}/api/v1/ops/partitions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.opsApiKey}`,
          'Idempotency-Key': `plan-backfill-${randomUUID()}`,
        },
        body: JSON.stringify({
          targetRevisionId,
          mode: 'backfill',
          scopeKey: 'smoke-backfill',
          from: '2026-06-01T00:00:00Z',
          to: '2026-09-01T00:00:00Z',
          timeBasis: 'published_at',
          workflowVersion: '1',
          dryRun: false,
        }),
      });
      const planText = await planRes.text();
      const partition = JSON.parse(planText);
      assert.ok(partition.id, 'No partition returned');
      const partitionId = partition.id;
      backfillPartitionId = partitionId;
      // Wait for worker to claim page 0, execute, and create continuation for page 1
      let page1Checkpoint = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 150));
        const check = await db
          .select()
          .from(collectionCheckpoints)
          .where(eq(collectionCheckpoints.partitionId, partitionId));
        if (check.some((c) => c.pageSequence === 0)) {
          page1Checkpoint = true;
          break;
        }
      }
      assert.equal(page1Checkpoint, true, 'Page 0 did not checkpoint');
      assert.equal(backfillCalls >= 1, true, 'Collector was not called for backfill');

      // Verify raw item persisted and delivery outbox was created
      const raw = await db.select().from(rawItems);
      assert.equal(raw.length >= 1, true, 'No raw items saved');

      await worker?.stop();
      worker = null;
      const paused = await db
        .select()
        .from(collectionCheckpoints)
        .where(eq(collectionCheckpoints.partitionId, partitionId));
      assert.deepEqual(
        paused.map((c) => c.pageSequence),
        [0],
      );
      worker = await startWorker();
    });

    await runStep(
      '5. Incremental Partition: Priority Processing and Starvation Freedom',
      async () => {
        const planRes = await fetch(`http://127.0.0.1:${env.apiPort}/api/v1/ops/partitions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.opsApiKey}`,
            'Idempotency-Key': `plan-inc-${randomUUID()}`,
          },
          body: JSON.stringify({
            targetRevisionId,
            mode: 'incremental',
            scopeKey: 'smoke-incremental',
            from: '2026-09-08T00:00:00Z',
            to: '2026-09-08T12:00:00Z',
            timeBasis: 'published_at',
            workflowVersion: '1',
            dryRun: false,
          }),
        });
        assert.equal(planRes.status, 200);
        const incPartition = (await planRes.json()) as { id: string };
        const incPartitionId = incPartition.id;
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 150));
          const [part] = await db
            .select()
            .from(collectionPartitions)
            .where(eq(collectionPartitions.id, incPartitionId));
          if (part?.state === 'completed') {
            incCompleted = true;
            break;
          }
        }
        assert.equal(incCompleted, true, 'Incremental partition did not complete');
        assert.equal(incrementalCalls >= 1, true, 'Incremental collector was not called');
        const paused = await db
          .select()
          .from(collectionCheckpoints)
          .where(eq(collectionCheckpoints.partitionId, backfillPartitionId));
        assert.deepEqual(
          paused.map((c) => c.pageSequence),
          [0],
          'Backfill must remain paused while incremental completes',
        );
        resumeBackfill = true;
        let resumed = false;
        for (let i = 0; i < 100; i++) {
          const checkpoints = await db
            .select()
            .from(collectionCheckpoints)
            .where(eq(collectionCheckpoints.partitionId, backfillPartitionId));
          if (checkpoints.some((c) => c.pageSequence === 1)) {
            resumed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        assert.ok(resumed, 'Durable continuation failed after restart');
      },
    );

    await runStep('6. Lexical & Vector Readiness Verification', async () => {
      // Normalization + Embedding should have run via outbox deliveries
      let readyCount = 0;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 150));
        const revs = await db.select().from(documentRevisions);
        const lexicalReady = revs.filter((r) => r.lexicalReadyAt !== null);
        const emb = await db.select().from(embeddings);
        if (lexicalReady.length >= 2 && emb.length >= 2) {
          readyCount = lexicalReady.length;
          break;
        }
      }
      const normOutbox = await db
        .select()
        .from(deliveryOutbox)
        .where(eq(deliveryOutbox.kind, 'normalization'));
      const embOutbox = await db
        .select()
        .from(deliveryOutbox)
        .where(eq(deliveryOutbox.kind, 'embedding'));
      assert.ok(readyCount >= 2, 'Lexical readiness missing');
      assert.ok(
        normOutbox.every((d) => d.completedAt),
        'Normalization delivery unfinished',
      );
      assert.ok(
        embOutbox.length >= 2 && embOutbox.every((d) => d.completedAt),
        'Embedding delivery unfinished',
      );
      const chunkList = await db.select().from(chunks);
      assert.equal(chunkList.length >= 2, true, 'Chunks were not created');

      const embList = await db.select().from(embeddings);
      assert.equal(embList.length >= 2, true, 'Vector embeddings were not persisted');
      assert.equal(embList[0]?.profileHash, fakeProfileHash);
    });

    await runStep('7. API Coverage Endpoint & Question-Answer with Grounded Citation', async () => {
      const coverageRes = await fetch(
        `http://127.0.0.1:${env.apiPort}/api/v1/coverage?from=2026-06-01T00:00:00Z&to=2026-09-09T00:00:00Z`,
      );
      assert.equal(coverageRes.status, 200);
      const coverage = await coverageRes.json();
      assert.equal(coverage.partitionsChecked >= 1, true);

      // Natural language query over the ready corpus
      const answerRes = await fetch(`http://127.0.0.1:${env.apiPort}/api/v1/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'What are the recent updates to TypeScript compiler architecture?',
          language: 'en',
          timeRange: { from: '2026-06-01T00:00:00Z', to: '2026-09-09T00:00:00Z' },
        }),
      });

      const answerText = await answerRes.text();
      assert.equal(answerRes.status, 200, `Answer failed: ${answerText}`);
      const answer = JSON.parse(answerText);
      assert.equal(answer.status, 'answered');
      assert(answer.answer.includes('smoke testing citing [C1]'));
      assert.equal(answer.citations.length >= 1, true, 'Citation was not provided');
      assert.equal(answer.citations[0].url.startsWith('https://example.com/fixture/'), true);
      assert.equal(answer.citations[0].license?.id, 'mit');
    });

    await runStep('8. Worker Restart and V2 Outbox Delivery Reconciliation', async () => {
      const callsBeforeRestart = embeddingCalls;
      // Restart the runtime with an unsent durable delivery
      await worker?.stop();
      worker = null;

      // Seed an un-sent delivery directly in PostgreSQL outbox
      const [rev] = await db.select().from(documentRevisions).limit(1);
      assert(rev);
      const testDeliveryKey = `replay-test-${randomUUID()}`;
      const [unprocessed] = await db
        .insert(deliveryOutbox)
        .values({
          naturalKey: testDeliveryKey,
          kind: 'embedding',
          partitionId: (await db.select().from(collectionPartitions).limit(1))[0]!.id,
          pageSequence: 0,
          revisionId: rev.id,
          notBefore: new Date(),
        })
        .returning();
      assert(unprocessed);

      // Restart worker
      worker = await startWorker();
      // Confirm outbox recovery reconciled and completed the delivery in PostgreSQL
      let deliveryCompleted = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 150));
        const [d] = await db
          .select()
          .from(deliveryOutbox)
          .where(eq(deliveryOutbox.id, unprocessed.id));
        if (d && d.completedAt !== null) {
          deliveryCompleted = true;
          break;
        }
      }
      assert.equal(
        deliveryCompleted,
        true,
        'Restarted worker failed to reconcile pending outbox delivery',
      );
      assert.equal(
        embeddingCalls,
        callsBeforeRestart,
        'Completed embedding must be reused without a provider call',
      );
    });

    if (process.env['SMOKE_UI'] === '1') {
      await runStep('Browser UI: persisted citation and coverage', async () => {
        const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
        const child = spawn(
          process.execPath,
          [webRequire.resolve('@playwright/test/cli'), 'test', 'runtime-cov008.spec.ts'],
          {
            cwd: fileURLToPath(new URL('../apps/web', import.meta.url)),
            env: {
              ...process.env,
              PUBLIC_API_BASE_URL: `http://127.0.0.1:${env.apiPort}`,
              COV008_RUNTIME_API_URL: `http://127.0.0.1:${env.apiPort}`,
            },
            stdio: 'inherit',
            windowsHide: true,
          },
        );
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`Runtime UI exited ${code}`)),
          );
        });
      });
    }
    process.stdout.write('\n=========================================\n');
    process.stdout.write('COV-008 END-TO-END RUNTIME PROOF COMPLETE\n');
    process.stdout.write(
      'Eight runtime scenarios verified against local PG+Redis with injected fixtures.\n',
    );
    process.stdout.write('=========================================\n');
  } finally {
    if (worker) {
      await worker.stop();
    }
    if (apiServer) await apiServer.stop();
    await redis.quit();
    await dbClient.close();
  }
}

main().catch((err) => {
  process.stderr.write(
    `\nSmoke Runner FAILED: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
