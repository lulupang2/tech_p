import { describe, expect, it } from 'vitest';
import {
  ProviderBudgetError,
  createEmbeddingService,
  type ChunkRepositoryPort,
  type CollectionDelivery,
  type CollectionStatePort,
  type EmbeddingWorkPort,
  type ModelProfile,
  type ProviderBudgetPort,
} from '@techpulse/domain';
import {
  createCollectionDeliveryJobData,
  parseCollectionDeliveryJobData,
  WorkerJobValidationError,
} from '../src/jobs.js';
import { createWorkerEmbeddingHandler, createWorkerEmbeddingService } from '../src/embedding.js';
import { WorkerLifecycle } from '../src/health.js';
import { OutboxDispatcher } from '../src/partition-runtime.js';
import { loadWorkerConfig } from '../src/config.js';

function createFakeStateRepository(): CollectionStatePort & {
  deliveries: Map<string, CollectionDelivery>;
  completedDeliveries: string[];
  sentDeliveries: string[];
} {
  const deliveries = new Map<string, CollectionDelivery>();
  const completedDeliveries: string[] = [];
  const sentDeliveries: string[] = [];

  return {
    deliveries,
    completedDeliveries,
    sentDeliveries,
    async registerTarget(input) {
      return {
        id: 'rev-1',
        targetId: 'tgt-1',
        configHash: 'hash-1',
        createdAt: new Date(),
        ...input,
      };
    },
    async getTargetRevision() {
      return null;
    },
    async setTargetEnabled() {},
    async listTargets() {
      return [];
    },
    async planPartition(plan) {
      return {
        id: 'part-1',
        state: 'pending',
        stateReason: null,
        cursor: null,
        cursorVersion: 1,
        totalItemsCollected: 0,
        totalDocumentsSaved: 0,
        ...plan,
      };
    },
    async getPartition() {
      return null;
    },
    async listPartitions() {
      return [];
    },
    async claimPage() {
      return null;
    },
    async renewPage() {
      return true;
    },
    async commitPage() {},
    async failPage() {},
    async resumePartition(id) {
      return {
        id,
        targetRevisionId: 'rev-1',
        mode: 'incremental',
        timeBasis: 'published_at',
        window: { from: new Date(), to: new Date() },
        state: 'pending',
        stateReason: null,
        cursor: null,
        cursorVersion: 1,
        totalItemsCollected: 0,
        totalDocumentsSaved: 0,
      };
    },
    async claimDeliveries(now, limit) {
      const results: CollectionDelivery[] = [];
      for (const d of deliveries.values()) {
        if (
          d.completedAt === null &&
          (d.leaseUntil === null || d.leaseUntil.getTime() <= now.getTime())
        ) {
          results.push(d);
          if (results.length >= limit) break;
        }
      }
      return results;
    },
    async getDelivery(id) {
      return deliveries.get(id) ?? null;
    },
    async markSent(id, leaseEpoch) {
      sentDeliveries.push(id);
      const item = deliveries.get(id);
      if (item) {
        deliveries.set(id, {
          ...item,
          leaseEpoch: leaseEpoch + 1,
          leaseUntil: new Date(Date.now() + 30000),
        });
      }
    },
    async completeDelivery(id) {
      completedDeliveries.push(id);
      const item = deliveries.get(id);
      if (item) {
        deliveries.set(id, {
          ...item,
          completedAt: new Date(),
          leaseUntil: null,
        });
      }
    },
    async attachRevision() {},
  };
}

