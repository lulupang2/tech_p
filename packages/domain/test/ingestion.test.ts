import { describe, expect, test } from 'vitest';
import {
  PolicyViolationError,
  SourceNotFoundError,
  TransientIngestionError,
  createRawIngestionService,
  type CollectedRawItem,
  type CollectionResult,
  type CollectionRunRepositoryPort,
  type CollectorPort,
  type CreateCollectionRunInput,
  type CreatePipelineEventInput,
  type PipelineEventRecord,
  type PipelineEventRepositoryPort,
  type RawItemRecord,
  type RawItemRepositoryPort,
  type SourcePolicy,
  type SourceRecord,
  type SourceRepositoryPort,
  type StageJobPayload,
  type StageJobPublisherPort,
  type UpdateCollectionRunInput,
  type UpsertRawItemInput,
  type UpsertRawItemResult,
} from '../src/index.js';

// --- Deterministic Fake Repositories & Fixtures ---

const dummyPolicy: SourcePolicy = {
  sourceKey: 'github_releases',
  allowedHosts: ['api.github.com'],
  allowedSchemes: ['https'],
  maxSizeBytes: 10 * 1024 * 1024,
  maxRedirects: 3,
  verbatimOnly: false,
  defaultLicenseId: 'MIT',
  piiFieldsToStrip: [],
};

function createFakeSourceRepository(initialSources: SourceRecord[] = []): SourceRepositoryPort {
  const sourcesMap = new Map<string, SourceRecord>(initialSources.map((s) => [s.key, s]));

  return {
    async findByKey(key: string): Promise<SourceRecord | null> {
      return sourcesMap.get(key) ?? null;
    },
    async listEnabled(): Promise<readonly SourceRecord[]> {
      return Array.from(sourcesMap.values()).filter((s) => s.enabled);
    },
  };
}

