import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createApp } from '../src/app.js';
import { runOpsCli } from '../src/cli.js';
import { parseErrorEnvelope } from '@techpulse/contracts';
import {
  type SourceRecord,
  type SourceRepositoryPort,
  type CollectionRunRecord,
  type CollectionRunRepositoryPort,
  type TombstoneServicePort,
  type CreateTombstoneInput,
  type TombstoneResult,
  type ReindexResult,
  type ReplayTargetPort,
  type ReplayPublisherPort,
  createReplayService,
} from '@techpulse/domain';
import { type OpsAuditEvent } from '../src/routes/ops.js';

function createFakeSourceRepository(initialSources: SourceRecord[]): SourceRepositoryPort {
  const store = new Map<string, SourceRecord>(initialSources.map((s) => [s.key, { ...s }]));
  return {
    async findByKey(key: string) {
      return store.get(key) ?? null;
    },
    async listEnabled() {
      return Array.from(store.values()).filter((s) => s.enabled);
    },
    async updateEnabled(key: string, enabled: boolean) {
      const src = store.get(key);
      if (!src) return null;
      const updated = { ...src, enabled, updatedAt: new Date() };
      store.set(key, updated);
      return updated;
    },
    async listAll() {
      return Array.from(store.values());
    },
  };
}

function createFakeCollectionRunRepository(): CollectionRunRepositoryPort & {
  runs: Map<string, CollectionRunRecord>;
} {
  const runs = new Map<string, CollectionRunRecord>();
  return {
    runs,
    async findById(id: string) {
      return runs.get(id) ?? null;
    },
    async create(input) {
      const id = input.id || `run_${runs.size + 1}`;
      const record: CollectionRunRecord = {
        id,
        sourceId: input.sourceId,
        scheduledAt: input.scheduledAt,
        startedAt: input.startedAt ?? null,
        endedAt: null,
        status: input.status ?? 'pending',
        cursorBefore: input.cursorBefore ?? null,
        cursorAfter: null,
        counts: input.counts ?? {},
        errorSummary: null,
        createdAt: new Date(),
      };
      runs.set(id, record);
      return record;
    },
    async update(id, input) {
      const existing = runs.get(id);
      if (!existing) throw new Error(`Collection run not found: ${id}`);
      const updated: CollectionRunRecord = {
        ...existing,
        status: input.status ?? existing.status,
        startedAt: input.startedAt !== undefined ? input.startedAt : existing.startedAt,
        endedAt: input.endedAt !== undefined ? input.endedAt : existing.endedAt,
        cursorBefore: input.cursorBefore !== undefined ? input.cursorBefore : existing.cursorBefore,
        cursorAfter: input.cursorAfter !== undefined ? input.cursorAfter : existing.cursorAfter,
        counts: input.counts ?? existing.counts,
        errorSummary: input.errorSummary !== undefined ? input.errorSummary : existing.errorSummary,
      };
      runs.set(id, updated);
      return updated;
    },
    async list(filter) {
      let list = Array.from(runs.values());
      if (filter?.sourceId) list = list.filter((r) => r.sourceId === filter.sourceId);
      if (filter?.status) list = list.filter((r) => r.status === filter.status);
      if (filter?.from)
        list = list.filter((r) => r.scheduledAt.getTime() >= filter.from!.getTime());
      if (filter?.to) list = list.filter((r) => r.scheduledAt.getTime() <= filter.to!.getTime());
      const limit = filter?.limit ?? 20;
      return list.slice(0, limit);
    },
  };
}

