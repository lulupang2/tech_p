import { describe, expect, it } from 'vitest';
import {
  AiProviderError,
  AiTimeoutError,
  createDeterministicEmbeddingPort,
  type EmbeddingPort,
} from '../src/ai.js';
import { collectionHash } from '../src/collection-state.js';
import {
  createEmbeddingService,
  type EmbeddingChunkInput,
  type EmbeddingServiceCaps,
} from '../src/embedding-service.js';
import {
  ProviderBudgetError,
  type BudgetScope,
  type EmbeddingWorkKey,
  type EmbeddingWorkPort,
  type EmbeddingWorkState,
  type ModelProfile,
} from '../src/model-work.js';
import { type ModelPricingTable } from '../src/provider-budget.js';
import { createInMemoryProviderBudgetPort } from './provider-budget.test.js';

export function createInMemoryEmbeddingWorkPort(): EmbeddingWorkPort & {
  items: Map<
    string,
    {
      id: string;
      workKey: string;
      chunkId: string;
      inputHash: string;
      profile: ModelProfile;
      state: EmbeddingWorkState;
      leaseEpoch: number;
      leaseUntil: Date | null;
      vector: readonly number[] | null;
      reservationId: string | null;
    }
  >;
  rightsRevoked?: boolean;
} {
  const items = new Map<
    string,
    {
      id: string;
      workKey: string;
      chunkId: string;
      inputHash: string;
      profile: ModelProfile;
      state: EmbeddingWorkState;
      leaseEpoch: number;
      leaseUntil: Date | null;
      vector: readonly number[] | null;
      reservationId: string | null;
    }
  >();
  let nextId = 1;

  return {
    items,
    rightsRevoked: false,

    async claimOrReadCompleted(key, now, leaseMs) {
      const profile = key.profile;
      if (
        !profile.provider ||
        !profile.model ||
        !profile.version ||
        !profile.priceVersion ||
        !profile.tokenizerVersion ||
        !profile.approvalReference ||
        !Number.isSafeInteger(profile.dimensions) ||
        profile.dimensions < 1 ||
        profile.dimensions > 16000 ||
        !Number.isSafeInteger(leaseMs) ||
        leaseMs < 1000 ||
        leaseMs > 300000
      ) {
        throw new ProviderBudgetError('invalid_usage');
      }

      if (this.rightsRevoked) {
        throw new ProviderBudgetError('approval_required');
      }

      const workKey = collectionHash(key);
      let row = items.get(workKey);

      if (!row) {
        const id = `work-${nextId++}`;
        row = {
          id,
          workKey,
          chunkId: key.chunkId,
          inputHash: key.inputHash,
          profile: key.profile,
          state: 'pending',
          leaseEpoch: 0,
          leaseUntil: null,
          vector: null,
          reservationId: null,
        };
        items.set(workKey, row);
      }

      if (row.state === 'completed') {
        return {
          id: row.id,
          key: { chunkId: row.chunkId, inputHash: row.inputHash, profile: row.profile },
          state: 'completed',
          epoch: row.leaseEpoch,
          leaseUntil: null,
          vector: row.vector,
          reservationId: row.reservationId,
        };
      }

      if (row.state === 'outcome_unknown') {
        return {
          id: row.id,
          key: { chunkId: row.chunkId, inputHash: row.inputHash, profile: row.profile },
          state: 'outcome_unknown',
          epoch: row.leaseEpoch,
          leaseUntil: null,
          vector: null,
          reservationId: row.reservationId,
        };
      }

      if (row.state === 'failed') {
        return {
          id: row.id,
          key: { chunkId: row.chunkId, inputHash: row.inputHash, profile: row.profile },
          state: 'failed',
          epoch: row.leaseEpoch,
          leaseUntil: null,
          vector: null,
          reservationId: row.reservationId,
        };
      }

      // Active lease?
      if (row.leaseUntil && row.leaseUntil.getTime() > now.getTime()) {
        return null; // in flight by another worker
      }

      // Calling lease expired -> outcome_unknown
      if (row.state === 'calling') {
        row.state = 'outcome_unknown';
        return {
          id: row.id,
          key: { chunkId: row.chunkId, inputHash: row.inputHash, profile: row.profile },
          state: 'outcome_unknown',
          epoch: row.leaseEpoch,
          leaseUntil: null,
          vector: null,
          reservationId: row.reservationId,
        };
      }

      // Pending or expired claimed lease -> claim with new epoch
      row.state = 'claimed';
      row.leaseEpoch += 1;
      row.leaseUntil = new Date(now.getTime() + leaseMs);
      row.reservationId = null;

      return {
        id: row.id,
        key: { chunkId: row.chunkId, inputHash: row.inputHash, profile: row.profile },
        state: 'claimed',
        epoch: row.leaseEpoch,
        leaseUntil: row.leaseUntil,
        vector: null,
        reservationId: null,
      };
    },

    async beginCall(id, epoch, reservationId, now) {
      if (this.rightsRevoked) {
        throw new ProviderBudgetError('approval_required');
      }
      let found: (typeof items extends Map<string, infer V> ? V : never) | undefined;
      for (const item of items.values()) {
        if (item.id === id) {
          found = item;
          break;
        }
      }
      if (
        !found ||
        found.state !== 'claimed' ||
        found.leaseEpoch !== epoch ||
        !found.leaseUntil ||
        found.leaseUntil.getTime() <= now.getTime()
      ) {
        throw new ProviderBudgetError('stale_work');
      }
      found.state = 'calling';
      found.reservationId = reservationId;
    },

    async completeWork(id, epoch, vector, now) {
      if (this.rightsRevoked) {
        throw new ProviderBudgetError('approval_required');
      }
      let found: (typeof items extends Map<string, infer V> ? V : never) | undefined;
      for (const item of items.values()) {
        if (item.id === id) {
          found = item;
          break;
        }
      }
      if (
        !found ||
        found.leaseEpoch !== epoch ||
        found.state !== 'calling' ||
        !found.leaseUntil ||
        found.leaseUntil.getTime() <= now.getTime()
      ) {
        throw new ProviderBudgetError('stale_work');
      }
      if (
        vector.length !== found.profile.dimensions ||
        vector.some((v) => !Number.isFinite(v)) ||
        !vector.some((v) => v !== 0)
      ) {
        throw new ProviderBudgetError('invalid_usage');
      }
      found.state = 'completed';
      found.vector = [...vector];
      found.leaseUntil = null;
    },

    async markOutcomeUnknown(id, epoch) {
      for (const item of items.values()) {
        if (item.id === id && item.leaseEpoch === epoch && item.state === 'calling') {
          item.state = 'outcome_unknown';
        }
      }
    },

    async markFailed(id, epoch) {
      for (const item of items.values()) {
        if (item.id === id && item.leaseEpoch === epoch && item.state === 'calling') {
          item.state = 'failed';
          item.leaseUntil = null;
        }
      }
    },
  };
}