function createFakeCollectionRunRepository(): CollectionRunRepositoryPort & {
  runs: Map<string, CollectionRunRecord>;
} {
  const runs = new Map<string, CollectionRunRecord>();

  return {
    runs,
    async findById(id: string): Promise<CollectionRunRecord | null> {
      return runs.get(id) ?? null;
    },
    async create(input: CreateCollectionRunInput): Promise<CollectionRunRecord> {
      const id = input.id ?? `run-${runs.size + 1}`;
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
    async update(id: string, input: UpdateCollectionRunInput): Promise<CollectionRunRecord> {
      const existing = runs.get(id);
      if (!existing) throw new Error(`Collection run '${id}' not found`);

      const updated: CollectionRunRecord = {
        ...existing,
        status: input.status ?? existing.status,
        startedAt: input.startedAt !== undefined ? input.startedAt : existing.startedAt,
        endedAt: input.endedAt !== undefined ? input.endedAt : existing.endedAt,
        cursorBefore: input.cursorBefore !== undefined ? input.cursorBefore : existing.cursorBefore,
        cursorAfter: input.cursorAfter !== undefined ? input.cursorAfter : existing.cursorAfter,
        counts: input.counts !== undefined ? input.counts : existing.counts,
        errorSummary: input.errorSummary !== undefined ? input.errorSummary : existing.errorSummary,
      };
      runs.set(id, updated);
      return updated;
    },
    async findBySourceAndScheduledAt(
      sourceId: string,
      scheduledAt: Date,
    ): Promise<CollectionRunRecord | null> {
      for (const run of runs.values()) {
        if (run.sourceId === sourceId && run.scheduledAt.getTime() === scheduledAt.getTime()) {
          return run;
        }
      }
      return null;
    },
  };
}

function createFakeRawItemRepository(): RawItemRepositoryPort & {
  items: Map<string, RawItemRecord>;
  upsertFailOnNext?: Error;
} {
  const items = new Map<string, RawItemRecord>();
  let idCounter = 1;

  const repo: RawItemRepositoryPort & {
    items: Map<string, RawItemRecord>;
    upsertFailOnNext?: Error;
  } = {
    items,
    async findById(id: string): Promise<RawItemRecord | null> {
      return items.get(id) ?? null;
    },
    async upsert(input: UpsertRawItemInput): Promise<UpsertRawItemResult> {
      if (repo.upsertFailOnNext) {
        const error = repo.upsertFailOnNext;
        repo.upsertFailOnNext = undefined;
        throw error;
      }

      const naturalKey = `${input.sourceId}|${input.externalId}|${input.payloadHash}`;
      for (const existing of items.values()) {
        const existingKey = `${existing.sourceId}|${existing.externalId}|${existing.payloadHash}`;
        if (existingKey === naturalKey) {
          return { item: existing, isNew: false };
        }
      }

      const id = input.id ?? `raw-${idCounter++}`;
      const record: RawItemRecord = {
        id,
        sourceId: input.sourceId,
        runId: input.runId,
        externalId: input.externalId,
        canonicalUrl: input.canonicalUrl,
        payload: input.payload,
        payloadHash: input.payloadHash,
        publishedAt: input.publishedAt ?? null,
        collectedAt: input.collectedAt ?? new Date(),
        httpMetadata: input.httpMetadata ?? {},
        rightsMetadata: input.rightsMetadata ?? {},
      };
      items.set(id, record);
      return { item: record, isNew: true };
    },
    async findByRevision(
      sourceId: string,
      externalId: string,
      payloadHash: string,
    ): Promise<RawItemRecord | null> {
      const naturalKey = `${sourceId}|${externalId}|${payloadHash}`;
      for (const existing of items.values()) {
        const existingKey = `${existing.sourceId}|${existing.externalId}|${existing.payloadHash}`;
        if (existingKey === naturalKey) {
          return existing;
        }
      }
      return null;
    },
    async listByRunId(runId: string): Promise<readonly RawItemRecord[]> {
      return Array.from(items.values()).filter((i) => i.runId === runId);
    },
  };

  return repo;
}

function createFakePipelineEventRepository(): PipelineEventRepositoryPort & {
  events: PipelineEventRecord[];
} {
  const events: PipelineEventRecord[] = [];
  let idCounter = 1;

  return {
    events,
    async create(input: CreatePipelineEventInput): Promise<PipelineEventRecord> {
      const record: PipelineEventRecord = {
        id: `event-${idCounter++}`,
        rawItemId: input.rawItemId,
        stage: input.stage,
        processorVersion: input.processorVersion,
        status: input.status,
        attempt: input.attempt ?? 1,
        errorCode: input.errorCode ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      };
      events.push(record);
      return record;
    },
    async listByRawItemId(rawItemId: string): Promise<readonly PipelineEventRecord[]> {
      return events.filter((e) => e.rawItemId === rawItemId);
    },
  };
}

function createFakeStageJobPublisher(): StageJobPublisherPort & {
  published: StageJobPayload[];
} {
  const published: StageJobPayload[] = [];
  return {
    published,
    async publishStageJob(payload: StageJobPayload): Promise<void> {
      published.push(payload);
    },
  };
}

function createSampleSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'src-001',
    key: 'github_releases',
    name: 'GitHub Releases',
    kind: 'api',
    baseUrl: 'https://api.github.com',
    enabled: true,
    scheduleConfig: { intervalHours: 1 },
    policyReviewedAt: new Date('2026-09-01T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function createSampleRawItem(
  externalId: string,
  payload: Record<string, unknown>,
): CollectedRawItem {
  const payloadStr = JSON.stringify(payload);
  let hash = 0;
  for (let i = 0; i < payloadStr.length; i++) {
    hash = (hash << 5) - hash + payloadStr.charCodeAt(i);
    hash |= 0;
  }
  const rawHash = Math.abs(hash).toString(16).padStart(64, '0');

  return {
    externalId,
    payload,
    rawHash,
    publishedAt: new Date('2026-09-01T12:00:00Z'),
    cursor: `cursor-${externalId}`,
    metadata: {
      canonicalUrl: `https://github.com/org/repo/releases/tag/${externalId}`,
      httpMetadata: { status: 200, etag: 'W/"sample-etag"' },
      rightsMetadata: { license: 'MIT' },
    },
  };
}

// --- Test Suite ---

describe('PIPE-001 Raw Ingestion Orchestration Service', () => {
  test('publishes downstream stage jobs ONLY after raw persistence succeeds', async () => {
    const source = createSampleSource();
    const sourceRepo = createFakeSourceRepository([source]);
    const runRepo = createFakeCollectionRunRepository();
    const rawRepo = createFakeRawItemRepository();
    const eventRepo = createFakePipelineEventRepository();
    const publisher = createFakeStageJobPublisher();

    const sampleItems = [
      createSampleRawItem('v1.0.0', { tag: 'v1.0.0', body: 'First release' }),
      createSampleRawItem('v1.1.0', { tag: 'v1.1.0', body: 'Second release' }),
    ];

    const fakeCollector: CollectorPort = {
      sourceKey: 'github_releases',
      policy: dummyPolicy,
      async collect(): Promise<CollectionResult> {
        return {
          sourceKey: 'github_releases',
          items: sampleItems,
          nextCursor: 'cursor-v1.1.0',
          hasMore: false,
          metrics: { itemsFetched: 2, bytesFetched: 1024, durationMs: 50 },
        };
      },
    };

    const service = createRawIngestionService({
      sourceRepository: sourceRepo,
      collectionRunRepository: runRepo,
      rawItemRepository: rawRepo,
      pipelineEventRepository: eventRepo,
      collectorResolver: (key) => (key === 'github_releases' ? fakeCollector : undefined),
      stageJobPublisher: publisher,
    });

    const result = await service.executeIngestion({
      collectionRunId: 'run-001',
      sourceKey: 'github_releases',
      cursor: null,
    });

    expect(result.status).toBe('succeeded');
    expect(result.counts.itemsFetched).toBe(2);
    expect(result.counts.itemsPersisted).toBe(2);
    expect(result.counts.stageJobsPublished).toBe(2);
    expect(result.nextCursor).toBe('cursor-v1.1.0');

    // Verify raw items were persisted in the repo
    expect(rawRepo.items.size).toBe(2);
    const persistedList = Array.from(rawRepo.items.values());
    expect(persistedList[0]?.externalId).toBe('v1.0.0');
    expect(persistedList[1]?.externalId).toBe('v1.1.0');

    // Verify stage jobs were published with exact identifiers
    expect(publisher.published).toHaveLength(2);
    expect(publisher.published[0]).toEqual({
      stage: 'normalization',
      rawItemId: persistedList[0]!.id,
      sourceKey: 'github_releases',
      runId: 'run-001',
      externalId: 'v1.0.0',
      payloadHash: sampleItems[0]!.rawHash,
    });
    expect(publisher.published[1]).toEqual({
      stage: 'normalization',
      rawItemId: persistedList[1]!.id,
      sourceKey: 'github_releases',
      runId: 'run-001',
      externalId: 'v1.1.0',
      payloadHash: sampleItems[1]!.rawHash,
    });

    // Verify pipeline events
    expect(eventRepo.events).toHaveLength(2);
    expect(eventRepo.events[0]?.status).toBe('succeeded');
    expect(eventRepo.events[0]?.stage).toBe('raw_saved');
  });

  test('does NOT publish downstream stage jobs if raw persistence fails', async () => {
    const source = createSampleSource();
    const sourceRepo = createFakeSourceRepository([source]);
    const runRepo = createFakeCollectionRunRepository();
    const rawRepo = createFakeRawItemRepository();
    const eventRepo = createFakePipelineEventRepository();
    const publisher = createFakeStageJobPublisher();

    // Inject failure on raw item persistence
    rawRepo.upsertFailOnNext = new Error('Database connection reset during upsert');

    const fakeCollector: CollectorPort = {
      sourceKey: 'github_releases',
      policy: dummyPolicy,
      async collect(): Promise<CollectionResult> {
        return {
          sourceKey: 'github_releases',
          items: [createSampleRawItem('v1.0.0', { tag: 'v1.0.0' })],
          nextCursor: null,
          hasMore: false,
        };
      },
    };

    const service = createRawIngestionService({
      sourceRepository: sourceRepo,
      collectionRunRepository: runRepo,
      rawItemRepository: rawRepo,
      pipelineEventRepository: eventRepo,
      collectorResolver: () => fakeCollector,
      stageJobPublisher: publisher,
    });

    await expect(
      service.executeIngestion({
        collectionRunId: 'run-fail-db',
        sourceKey: 'github_releases',
      }),
    ).rejects.toThrow(TransientIngestionError);

    // Invariant: Stage jobs MUST be 0 if persistence failed
    expect(publisher.published).toHaveLength(0);

    // Verify run record is marked failed
    const run = await runRepo.findById('run-fail-db');
    expect(run).not.toBeNull();
    expect(run?.status).toBe('failed');
    expect(run?.errorSummary).toContain('Database connection reset');
  });

  test('does NOT persist raw items or publish stage jobs when collector throws', async () => {
    const source = createSampleSource();
    const sourceRepo = createFakeSourceRepository([source]);
    const runRepo = createFakeCollectionRunRepository();
    const rawRepo = createFakeRawItemRepository();
    const publisher = createFakeStageJobPublisher();

    const fakeCollector: CollectorPort = {
      sourceKey: 'github_releases',
      policy: dummyPolicy,
      async collect(): Promise<CollectionResult> {
        throw new Error('HTTP 503 Service Unavailable');
      },
    };

    const service = createRawIngestionService({
      sourceRepository: sourceRepo,
      collectionRunRepository: runRepo,
      rawItemRepository: rawRepo,
      collectorResolver: () => fakeCollector,
      stageJobPublisher: publisher,
    });

    await expect(
      service.executeIngestion({
        collectionRunId: 'run-collector-fail',
        sourceKey: 'github_releases',
      }),
    ).rejects.toThrow(TransientIngestionError);

    expect(rawRepo.items.size).toBe(0);
    expect(publisher.published).toHaveLength(0);

    const run = await runRepo.findById('run-collector-fail');
    expect(run?.status).toBe('failed');
    expect(run?.errorSummary).toContain('HTTP 503');
  });

  test('ensures logical duplicate count is 0 on at-least-once job replay', async () => {
    const source = createSampleSource();
    const sourceRepo = createFakeSourceRepository([source]);
    const runRepo = createFakeCollectionRunRepository();
    const rawRepo = createFakeRawItemRepository();
    const publisher = createFakeStageJobPublisher();

    const sampleItems = [
      createSampleRawItem('v2.0.0', { tag: 'v2.0.0', changelog: 'Breaking change' }),
      createSampleRawItem('v2.0.1', { tag: 'v2.0.1', changelog: 'Patch fix' }),
    ];

    const fakeCollector: CollectorPort = {
      sourceKey: 'github_releases',
      policy: dummyPolicy,
      async collect(): Promise<CollectionResult> {
        return {
          sourceKey: 'github_releases',
          items: sampleItems,
          nextCursor: 'cursor-replay',
          hasMore: false,
          metrics: { itemsFetched: 2, bytesFetched: 500, durationMs: 30 },
        };
      },
    };

    const service = createRawIngestionService({
      sourceRepository: sourceRepo,
      collectionRunRepository: runRepo,
      rawItemRepository: rawRepo,
      collectorResolver: () => fakeCollector,
      stageJobPublisher: publisher,
    });

    // 1st Execution
    const firstResult = await service.executeIngestion({
      collectionRunId: 'run-job-1',
      sourceKey: 'github_releases',
    });

    expect(firstResult.status).toBe('succeeded');
    expect(firstResult.counts.itemsPersisted).toBe(2);
    expect(firstResult.counts.duplicatesSkipped).toBe(0);
    expect(firstResult.counts.stageJobsPublished).toBe(2);
    expect(rawRepo.items.size).toBe(2);
    expect(publisher.published).toHaveLength(2);

    // 2nd Execution: Job redelivered with different runId but same items (same natural key: sourceId + externalId + payloadHash)
    const secondResult = await service.executeIngestion({
      collectionRunId: 'run-job-2-replay',
      sourceKey: 'github_releases',
    });

    expect(secondResult.status).toBe('succeeded');
    expect(secondResult.counts.itemsFetched).toBe(2);
    expect(secondResult.counts.itemsPersisted).toBe(0); // 0 new items
    expect(secondResult.counts.duplicatesSkipped).toBe(2); // 2 duplicates skipped
    expect(secondResult.counts.stageJobsPublished).toBe(0); // 0 new stage jobs

    // Total raw items in storage remains strictly 2 (duplicate 0)
    expect(rawRepo.items.size).toBe(2);
    // Total stage jobs published across both executions remains 2
    expect(publisher.published).toHaveLength(2);
  });

  test('distinguishes controlled policy violations from transient errors', async () => {
    const source = createSampleSource();
    const sourceRepo = createFakeSourceRepository([source]);
    const runRepo = createFakeCollectionRunRepository();
    const rawRepo = createFakeRawItemRepository();

    // 1. Policy violation scenario (SSRF / Content Policy Violation)
    const policyViolatingCollector: CollectorPort = {
      sourceKey: 'github_releases',
      policy: dummyPolicy,
      async collect(): Promise<CollectionResult> {
        throw new PolicyViolationError('Content policy violation: SSRF target denied');
      },
    };

    const policyService = createRawIngestionService({
      sourceRepository: sourceRepo,
      collectionRunRepository: runRepo,
      rawItemRepository: rawRepo,
      collectorResolver: () => policyViolatingCollector,
    });

    await expect(
      policyService.executeIngestion({
        collectionRunId: 'run-policy-fail',
        sourceKey: 'github_releases',
      }),
    ).rejects.toThrow(PolicyViolationError);

    const policyRun = await runRepo.findById('run-policy-fail');
    expect(policyRun?.status).toBe('failed');
    expect(policyRun?.errorSummary).toContain('Policy violation');

    // 2. Transient error scenario (Network 429 Rate Limit)
    const transientCollector: CollectorPort = {
      sourceKey: 'github_releases',
      policy: dummyPolicy,
      async collect(): Promise<CollectionResult> {
        throw new Error('HTTP 429 Too Many Requests: Rate limit exceeded');
      },
    };

    const transientService = createRawIngestionService({
      sourceRepository: sourceRepo,
      collectionRunRepository: runRepo,
      rawItemRepository: rawRepo,
      collectorResolver: () => transientCollector,
    });

    await expect(
      transientService.executeIngestion({
        collectionRunId: 'run-transient-fail',
        sourceKey: 'github_releases',
      }),
    ).rejects.toThrow(TransientIngestionError);

    const transientRun = await runRepo.findById('run-transient-fail');
    expect(transientRun?.status).toBe('failed');
    expect(transientRun?.errorSummary).toContain('Transient collection error: HTTP 429');
  });

  test('handles disabled source gracefully by cancelling run and publishing 0 jobs', async () => {
    const disabledSource = createSampleSource({ enabled: false });
    const sourceRepo = createFakeSourceRepository([disabledSource]);
    const runRepo = createFakeCollectionRunRepository();
    const rawRepo = createFakeRawItemRepository();
    const publisher = createFakeStageJobPublisher();

    let collectorCalled = false;
    const fakeCollector: CollectorPort = {
      sourceKey: 'github_releases',
      policy: dummyPolicy,
      async collect(): Promise<CollectionResult> {
        collectorCalled = true;
        return { sourceKey: 'github_releases', items: [], nextCursor: null, hasMore: false };
      },
    };

    const service = createRawIngestionService({
      sourceRepository: sourceRepo,
      collectionRunRepository: runRepo,
      rawItemRepository: rawRepo,
      collectorResolver: () => fakeCollector,
      stageJobPublisher: publisher,
    });

    const result = await service.executeIngestion({
      collectionRunId: 'run-disabled-source',
      sourceKey: 'github_releases',
    });

    expect(result.status).toBe('cancelled');
    expect(result.errorSummary).toBe('Source is disabled');
    expect(result.isTransientError).toBe(false);
    expect(collectorCalled).toBe(false);
    expect(publisher.published).toHaveLength(0);

    const run = await runRepo.findById('run-disabled-source');
    expect(run?.status).toBe('cancelled');
  });

  test('throws SourceNotFoundError when unknown source key is passed', async () => {
    const sourceRepo = createFakeSourceRepository([]);
    const runRepo = createFakeCollectionRunRepository();
    const rawRepo = createFakeRawItemRepository();

    const service = createRawIngestionService({
      sourceRepository: sourceRepo,
      collectionRunRepository: runRepo,
      rawItemRepository: rawRepo,
      collectorResolver: () => undefined,
    });

    await expect(
      service.executeIngestion({
        collectionRunId: 'run-unknown-source',
        sourceKey: 'arxiv',
      }),
    ).rejects.toThrow(SourceNotFoundError);
  });

  test('observes complete lifecycle state transitions and structured counts', async () => {
    const source = createSampleSource();
    const sourceRepo = createFakeSourceRepository([source]);
    const runRepo = createFakeCollectionRunRepository();
    const rawRepo = createFakeRawItemRepository();

    const loggedEvents: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const logger = {
      info: (event: string, data?: Record<string, unknown>) => {
        loggedEvents.push({ event, data });
      },
      warn: (event: string, data?: Record<string, unknown>) => {
        loggedEvents.push({ event, data });
      },
      error: (event: string, data?: Record<string, unknown>) => {
        loggedEvents.push({ event, data });
      },
    };

    const fakeCollector: CollectorPort = {
      sourceKey: 'github_releases',
      policy: dummyPolicy,
      async collect(): Promise<CollectionResult> {
        return {
          sourceKey: 'github_releases',
          items: [createSampleRawItem('v3.0.0', { title: 'Major Release 3' })],
          nextCursor: 'next-page-cursor',
          hasMore: true,
          metrics: { itemsFetched: 1, bytesFetched: 2048, durationMs: 120 },
        };
      },
    };

    const service = createRawIngestionService({
      sourceRepository: sourceRepo,
      collectionRunRepository: runRepo,
      rawItemRepository: rawRepo,
      collectorResolver: () => fakeCollector,
      logger,
    });

    const result = await service.executeIngestion({
      collectionRunId: 'run-lifecycle-001',
      sourceKey: 'github_releases',
      cursor: 'prev-page-cursor',
    });

    expect(result.status).toBe('succeeded');
    expect(result.counts).toEqual({
      itemsFetched: 1,
      itemsPersisted: 1,
      duplicatesSkipped: 0,
      stageJobsPublished: 0,
      bytesFetched: 2048,
    });
    expect(result.nextCursor).toBe('next-page-cursor');

    const run = await runRepo.findById('run-lifecycle-001');
    expect(run?.status).toBe('succeeded');
    expect(run?.cursorBefore).toBe('prev-page-cursor');
    expect(run?.cursorAfter).toBe('next-page-cursor');
    expect(run?.startedAt).not.toBeNull();
    expect(run?.endedAt).not.toBeNull();
    expect(run?.counts).toEqual(result.counts);

    // Verify structured logging events
    expect(loggedEvents.some((e) => e.event === 'collection.run.started')).toBe(true);
    expect(loggedEvents.some((e) => e.event === 'collection.run.succeeded')).toBe(true);
  });
});