function createFakeTombstoneService(): TombstoneServicePort & {
  tombstones: CreateTombstoneInput[];
  reindexed: string[];
} {
  const tombstones: CreateTombstoneInput[] = [];
  const reindexed: string[] = [];
  return {
    tombstones,
    reindexed,
    async createTombstone(input: CreateTombstoneInput): Promise<TombstoneResult> {
      tombstones.push(input);
      return {
        record: {
          id: `tomb_${Date.now()}`,
          scope: input.scope,
          targetKey: input.targetKey,
          reason: input.reason,
          requestedBy: input.requestedBy,
          effectiveAt: new Date(),
          purgeAfter: null,
          createdAt: new Date(),
        },
        affectedRevisionCount: 3,
      };
    },
    async reindex(scope: string, targetKey: string, requestedBy: string): Promise<ReindexResult> {
      reindexed.push(targetKey);
      return {
        scope: scope as 'source',
        targetKey,
        restoredRevisionCount: 3,
        requestedBy,
        reindexedAt: new Date(),
      };
    },
  };
}

describe('API-004 Protected Operations Interface and Authentication Controls', () => {
  const sampleSources: SourceRecord[] = [
    {
      id: 'src-arxiv',
      key: 'arxiv',
      name: 'arXiv CS',
      kind: 'api',
      baseUrl: 'http://export.arxiv.org',
      enabled: true,
      scheduleConfig: { intervalMinutes: 1440 },
      policyReviewedAt: new Date('2026-08-01T00:00:00.000Z'),
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    },
    {
      id: 'src-github',
      key: 'github_releases',
      name: 'GitHub Releases',
      kind: 'api',
      baseUrl: 'https://api.github.com',
      enabled: false,
      scheduleConfig: { intervalMinutes: 60 },
      policyReviewedAt: new Date('2026-08-01T00:00:00.000Z'),
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    },
  ];

  test('strong auth: missing authorization header returns 401 UNAUTHENTICATED', async () => {
    const app = createApp({ opsApiKey: 'valid-secret-ops-key' });
    const res = await app.handle(new Request('http://localhost/api/v1/ops/status'));
    assert.equal(res.status, 401);
    const env = parseErrorEnvelope(await res.json());
    assert.equal(env.error.code, 'UNAUTHENTICATED');
    assert.match(env.error.message, /Authentication required/iu);
  });

  test('strong auth: missing server API key configuration returns 403 FORBIDDEN', async () => {
    const app = createApp({ opsApiKey: undefined });
    const res = await app.handle(
      new Request('http://localhost/api/v1/ops/status', {
        headers: { authorization: 'Bearer any-token' },
      }),
    );
    assert.equal(res.status, 403);
    const env = parseErrorEnvelope(await res.json());
    assert.equal(env.error.code, 'FORBIDDEN');
  });

  test('strong auth: invalid token returns 403 FORBIDDEN and accepts both Bearer and raw token formats', async () => {
    const app = createApp({ opsApiKey: 'valid-secret-ops-key' });

    // 1. Invalid token
    const resBad = await app.handle(
      new Request('http://localhost/api/v1/ops/status', {
        headers: { authorization: 'Bearer wrong-key' },
      }),
    );
    assert.equal(resBad.status, 403);
    const envBad = parseErrorEnvelope(await resBad.json());
    assert.equal(envBad.error.code, 'FORBIDDEN');

    // 2. Valid Bearer token
    const resBearer = await app.handle(
      new Request('http://localhost/api/v1/ops/status', {
        headers: { authorization: 'Bearer valid-secret-ops-key' },
      }),
    );
    assert.equal(resBearer.status, 200);
    const bodyBearer = (await resBearer.json()) as Record<string, unknown>;
    assert.equal(bodyBearer['status'], 'ok');

    // 3. Valid raw token
    const resRaw = await app.handle(
      new Request('http://localhost/api/v1/ops/status', {
        headers: { authorization: 'valid-secret-ops-key' },
      }),
    );
    assert.equal(resRaw.status, 200);
  });

  test('public route isolation: public endpoints do not allow ops mutations or leak secrets', async () => {
    const sourceRepo = createFakeSourceRepository(sampleSources);
    const app = createApp({ sourceRepository: sourceRepo, opsApiKey: 'valid-secret-ops-key' });

    // Public GET sources works without ops token
    const publicRes = await app.handle(new Request('http://localhost/api/v1/sources'));
    assert.equal(publicRes.status, 200);

    // Public route does not have ops mutations (returns 404 or method not allowed)
    const publicFakePost = await app.handle(
      new Request('http://localhost/api/v1/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'leak' }),
      }),
    );
    assert.equal(publicFakePost.status, 404);
  });

  test('bounded collect: enforces required Idempotency-Key and bounds checks', async () => {
    const sourceRepo = createFakeSourceRepository(sampleSources);
    const runRepo = createFakeCollectionRunRepository();
    const auditLogs: OpsAuditEvent[] = [];
    const app = createApp({
      sourceRepository: sourceRepo,
      collectionRunRepository: runRepo,
      opsApiKey: 'valid-secret-ops-key',
      auditSink: (ev) => {
        auditLogs.push(ev);
      },
    });

    // 1. Missing Idempotency-Key header -> 400 INVALID_REQUEST
    const resNoKey = await app.handle(
      new Request('http://localhost/api/v1/ops/collection-runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sourceKey: 'arxiv' }),
      }),
    );
    assert.equal(resNoKey.status, 400);
    const envNoKey = parseErrorEnvelope(await resNoKey.json());
    assert.equal(envNoKey.error.code, 'INVALID_REQUEST');

    // 2. Out-of-bounds limit (> 500) -> 400 INVALID_REQUEST
    const resLimit = await app.handle(
      new Request('http://localhost/api/v1/ops/collection-runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': 'idem-limit-test',
        },
        body: JSON.stringify({ sourceKey: 'arxiv', limit: 999 }),
      }),
    );
    assert.equal(resLimit.status, 400);

    // 3. Disabled source collection refusal -> 400 INVALID_REQUEST
    const resDisabled = await app.handle(
      new Request('http://localhost/api/v1/ops/collection-runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': 'idem-disabled-test',
        },
        body: JSON.stringify({ sourceKey: 'github_releases' }),
      }),
    );
    assert.equal(resDisabled.status, 400);
    const envDisabled = parseErrorEnvelope(await resDisabled.json());
    assert.match(envDisabled.error.message, /disabled and cannot be collected/iu);

    // 4. Valid collection trigger -> 200 accepted
    const resOk = await app.handle(
      new Request('http://localhost/api/v1/ops/collection-runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': 'idem-ok-collect-1',
          'x-actor': 'dan_operator',
        },
        body: JSON.stringify({ sourceKey: 'arxiv', limit: 50 }),
      }),
    );
    assert.equal(resOk.status, 200);
    const bodyOk = (await resOk.json()) as Record<string, unknown>;
    assert.equal(bodyOk['status'], 'accepted');
    assert.equal(bodyOk['sourceKey'], 'arxiv');
    assert.ok(bodyOk['runId']);

    // Check audit event
    assert.equal(auditLogs.length, 1);
    const audit = auditLogs[0]!;
    assert.equal(audit.event, 'ops.collection_run.triggered');
    assert.equal(audit.actor, 'dan_operator');
    assert.equal(audit.target, 'arxiv');
    assert.equal(audit.data['sourceKey'], 'arxiv');
    assert.equal(audit.data['limit'], 50);
  });

  test('bounded replay: enforces replay service integration, bounds, and audit trail', async () => {
    const replayTargets: ReplayTargetPort = {
      async exists(scope, targetId) {
        return targetId !== 'non_existent_id';
      },
      async isEnabled(scope, targetId) {
        return targetId !== 'disabled_target_id';
      },
    };
    const publishedJobs: unknown[] = [];
    const replayPublisher: ReplayPublisherPort = {
      async publish(job) {
        publishedJobs.push(job);
        return { duplicate: false };
      },
    };
    const replayService = createReplayService({
      targets: replayTargets,
      publisher: replayPublisher,
    });

    const auditLogs: OpsAuditEvent[] = [];
    const app = createApp({
      replayService,
      opsApiKey: 'valid-secret-ops-key',
      auditSink: (ev) => {
        auditLogs.push(ev);
      },
    });

    // 1. Missing stage when scope=stage -> 400 INVALID_REQUEST
    const resNoStage = await app.handle(
      new Request('http://localhost/api/v1/ops/pipeline-replays', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': 'idem-replay-nostage',
        },
        body: JSON.stringify({ scope: 'stage', targetId: 'run-123' }),
      }),
    );
    assert.equal(resNoStage.status, 400);

    // 2. Non-existent replay target -> 404 NOT_FOUND
    const resNotFound = await app.handle(
      new Request('http://localhost/api/v1/ops/pipeline-replays', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': 'idem-replay-404',
        },
        body: JSON.stringify({ scope: 'run', targetId: 'non_existent_id' }),
      }),
    );
    assert.equal(resNotFound.status, 404);

    // 3. Disabled target -> skipped_disabled
    const resDisabled = await app.handle(
      new Request('http://localhost/api/v1/ops/pipeline-replays', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': 'idem-replay-disabled',
        },
        body: JSON.stringify({ scope: 'run', targetId: 'disabled_target_id' }),
      }),
    );
    assert.equal(resDisabled.status, 200);
    const bodyDisabled = (await resDisabled.json()) as Record<string, unknown>;
    assert.equal(bodyDisabled['status'], 'skipped_disabled');

    // 4. Valid stage replay -> queued with deterministic replayId
    const resOk = await app.handle(
      new Request('http://localhost/api/v1/ops/pipeline-replays', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': 'idem-replay-ok-1',
          'x-actor': 'replay_admin',
        },
        body: JSON.stringify({
          scope: 'stage',
          targetId: 'raw-item-99',
          stage: 'normalization',
        }),
      }),
    );
    assert.equal(resOk.status, 200);
    const bodyOk = (await resOk.json()) as Record<string, unknown>;
    assert.equal(bodyOk['status'], 'queued');
    assert.equal(bodyOk['replayId'], 'replay:v1:stage:raw-item-99:normalization');
    assert.equal(bodyOk['jobsCount'], 1);

    // Check audit logs
    const replayAudits = auditLogs.filter((a) => a.event === 'ops.pipeline_replay.requested');
    assert.ok(replayAudits.length >= 1);
    const latestAudit = replayAudits[replayAudits.length - 1]!;
    assert.equal(latestAudit.actor, 'replay_admin');
    assert.equal(latestAudit.data['stage'], 'normalization');
  });

  test('source enable and disable operations with tombstone and reindex', async () => {
    const sourceRepo = createFakeSourceRepository(sampleSources);
    const tombstoneService = createFakeTombstoneService();
    const auditLogs: OpsAuditEvent[] = [];

    const app = createApp({
      sourceRepository: sourceRepo,
      tombstoneService,
      opsApiKey: 'valid-secret-ops-key',
      auditSink: (ev) => {
        auditLogs.push(ev);
      },
    });

    // 1. Disable source -> disables source and triggers tombstone
    const resDisable = await app.handle(
      new Request('http://localhost/api/v1/ops/sources/arxiv/disable', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': 'idem-disable-arxiv',
          'x-actor': 'compliance_officer',
        },
        body: JSON.stringify({
          reason: 'Upstream license change',
          requestedBy: 'compliance_officer',
        }),
      }),
    );
    assert.equal(resDisable.status, 200);
    const bodyDisable = (await resDisable.json()) as Record<string, unknown>;
    assert.equal(bodyDisable['enabled'], false);

    const updatedSource = await sourceRepo.findByKey('arxiv');
    assert.equal(updatedSource?.enabled, false);
    assert.equal(tombstoneService.tombstones.length, 1);
    assert.equal(tombstoneService.tombstones[0]?.targetKey, 'arxiv');

    // 2. Enable source -> re-enables source and triggers reindex
    const resEnable = await app.handle(
      new Request('http://localhost/api/v1/ops/sources/arxiv/enable', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': 'idem-enable-arxiv',
          'x-actor': 'compliance_officer',
        },
        body: JSON.stringify({ requestedBy: 'compliance_officer' }),
      }),
    );
    assert.equal(resEnable.status, 200);
    const bodyEnable = (await resEnable.json()) as Record<string, unknown>;
    assert.equal(bodyEnable['enabled'], true);

    const reenabledSource = await sourceRepo.findByKey('arxiv');
    assert.equal(reenabledSource?.enabled, true);
    assert.equal(tombstoneService.reindexed.length, 1);
    assert.equal(tombstoneService.reindexed[0], 'arxiv');

    // 3. Unknown source key -> 404 NOT_FOUND
    const resUnknown = await app.handle(
      new Request('http://localhost/api/v1/ops/sources/unknown_source/disable', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': 'idem-disable-unknown',
        },
      }),
    );
    assert.equal(resUnknown.status, 404);
  });

  test('idempotency enforcement: same key returns cached result, conflicting payload returns 409', async () => {
    const sourceRepo = createFakeSourceRepository(sampleSources);
    const runRepo = createFakeCollectionRunRepository();
    const app = createApp({
      sourceRepository: sourceRepo,
      collectionRunRepository: runRepo,
      opsApiKey: 'valid-secret-ops-key',
    });

    const idempotencyKey = 'unique-idem-key-100';

    // 1. Initial request -> 200
    const res1 = await app.handle(
      new Request('http://localhost/api/v1/ops/collection-runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ sourceKey: 'arxiv', limit: 20 }),
      }),
    );
    assert.equal(res1.status, 200);
    const body1 = (await res1.json()) as Record<string, unknown>;
    const originalRunId = body1['runId'];

    // 2. Duplicate request with identical payload -> returns identical response without creating new run
    const res2 = await app.handle(
      new Request('http://localhost/api/v1/ops/collection-runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ sourceKey: 'arxiv', limit: 20 }),
      }),
    );
    assert.equal(res2.status, 200);
    const body2 = (await res2.json()) as Record<string, unknown>;
    assert.equal(body2['runId'], originalRunId);
    assert.equal(runRepo.runs.size, 1, 'Only one run record should be created');

    // 3. Request with same idempotency key but conflicting payload -> 409 IDEMPOTENCY_CONFLICT
    const resConflict = await app.handle(
      new Request('http://localhost/api/v1/ops/collection-runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ sourceKey: 'arxiv', limit: 99 }),
      }),
    );
    assert.equal(resConflict.status, 409);
    const envConflict = parseErrorEnvelope(await resConflict.json());
    assert.equal(envConflict.error.code, 'IDEMPOTENCY_CONFLICT');
  });

  test('audit redaction: secret tokens and credentials are never exposed in audit payloads', async () => {
    const auditLogs: OpsAuditEvent[] = [];
    const sourceRepo = createFakeSourceRepository(sampleSources);
    const app = createApp({
      sourceRepository: sourceRepo,
      opsApiKey: 'valid-secret-ops-key',
      auditSink: (ev) => {
        auditLogs.push(ev);
      },
    });

    await app.handle(
      new Request('http://localhost/api/v1/ops/collection-runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-secret-ops-key',
          'content-type': 'application/json',
          'idempotency-key': 'idem-audit-redact-test',
        },
        body: JSON.stringify({
          sourceKey: 'arxiv',
          dryRun: true,
        }),
      }),
    );

    assert.equal(auditLogs.length, 1);
    const rawAuditString = JSON.stringify(auditLogs[0]);
    assert.doesNotMatch(rawAuditString, /valid-secret-ops-key/);
    assert.doesNotMatch(rawAuditString, /password/);
    assert.doesNotMatch(rawAuditString, /database_url/);
  });

  test('collection-runs query: listing and single item inspection', async () => {
    const runRepo = createFakeCollectionRunRepository();
    await runRepo.create({
      id: 'run-test-1',
      sourceId: 'src-arxiv',
      scheduledAt: new Date('2026-08-30T10:00:00.000Z'),
      status: 'succeeded',
      counts: { collected: 10, normalized: 10 },
    });
    await runRepo.create({
      id: 'run-test-2',
      sourceId: 'src-arxiv',
      scheduledAt: new Date('2026-08-31T10:00:00.000Z'),
      status: 'failed',
      counts: { collected: 5, failed: 1 },
    });

    const app = createApp({
      collectionRunRepository: runRepo,
      opsApiKey: 'valid-secret-ops-key',
    });

    // 1. List collection runs
    const listRes = await app.handle(
      new Request('http://localhost/api/v1/ops/collection-runs?limit=10', {
        headers: { authorization: 'Bearer valid-secret-ops-key' },
      }),
    );
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as { items: unknown[] };
    assert.equal(listBody.items.length, 2);

    // 2. Get single run detail
    const getRes = await app.handle(
      new Request('http://localhost/api/v1/ops/collection-runs/run-test-1', {
        headers: { authorization: 'Bearer valid-secret-ops-key' },
      }),
    );
    assert.equal(getRes.status, 200);
    const getBody = (await getRes.json()) as { run: { id: string; status: string } };
    assert.equal(getBody.run.id, 'run-test-1');
    assert.equal(getBody.run.status, 'succeeded');

    // 3. Non-existent run ID -> 404 NOT_FOUND
    const get404Res = await app.handle(
      new Request('http://localhost/api/v1/ops/collection-runs/non_existent_run', {
        headers: { authorization: 'Bearer valid-secret-ops-key' },
      }),
    );
    assert.equal(get404Res.status, 404);
  });

  test('Ops CLI runner: executes status, collect, replay, and source enable/disable', async () => {
    const sourceRepo = createFakeSourceRepository(sampleSources);
    const runRepo = createFakeCollectionRunRepository();
    const tombstoneService = createFakeTombstoneService();

    const app = createApp({
      sourceRepository: sourceRepo,
      collectionRunRepository: runRepo,
      tombstoneService,
      opsApiKey: 'cli-secret-key-99',
    });

    const appHandler = (req: Request) => app.handle(req);

    // 1. Help flag
    const helpRes = await runOpsCli(['--help']);
    assert.equal(helpRes.exitCode, 0);
    assert.match(String(helpRes.output), /TechPulse Operations CLI/iu);

    // 2. Missing API key
    const noKeyRes = await runOpsCli(['status'], { appHandler });
    assert.equal(noKeyRes.exitCode, 1);
    assert.match(noKeyRes.error ?? '', /API key is required/iu);

    // 3. Status command
    const statusRes = await runOpsCli(['status', '--api-key', 'cli-secret-key-99'], { appHandler });
    assert.equal(statusRes.exitCode, 0);
    assert.equal((statusRes.output as Record<string, unknown>)['status'], 'ok');

    // 4. Collect command
    const collectRes = await runOpsCli(
      ['collect', '--source', 'arxiv', '--limit', '25', '--api-key', 'cli-secret-key-99'],
      { appHandler },
    );
    assert.equal(collectRes.exitCode, 0);
    assert.equal((collectRes.output as Record<string, unknown>)['status'], 'accepted');

    // 5. Replay command
    const replayRes = await runOpsCli(
      ['replay', '--scope', 'run', '--target', 'run-500', '--api-key', 'cli-secret-key-99'],
      { appHandler },
    );
    assert.equal(replayRes.exitCode, 0);
    assert.equal((replayRes.output as Record<string, unknown>)['status'], 'accepted');

    // 6. Source disable command
    const disableRes = await runOpsCli(
      ['source', 'disable', 'arxiv', '--reason', 'Test disable', '--api-key', 'cli-secret-key-99'],
      { appHandler },
    );
    assert.equal(disableRes.exitCode, 0);
    assert.equal((disableRes.output as Record<string, unknown>)['enabled'], false);

    // 7. Source enable command
    const enableRes = await runOpsCli(
      ['source', 'enable', 'arxiv', '--api-key', 'cli-secret-key-99'],
      { appHandler },
    );
    assert.equal(enableRes.exitCode, 0);
    assert.equal((enableRes.output as Record<string, unknown>)['enabled'], true);
  });
});