const sampleProfile: ModelProfile = {
  provider: 'deterministic-fake',
  model: 'fake-embed-v1',
  version: '2026-09-01',
  dimensions: 8,
  priceVersion: 'embed-v1-standard',
  tokenizerVersion: 'cl100k-embed',
  approvalReference: 'DEC-007-EMBED',
};

const samplePriceTable: ModelPricingTable = {
  'embed-v1-standard': {
    unitsPerThousandTokens: 5,
  },
};

const sampleCaps: EmbeddingServiceCaps = {
  maxInputTokens: 4000,
  leaseMs: 30000,
  timeoutMs: 5000,
};

describe('EmbeddingService lifecycle and concurrency control', () => {
  const profileHash = collectionHash(sampleProfile);
  const sampleScope: BudgetScope = {
    id: 'scope-embed',
    approved: true,
    currency: 'USD',
    maxDailyUnits: 5000,
    maxDailyTokens: 500000,
    maxOutstandingUnits: 2000,
    laneLimits: {
      ingestion_embedding: { maxDailyUnits: 4000, maxDailyTokens: 400000 },
      query_embedding: { maxDailyUnits: 1000, maxDailyTokens: 100000 },
    },
    approvedModelProfiles: [profileHash],
  };

  const sampleChunk: EmbeddingChunkInput = {
    chunkId: 'chunk-101',
    input: 'This is the normalized text content for chunk 101.',
    inputHash: 'hash-chunk-101-abc',
  };

  it('completed replay has zero calls to provider and zero budget reservations', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(sampleScope);
    const workPort = createInMemoryEmbeddingWorkPort();
    const embeddingPort = createDeterministicEmbeddingPort({
      dimensions: 8,
      model: sampleProfile.model,
    });

    const service = createEmbeddingService({
      workPort,
      budgetPort,
      embeddingPort,
      scopeId: sampleScope.id,
      priceTable: samplePriceTable,
      caps: sampleCaps,
      now: () => new Date('2026-09-09T10:00:00Z'),
    });

    // 1st run: processes and completes work
    const firstResult = await service.processChunk(sampleChunk, sampleProfile);
    expect(firstResult.status).toBe('completed');
    expect(firstResult.reused).toBe(false);
    expect(firstResult.vector).toHaveLength(8);
    expect(embeddingPort.calls).toHaveLength(1);
    expect(budgetPort.reservations.size).toBe(1);

    // 2nd run: replay of completed work
    const secondResult = await service.processChunk(sampleChunk, sampleProfile);
    expect(secondResult.status).toBe('reused');
    expect(secondResult.reused).toBe(true);
    expect(secondResult.vector).toEqual(firstResult.vector);

    // External provider calls MUST NOT increase!
    expect(embeddingPort.calls).toHaveLength(1);
    // Budget reservations MUST NOT increase!
    expect(budgetPort.reservations.size).toBe(1);
  });

  it('concurrent workers make only one provider call', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(sampleScope);
    const workPort = createInMemoryEmbeddingWorkPort();
    const embeddingPort = createDeterministicEmbeddingPort({
      dimensions: 8,
      model: sampleProfile.model,
      latencyMs: 10,
    });

    const now = new Date('2026-09-09T10:00:00Z');
    const service1 = createEmbeddingService({
      workPort,
      budgetPort,
      embeddingPort,
      scopeId: sampleScope.id,
      priceTable: samplePriceTable,
      caps: sampleCaps,
      now: () => now,
    });
    const service2 = createEmbeddingService({
      workPort,
      budgetPort,
      embeddingPort,
      scopeId: sampleScope.id,
      priceTable: samplePriceTable,
      caps: sampleCaps,
      now: () => now,
    });

    // Worker 1 starts processing
    const worker1Promise = service1.processChunk(sampleChunk, sampleProfile);

    // Worker 2 tries to process the same chunk while worker 1 has an active lease
    const worker2Result = await service2.processChunk(sampleChunk, sampleProfile);
    expect(worker2Result.status).toBe('in_flight');
    expect(worker2Result.vector).toBeNull();

    // Worker 1 finishes successfully
    const worker1Result = await worker1Promise;
    expect(worker1Result.status).toBe('completed');
    expect(worker1Result.vector).toHaveLength(8);

    // Now worker 2 runs again and reuses the completed result
    const worker2RetryResult = await service2.processChunk(sampleChunk, sampleProfile);
    expect(worker2RetryResult.status).toBe('reused');
    expect(worker2RetryResult.vector).toEqual(worker1Result.vector);

    // Only exactly 1 provider call was made across both workers
    expect(embeddingPort.calls).toHaveLength(1);
  });

  it('partial failures resume safely in a batch', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(sampleScope);
    const workPort = createInMemoryEmbeddingWorkPort();

    let callCount = 0;
    const flakeEmbeddingPort: EmbeddingPort = {
      async embed(req) {
        callCount++;
        if (req.input.includes('chunk 2')) {
          throw new AiTimeoutError('Provider timeout on chunk 2');
        }
        return {
          vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
          metadata: {
            model: sampleProfile.model,
            dimensions: 8,
            latencyMs: 5,
            usage: { inputTokens: 2, totalTokens: 2 },
          },
        };
      },
      async embedMany(reqs) {
        const out = [];
        for (const r of reqs) out.push(await this.embed(r));
        return out;
      },
    };

    const service = createEmbeddingService({
      workPort,
      budgetPort,
      embeddingPort: flakeEmbeddingPort,
      scopeId: sampleScope.id,
      priceTable: samplePriceTable,
      caps: sampleCaps,
      now: () => new Date('2026-09-09T10:00:00Z'),
    });

    const chunks: EmbeddingChunkInput[] = [
      { chunkId: 'c1', input: 'chunk 1 valid', inputHash: 'hash-c1' },
      { chunkId: 'c2', input: 'chunk 2 will timeout', inputHash: 'hash-c2' },
      { chunkId: 'c3', input: 'chunk 3 valid', inputHash: 'hash-c3' },
    ];

    // Batch run 1: C1 succeeds, C2 fails (outcome_unknown), C3 succeeds
    const batchResults = await service.processBatch(chunks, sampleProfile);
    expect(batchResults[0]?.status).toBe('completed');
    expect(batchResults[1]?.status).toBe('outcome_unknown');
    expect(batchResults[2]?.status).toBe('completed');
    expect(callCount).toBe(3);

    // Batch run 2 (replay): C1 is reused (0 calls), C2 is outcome_unknown (0 calls), C3 is reused (0 calls)
    const replayResults = await service.processBatch(chunks, sampleProfile);
    expect(replayResults[0]?.status).toBe('reused');
    expect(replayResults[1]?.status).toBe('outcome_unknown');
    expect(replayResults[2]?.status).toBe('reused');

    // Total calls to provider remains exactly 3 (no re-calls for C1, C2, or C3)
    expect(callCount).toBe(3);
  });

  it('calling timeout marks work and budget as outcome_unknown without automatic re-charge', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(sampleScope);
    const workPort = createInMemoryEmbeddingWorkPort();

    const timeoutEmbeddingPort: EmbeddingPort = {
      async embed() {
        throw new AiTimeoutError('Network timeout during embedding call');
      },
      async embedMany(reqs) {
        return Promise.all(reqs.map((r) => this.embed(r)));
      },
    };

    const service = createEmbeddingService({
      workPort,
      budgetPort,
      embeddingPort: timeoutEmbeddingPort,
      scopeId: sampleScope.id,
      priceTable: samplePriceTable,
      caps: sampleCaps,
      now: () => new Date('2026-09-09T10:00:00Z'),
    });

    const result = await service.processChunk(sampleChunk, sampleProfile);
    expect(result.status).toBe('outcome_unknown');
    expect(result.vector).toBeNull();

    const reservation = budgetPort.reservations.get('res-1');
    expect(reservation?.state).toBe('outcome_unknown');

    const workKey = collectionHash({
      chunkId: sampleChunk.chunkId,
      inputHash: sampleChunk.inputHash,
      profile: sampleProfile,
    });
    const workItem = workPort.items.get(workKey);
    expect(workItem?.state).toBe('outcome_unknown');
  });

  it('local commit crash after remote success leaves state as outcome_unknown without refunding budget', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(sampleScope);
    const workPort = createInMemoryEmbeddingWorkPort();

    // Inject failure into completeWork
    workPort.completeWork = async () => {
      throw new Error('Database crash during completeWork transaction');
    };

    const embeddingPort = createDeterministicEmbeddingPort({
      dimensions: 8,
      model: sampleProfile.model,
    });

    const service = createEmbeddingService({
      workPort,
      budgetPort,
      embeddingPort,
      scopeId: sampleScope.id,
      priceTable: samplePriceTable,
      caps: sampleCaps,
      now: () => new Date('2026-09-09T10:00:00Z'),
    });

    const result = await service.processChunk(sampleChunk, sampleProfile);
    expect(result.status).toBe('outcome_unknown');

    // Budget reservation was settled and not refunded
    const reservation = budgetPort.reservations.get('res-1');
    expect(reservation?.state).toBe('settled');

    // Work item is marked outcome_unknown
    const workKey = collectionHash({
      chunkId: sampleChunk.chunkId,
      inputHash: sampleChunk.inputHash,
      profile: sampleProfile,
    });
    const workItem = workPort.items.get(workKey);
    expect(workItem?.state).toBe('outcome_unknown');
  });

  it('claimed lease expiry allows safe re-claim with epoch increment, but calling lease expiry transitions to outcome_unknown', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(sampleScope);
    const workPort = createInMemoryEmbeddingWorkPort();

    const t0 = new Date('2026-09-09T10:00:00Z');
    const key: EmbeddingWorkKey = {
      chunkId: sampleChunk.chunkId,
      inputHash: sampleChunk.inputHash,
      profile: sampleProfile,
    };

    // 1. Worker claims work item (state = 'claimed', lease until t0 + 10s)
    const claim1 = await workPort.claimOrReadCompleted(key, t0, 10000);
    expect(claim1?.state).toBe('claimed');
    expect(claim1?.epoch).toBe(1);

    // 2. Worker crashes BEFORE beginCall. Time advances past lease: t0 + 15s
    const t1 = new Date('2026-09-09T10:00:15Z');
    const claim2 = await workPort.claimOrReadCompleted(key, t1, 10000);
    expect(claim2?.state).toBe('claimed');
    expect(claim2?.epoch).toBe(2); // re-claimed with epoch 2!

    // 3. Worker 2 calls beginCall (state = 'calling', lease until t1 + 10s)
    const res = await budgetPort.reserve(
      sampleScope.id,
      `${claim2!.id}:2`,
      'ingestion_embedding',
      10,
      100,
      t1,
    );
    await workPort.beginCall(claim2!.id, 2, res.id, t1);

    // 4. Worker 2 crashes WHILE calling. Time advances past lease: t1 + 20s
    const t2 = new Date('2026-09-09T10:00:35Z');
    const claim3 = await workPort.claimOrReadCompleted(key, t2, 10000);
    // Calling lease expiry MUST transition to outcome_unknown, NOT re-claimable!
    expect(claim3?.state).toBe('outcome_unknown');
  });

  it('fails closed when scope, profile approval, price table, tokenizer, or caps are missing', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(sampleScope);
    const workPort = createInMemoryEmbeddingWorkPort();
    const embeddingPort = createDeterministicEmbeddingPort({ dimensions: 8 });

    // Missing price table
    const serviceNoPrice = createEmbeddingService({
      workPort,
      budgetPort,
      embeddingPort,
      scopeId: sampleScope.id,
      priceTable: {},
      caps: sampleCaps,
      now: () => new Date('2026-09-09T10:00:00Z'),
    });
    await expect(serviceNoPrice.processChunk(sampleChunk, sampleProfile)).rejects.toMatchObject({
      code: 'approval_required',
    });

    // Input exceeds maxInputTokens
    const serviceSmallCap = createEmbeddingService({
      workPort,
      budgetPort,
      embeddingPort,
      scopeId: sampleScope.id,
      priceTable: samplePriceTable,
      caps: { maxInputTokens: 2 },
      now: () => new Date('2026-09-09T10:00:00Z'),
    });
    await expect(serviceSmallCap.processChunk(sampleChunk, sampleProfile)).rejects.toMatchObject({
      code: 'invalid_usage',
    });

    // Empty input fails with UnsupportedAiInputError
    const serviceValid = createEmbeddingService({
      workPort,
      budgetPort,
      embeddingPort,
      scopeId: sampleScope.id,
      priceTable: samplePriceTable,
      caps: sampleCaps,
      now: () => new Date('2026-09-09T10:00:00Z'),
    });
    await expect(
      serviceValid.processChunk({ ...sampleChunk, input: '   ' }, sampleProfile),
    ).rejects.toBeInstanceOf(Error);
  });

  it('releases unsent reservation if pre-call validation or beginCall fails', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(sampleScope);
    const workPort = createInMemoryEmbeddingWorkPort();
    const embeddingPort = createDeterministicEmbeddingPort({ dimensions: 8 });

    // Mock beginCall to fail (e.g. rights revoked between claim and beginCall)
    workPort.beginCall = async () => {
      throw new ProviderBudgetError('approval_required');
    };

    const service = createEmbeddingService({
      workPort,
      budgetPort,
      embeddingPort,
      scopeId: sampleScope.id,
      priceTable: samplePriceTable,
      caps: sampleCaps,
      now: () => new Date('2026-09-09T10:00:00Z'),
    });

    await expect(service.processChunk(sampleChunk, sampleProfile)).rejects.toMatchObject({
      code: 'approval_required',
    });

    // The unsent reservation MUST be released!
    const reservation = budgetPort.reservations.get('res-1');
    expect(reservation?.state).toBe('released');
  });

  it('marks a known non-retryable provider rejection failed and releases its reservation', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(sampleScope);
    const workPort = createInMemoryEmbeddingWorkPort();
    const embeddingPort: EmbeddingPort = {
      async embed() {
        throw new AiProviderError('provider rejected credentials', undefined, undefined, false);
      },
      async embedMany(requests) {
        return Promise.all(requests.map((request) => this.embed(request)));
      },
    };
    const service = createEmbeddingService({
      workPort,
      budgetPort,
      embeddingPort,
      scopeId: sampleScope.id,
      priceTable: samplePriceTable,
      caps: sampleCaps,
      now: () => new Date('2026-09-09T10:00:00Z'),
    });

    await expect(service.processChunk(sampleChunk, sampleProfile)).resolves.toMatchObject({
      status: 'failed',
      reused: false,
    });
    expect([...workPort.items.values()][0]?.state).toBe('failed');
    expect(budgetPort.reservations.get('res-1')?.state).toBe('released');

    await expect(service.processChunk(sampleChunk, sampleProfile)).resolves.toMatchObject({
      status: 'failed',
      reused: false,
    });
    expect(budgetPort.reservations.size).toBe(1);
  });

  it('fails closed on invalid vector dimensions or all-zero vector', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(sampleScope);
    const workPort = createInMemoryEmbeddingWorkPort();

    // Provider returns all-zero vector (invalid)
    const zeroEmbeddingPort: EmbeddingPort = {
      async embed() {
        return {
          vector: [0, 0, 0, 0, 0, 0, 0, 0],
          metadata: {
            model: sampleProfile.model,
            dimensions: 8,
            latencyMs: 5,
            usage: { inputTokens: 2, totalTokens: 2 },
          },
        };
      },
      async embedMany(reqs) {
        return Promise.all(reqs.map((r) => this.embed(r)));
      },
    };

    const service = createEmbeddingService({
      workPort,
      budgetPort,
      embeddingPort: zeroEmbeddingPort,
      scopeId: sampleScope.id,
      priceTable: samplePriceTable,
      caps: sampleCaps,
      now: () => new Date('2026-09-09T10:00:00Z'),
    });

    await expect(service.processChunk(sampleChunk, sampleProfile)).rejects.toMatchObject({
      code: 'invalid_usage',
    });

    const reservation = budgetPort.reservations.get('res-1');
    expect(reservation?.state).toBe('outcome_unknown');
  });

  it.each([
    { model: 'unapproved-model', dimensions: 8 },
    { model: sampleProfile.model, dimensions: 1536 },
  ])('rejects provider metadata outside the approved profile: %j', async (metadata) => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(sampleScope);
    const workPort = createInMemoryEmbeddingWorkPort();
    const mismatchedPort: EmbeddingPort = {
      async embed() {
        return {
          vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
          metadata: {
            ...metadata,
            latencyMs: 5,
            usage: { inputTokens: 2, totalTokens: 2 },
          },
        };
      },
      async embedMany(requests) {
        return Promise.all(requests.map((request) => this.embed(request)));
      },
    };
    const service = createEmbeddingService({
      workPort,
      budgetPort,
      embeddingPort: mismatchedPort,
      scopeId: sampleScope.id,
      priceTable: samplePriceTable,
      caps: sampleCaps,
    });

    await expect(service.processChunk(sampleChunk, sampleProfile)).rejects.toMatchObject({
      code: 'invalid_usage',
    });
    expect(budgetPort.reservations.get('res-1')?.state).toBe('outcome_unknown');
  });
});