describe('COV-008 Worker V2 Delivery and Runtime Integration', () => {
  describe('V2 Payload Validation', () => {
    it('creates and parses valid V2 delivery job data', () => {
      const valid = createCollectionDeliveryJobData('123e4567-e89b-12d3-a456-426614174000');
      expect(valid.schemaVersion).toBe(2);
      expect(valid.deliveryId).toBe('123e4567-e89b-12d3-a456-426614174000');

      const parsed = parseCollectionDeliveryJobData(valid);
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.deliveryId).toBe('123e4567-e89b-12d3-a456-426614174000');
    });

    it('rejects stale schemaVersion v1 or non-v2 payloads', () => {
      expect(() =>
        parseCollectionDeliveryJobData({
          schemaVersion: 1,
          deliveryId: '123e4567-e89b-12d3-a456-426614174000',
        }),
      ).toThrow(WorkerJobValidationError);
    });

    it('rejects extra unexpected fields in delivery job payload', () => {
      expect(() =>
        parseCollectionDeliveryJobData({
          schemaVersion: 2,
          deliveryId: '123e4567-e89b-12d3-a456-426614174000',
          unexpectedPayloadData: 'illegal',
        }),
      ).toThrow(WorkerJobValidationError);
    });

    it('rejects empty or missing deliveryId', () => {
      expect(() =>
        parseCollectionDeliveryJobData({
          schemaVersion: 2,
          deliveryId: '',
        }),
      ).toThrow(WorkerJobValidationError);
    });
  });

  describe('PostgreSQL Completion Authority & Duplicate Delivery', () => {
    it('skips execution idempotently if delivery is already marked complete in PostgreSQL', async () => {
      const stateRepo = createFakeStateRepository();
      const deliveryId = '123e4567-e89b-12d3-a456-426614174000';

      // Insert already completed delivery
      stateRepo.deliveries.set(deliveryId, {
        id: deliveryId,
        kind: 'embedding',
        partitionId: 'part-1',
        pageSequence: 1,
        rawItemId: null,
        revisionId: 'rev-1',
        completedAt: new Date(),
        leaseEpoch: 1,
        leaseUntil: null,
      });

      let handlerCalls = 0;
      const embeddingHandler = async () => {
        handlerCalls++;
      };

      const outboxDispatcher = new OutboxDispatcher({
        stateRepository: stateRepo,
        partitionService: {
          executePartitionPage: async () => ({ itemsSaved: 0, disposition: 'complete' }),
        },
        embeddingHandler,
      });

      // Claim deliveries: completed items are not claimed
      const result = await outboxDispatcher.dispatchBatch();
      expect(result.claimedCount).toBe(0);
      expect(handlerCalls).toBe(0);
    });
  });

  describe('Redis Loss Recovery via OutboxDispatcher', () => {
    it('re-claims and completes pending deliveries from PostgreSQL even if Redis dropped messages', async () => {
      const stateRepo = createFakeStateRepository();
      const deliveryId = '123e4567-e89b-12d3-a456-426614174000';

      // Insert pending uncompleted delivery (as if lost by Redis)
      stateRepo.deliveries.set(deliveryId, {
        id: deliveryId,
        kind: 'collection',
        partitionId: 'part-1',
        pageSequence: 1,
        rawItemId: null,
        revisionId: null,
        completedAt: null,
        leaseEpoch: 0,
        leaseUntil: null,
      });

      let pageExecuted = false;
      const partitionService = {
        executePartitionPage: async () => {
          pageExecuted = true;
          return { itemsSaved: 1, disposition: 'complete' as const };
        },
      };

      const outboxDispatcher = new OutboxDispatcher({
        stateRepository: stateRepo,
        partitionService,
      });

      const result = await outboxDispatcher.dispatchBatch();
      expect(result.claimedCount).toBe(1);
      expect(result.processedCount).toBe(1);
      expect(pageExecuted).toBe(true);
      expect(stateRepo.sentDeliveries).toContain(deliveryId);
    });
  });

  describe('Embedding Service Gates, Reuse, and Outcome Unknown', () => {
    it('fails closed when credentials are absent and fixture mode is false', async () => {
      const fakeWorkPort: EmbeddingWorkPort = {
        async claimOrReadCompleted() {
          return null;
        },
        async beginCall() {},
        async completeWork() {},
        async markOutcomeUnknown() {},
      };
      const fakeBudgetPort: ProviderBudgetPort = {
        async configureScope() {},
        async reserve() {
          return {
            id: 'res-1',
            scopeId: 'scope-1',
            attemptId: 'att-1',
            state: 'reserved',
            units: 1,
            tokens: 10,
          };
        },
        async settle() {},
        async holdUnknown() {},
        async releaseUnsent() {},
      };

      const result = createWorkerEmbeddingService({
        config: {},
        allowFixtureProviders: false, // Production behavior
        workPort: fakeWorkPort,
        budgetPort: fakeBudgetPort,
      });

      expect(result).toBeUndefined();

      const handler = createWorkerEmbeddingHandler({
        stateRepository: createFakeStateRepository(),
        embeddingService: result?.embeddingService,
        chunkRepository: {
          async listByRevision() {
            return [
              {
                id: 'chk-1',
                documentRevisionId: 'rev-1',
                chunkIndex: 0,
                content: 'hello',
                byteLength: 5,
                tokenCount: 2,
              },
            ];
          },
          async saveChunks() {},
          async deleteByRevision() {},
        },
      });

      await expect(handler({ deliveryId: 'del-1', revisionId: 'rev-1' })).rejects.toThrow(
        ProviderBudgetError,
      );
    });
    it('never automatically constructs network/provider adapter when model apiKey is provided with fixture flag', () => {
      const fakeWorkPort: EmbeddingWorkPort = {
        async claimOrReadCompleted() {
          return null;
        },
        async beginCall() {},
        async completeWork() {},
        async markOutcomeUnknown() {},
      };
      const fakeBudgetPort: ProviderBudgetPort = {
        async configureScope() {},
        async reserve() {
          return {
            id: 'res-1',
            scopeId: 'scope-1',
            attemptId: 'att-1',
            state: 'reserved',
            units: 1,
            tokens: 10,
          };
        },
        async settle() {},
        async holdUnknown() {},
        async releaseUnsent() {},
      };

      // Even with an API key and full profile config, fixture flag must NOT construct live adapter if embeddingPort is not injected
      const result = createWorkerEmbeddingService({
        config: {
          apiKey: 'sk-test-secret-key-must-not-create-live-adapter',
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
          priceVersion: 'embed-v1-standard',
          tokenizerVersion: 'cl100k-embed',
          approvalReference: 'DEC-007-EMBED',
          scopeId: 'scope-1',
        },
        allowFixtureProviders: true,
        workPort: fakeWorkPort,
        budgetPort: fakeBudgetPort,
        pricingTable: {
          'embed-v1-standard': { unitsPerThousandTokens: 20 },
        },
      });

      expect(result).toBeUndefined();
    });

    it('rejects model construction when approval reference is missing', () => {
      const fakeWorkPort: EmbeddingWorkPort = {
        async claimOrReadCompleted() {
          return null;
        },
        async beginCall() {},
        async completeWork() {},
        async markOutcomeUnknown() {},
      };
      const fakeBudgetPort: ProviderBudgetPort = {
        async configureScope() {},
        async reserve() {
          return {
            id: 'res-1',
            scopeId: 'scope-1',
            attemptId: 'att-1',
            state: 'reserved',
            units: 1,
            tokens: 10,
          };
        },
        async settle() {},
        async holdUnknown() {},
        async releaseUnsent() {},
      };

      const result = createWorkerEmbeddingService({
        config: {
          apiKey: 'sk-test-live-key',
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
          priceVersion: 'embed-v1-standard',
          tokenizerVersion: 'cl100k-embed',
          // approvalReference is omitted!
          scopeId: 'scope-1',
        },
        allowFixtureProviders: false,
        workPort: fakeWorkPort,
        budgetPort: fakeBudgetPort,
        pricingTable: {
          'embed-v1-standard': { unitsPerThousandTokens: 20 },
        },
      });

      expect(result).toBeUndefined();
    });

    it('rejects model construction when pricing table or price version is missing or invalid', () => {
      const fakeWorkPort: EmbeddingWorkPort = {
        async claimOrReadCompleted() {
          return null;
        },
        async beginCall() {},
        async completeWork() {},
        async markOutcomeUnknown() {},
      };
      const fakeBudgetPort: ProviderBudgetPort = {
        async configureScope() {},
        async reserve() {
          return {
            id: 'res-1',
            scopeId: 'scope-1',
            attemptId: 'att-1',
            state: 'reserved',
            units: 1,
            tokens: 10,
          };
        },
        async settle() {},
        async holdUnknown() {},
        async releaseUnsent() {},
      };

      // Missing pricingTable
      const resultNoTable = createWorkerEmbeddingService({
        config: {
          apiKey: 'sk-test-live-key',
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
          priceVersion: 'embed-v1-standard',
          tokenizerVersion: 'cl100k-embed',
          approvalReference: 'DEC-007-EMBED',
          scopeId: 'scope-1',
        },
        allowFixtureProviders: false,
        workPort: fakeWorkPort,
        budgetPort: fakeBudgetPort,
      });
      expect(resultNoTable).toBeUndefined();

      // Missing price version in table
      const resultMismatchTable = createWorkerEmbeddingService({
        config: {
          apiKey: 'sk-test-live-key',
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 1536,
          priceVersion: 'embed-v1-standard',
          tokenizerVersion: 'cl100k-embed',
          approvalReference: 'DEC-007-EMBED',
          scopeId: 'scope-1',
        },
        allowFixtureProviders: false,
        workPort: fakeWorkPort,
        budgetPort: fakeBudgetPort,
        pricingTable: {
          'other-version': { unitsPerThousandTokens: 20 },
        },
      });
      expect(resultMismatchTable).toBeUndefined();
    });

    it('creates embedding service when explicit injected EmbeddingPort, explicit profile, scope, and pricing are provided', () => {
      const fakeWorkPort: EmbeddingWorkPort = {
        async claimOrReadCompleted() {
          return null;
        },
        async beginCall() {},
        async completeWork() {},
        async markOutcomeUnknown() {},
      };
      const fakeBudgetPort: ProviderBudgetPort = {
        async configureScope() {},
        async reserve() {
          return {
            id: 'res-1',
            scopeId: 'scope-1',
            attemptId: 'att-1',
            state: 'reserved',
            units: 1,
            tokens: 10,
          };
        },
        async settle() {},
        async holdUnknown() {},
        async releaseUnsent() {},
      };
      const fakeEmbeddingPort = {
        async embed() {
          return {
            vector: [0.1, 0.2],
            metadata: {
              model: 'fixture-embed',
              dimensions: 2,
              latencyMs: 0,
              usage: { inputTokens: 1, totalTokens: 1 },
            },
          };
        },
      };

      const result = createWorkerEmbeddingService({
        config: {},
        allowFixtureProviders: true,
        embeddingPort: fakeEmbeddingPort,
        profile: {
          provider: 'deterministic',
          model: 'test-model',
          version: '2026-09-01',
          dimensions: 2,
          priceVersion: 'test-free',
          tokenizerVersion: 'cl100k-embed',
          approvalReference: 'TEST-APPROVAL-001',
        },
        scopeId: 'test-scope',
        pricingTable: {
          'test-free': { unitsPerThousandTokens: 0 },
        },
        workPort: fakeWorkPort,
        budgetPort: fakeBudgetPort,
      });

      expect(result).toBeDefined();
      expect(result?.profile.approvalReference).toBe('TEST-APPROVAL-001');
      expect(result?.embeddingService).toBeDefined();
    });

    it('constructs the approved OpenRouter embedding adapter with its pinned price profile', () => {
      const fakeWorkPort: EmbeddingWorkPort = {
        async claimOrReadCompleted() {
          return null;
        },
        async beginCall() {},
        async completeWork() {},
        async markOutcomeUnknown() {},
      };
      const fakeBudgetPort: ProviderBudgetPort = {
        async configureScope() {},
        async reserve() {
          throw new Error('not called during construction');
        },
        async settle() {},
        async holdUnknown() {},
        async releaseUnsent() {},
      };

      const result = createWorkerEmbeddingService({
        config: {
          apiKey: 'openrouter-key',
          baseUrl: 'https://openrouter.ai/api/v1',
          provider: 'openrouter-perplexity',
          model: 'perplexity/pplx-embed-v1-0.6b',
          version: '2026-03-16',
          dimensions: 1024,
          scopeId: 'dec-012-cov009',
          priceVersion: 'openrouter-pplx-embed-2026-09-10',
          tokenizerVersion: 'provider-reported-v1',
          approvalReference: 'DEC-007-2026-09-10',
        },
        workPort: fakeWorkPort,
        budgetPort: fakeBudgetPort,
      });

      expect(result).toBeDefined();
      expect(result?.profile.model).toBe('perplexity/pplx-embed-v1-0.6b');
      expect(result?.profile.dimensions).toBe(1024);
    });

    it('reuses existing chunk embedding without provider call or budget consumption', async () => {
      const stateRepo = createFakeStateRepository();
      let providerCalled = 0;

      const fakeEmbeddingPort = {
        async embed() {
          providerCalled++;
          return {
            vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
            metadata: {
              model: 'fake-embed-v1',
              dimensions: 8,
              latencyMs: 0,
              usage: { inputTokens: 1, totalTokens: 1 },
            },
          };
        },
      };

      const fakeWorkPort: EmbeddingWorkPort = {
        async claimOrReadCompleted(key) {
          // Return completed work (cached vector)
          return {
            id: 'work-1',
            key,
            state: 'completed',
            epoch: 1,
            leaseUntil: null,
            vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
            reservationId: null,
          };
        },
        async beginCall() {},
        async completeWork() {},
        async markOutcomeUnknown() {},
      };

      const fakeBudgetPort: ProviderBudgetPort = {
        async configureScope() {},
        async reserve() {
          throw new Error('Reserve should not be called when reused');
        },
        async settle() {},
        async holdUnknown() {},
        async releaseUnsent() {},
      };

      const embeddingService = createEmbeddingService({
        workPort: fakeWorkPort,
        budgetPort: fakeBudgetPort,
        embeddingPort: fakeEmbeddingPort,
        scopeId: 'default-scope',
        priceTable: {
          'embed-v1-standard': { unitsPerThousandTokens: 20 },
        },
      });

      const chunkRepo: ChunkRepositoryPort = {
        async listByRevision() {
          return [
            {
              id: 'chk-1',
              documentRevisionId: 'rev-1',
              chunkIndex: 0,
              content: 'hello reuse',
              byteLength: 11,
              tokenCount: 3,
            },
          ];
        },
        async saveChunks() {},
        async deleteByRevision() {},
      };

      const fixtureProfile: ModelProfile = {
        provider: 'openrouter',
        model: 'text-embedding-3-small',
        version: '2026-09-01',
        dimensions: 1536,
        priceVersion: 'embed-v1-standard',
        tokenizerVersion: 'cl100k-embed',
        approvalReference: 'DEC-007-EMBED',
      };

      const handler = createWorkerEmbeddingHandler({
        stateRepository: stateRepo,
        embeddingService,
        chunkRepository: chunkRepo,
        profile: fixtureProfile,
      });

      await handler({ deliveryId: 'del-1', revisionId: 'rev-1' });

      expect(providerCalled).toBe(0);
      expect(stateRepo.completedDeliveries).toContain('del-1');
    });

    it('holds reservation and does not complete delivery when outcome is unknown', async () => {
      const stateRepo = createFakeStateRepository();

      const fakeWorkPort: EmbeddingWorkPort = {
        async claimOrReadCompleted(key) {
          return {
            id: 'work-1',
            key,
            state: 'claimed',
            epoch: 1,
            leaseUntil: new Date(Date.now() + 30000),
            vector: null,
            reservationId: null,
          };
        },
        async beginCall() {},
        async completeWork() {},
        async markOutcomeUnknown() {},
      };

      const fakeBudgetPort: ProviderBudgetPort = {
        async configureScope() {},
        async reserve() {
          return {
            id: 'res-1',
            scopeId: 'default-scope',
            attemptId: 'att-1',
            state: 'reserved',
            units: 1,
            tokens: 10,
          };
        },
        async settle() {},
        async holdUnknown() {},
        async releaseUnsent() {},
      };

      // Port times out / unknown outcome
      const fakeEmbeddingPort = {
        async embed() {
          const err = new Error('Network timeout');
          (err as unknown as Record<string, unknown>)['name'] = 'AiTimeoutError';
          throw err;
        },
      };

      const embeddingService = createEmbeddingService({
        workPort: fakeWorkPort,
        budgetPort: fakeBudgetPort,
        embeddingPort: fakeEmbeddingPort,
        scopeId: 'default-scope',
        priceTable: {
          'embed-v1-standard': { promptPer1kUnits: 0.00002, completionPer1kUnits: 0 },
        },
      });

      const chunkRepo: ChunkRepositoryPort = {
        async listByRevision() {
          return [
            {
              id: 'chk-1',
              documentRevisionId: 'rev-1',
              chunkIndex: 0,
              content: 'hello timeout',
              byteLength: 13,
              tokenCount: 4,
            },
          ];
        },
        async saveChunks() {},
        async deleteByRevision() {},
      };

      const fixtureProfile: ModelProfile = {
        provider: 'openrouter',
        model: 'text-embedding-3-small',
        version: '2026-09-01',
        dimensions: 1536,
        priceVersion: 'embed-v1-standard',
        tokenizerVersion: 'cl100k-embed',
        approvalReference: 'DEC-007-EMBED',
      };

      const handler = createWorkerEmbeddingHandler({
        stateRepository: stateRepo,
        embeddingService,
        chunkRepository: chunkRepo,
        profile: fixtureProfile,
      });

      await expect(handler({ deliveryId: 'del-1', revisionId: 'rev-1' })).rejects.toThrow(
        ProviderBudgetError,
      );

      // Must not complete delivery in PostgreSQL
      expect(stateRepo.completedDeliveries).not.toContain('del-1');
    });
  });

  describe('Worker Health Lifecycle', () => {
    it('tracks starting, healthy, degraded, and unhealthy transitions', () => {
      const lifecycle = new WorkerLifecycle();
      let health = lifecycle.getHealth();
      expect(health.status).toBe('starting');
      expect(health.isHealthy).toBe(true);

      lifecycle.setRunning();
      health = lifecycle.getHealth();
      expect(health.status).toBe('healthy');
      expect(health.isHealthy).toBe(true);

      // Transient ticks
      lifecycle.recordTick(true);
      expect(lifecycle.getHealth().consecutiveErrors).toBe(0);

      // Errors trigger degraded then unhealthy
      lifecycle.recordTick(false, 'error 1');
      lifecycle.recordTick(false, 'error 2');
      lifecycle.recordTick(false, 'error 3');
      expect(lifecycle.getHealth().status).toBe('degraded');

      for (let i = 4; i <= 10; i++) {
        lifecycle.recordTick(false, `error ${i}`);
      }
      expect(lifecycle.getHealth().status).toBe('unhealthy');
      expect(lifecycle.getHealth().isHealthy).toBe(false);

      // Recovery
      lifecycle.recordTick(true);
      expect(lifecycle.getHealth().status).toBe('healthy');
      expect(lifecycle.getHealth().isHealthy).toBe(true);
    });
  });

  describe('Config validation', () => {
    it('parses extended worker options with defaults', () => {
      const config = loadWorkerConfig({
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
      });
      expect(config.concurrency).toBe(1);
      expect(config.incrementalConcurrency).toBe(5);
      expect(config.backfillConcurrency).toBe(2);
      expect(config.pollIntervalMs).toBe(1000);
      expect(config.leaseMs).toBe(30000);
      expect(config.allowFixtureProviders).toBe(false);
    });

    it('enables fixture mode only when explicit verification flag is provided', () => {
      const config = loadWorkerConfig({
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        TECHPULSE_ALLOW_FIXTURE_PROVIDERS: 'true',
      });
      expect(config.allowFixtureProviders).toBe(true);
    });
  });
});
