import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  collectionHash,
  ProviderBudgetError,
  type ChatCompletionRequest,
  type ChatCompletionResult,
  type ChatPort,
  type EmbeddingPort,
  type EmbeddingResult,
  type ModelProfile,
  type ExecutionCaps,
  type PriceRate,
} from '@techpulse/domain';
import { type DatabaseClient } from '@techpulse/database';
import { createBudgetedApiModels } from '../src/runtime-models.js';
import { createReleaseBudget, wrapReleasePorts, ZERO_USAGE } from '../src/release-budget.js';
import { FIXED_CORPUS } from '../src/release-evaluation.js';

describe('COV-008 API Runtime Model Bindings & Budget Authorization', () => {
  const sampleProfile: ModelProfile = {
    provider: 'openai',
    model: 'gpt-4o-mini',
    version: '2024-07-18',
    dimensions: 1536,
    priceVersion: 'v1',
    tokenizerVersion: 'cl100k_base',
    approvalReference: 'sec-app-001',
  };

  const sampleCaps: ExecutionCaps = {
    maxInputTokens: 4000,
    maxOutputTokens: 2000,
    timeoutMs: 10000,
  };

  const samplePriceRate: PriceRate = {
    unitsPerThousandTokens: 15,
  };

  const sampleScopeId = 'scope-api-test-1';

  function createFakeDb(
    scopeRecord: {
      id: string;
      approved: boolean;
      blocked: boolean;
      approvedModelProfiles: readonly string[];
    } | null,
  ): DatabaseClient['db'] {
    const reservations: Record<string, unknown>[] = [];
    let selectCalls = 0;
    const mockTx = {
      execute: async () => ({
        rows: [
          {
            daily_units: '0',
            daily_tokens: '0',
            outstanding: '0',
            lane_units: '0',
            lane_tokens: '0',
          },
        ],
      }),
      select: () => ({
        from: (table: Record<PropertyKey, unknown>) => ({
          where: () => {
            selectCalls += 1;
            const tableName = table[Symbol.for('drizzle:Name')];
            const rows =
              tableName === 'provider_budget_scopes'
                ? [
                    scopeRecord
                      ? {
                          ...scopeRecord,
                          maxDailyUnits: 100000,
                          maxOutstandingUnits: 50000,
                          maxDailyTokens: 100000,
                          currency: 'USD',
                          laneLimits: {
                            chat: { maxDailyUnits: 50000, maxDailyTokens: 50000 },
                            query_embedding: {
                              maxDailyUnits: 50000,
                              maxDailyTokens: 50000,
                            },
                          },
                        }
                      : null,
                  ].filter(Boolean)
                : tableName === 'provider_budget_reservations'
                  ? selectCalls % 5 === 2
                    ? []
                    : reservations
                  : [];
            return {
              for: () => rows,
              then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
            };
          },
        }),
      }),
      insert: () => ({
        values: (val: Record<string, unknown>) => {
          reservations.push(val);
          return {
            returning: () => [{ id: '11111111-1111-4111-8111-111111111111', ...val }],
          };
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => [{ id: '11111111-1111-4111-8111-111111111111' }],
          }),
        }),
      }),
    };

    return {
      query: {
        providerBudgetScopes: {
          findFirst: async () => scopeRecord,
        },
      },
      ...mockTx,
      transaction: async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
    } as unknown as DatabaseClient['db'];
  }

  const fakeChatPort: ChatPort = {
    async complete(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
      return {
        content: 'Fake response to: ' + req.messages[0]?.content,
        metadata: {
          model: req.model ?? 'gpt-4o-mini',
          usage: {
            inputTokens: 10,
            outputTokens: 10,
            totalTokens: 20,
          },
        },
      };
    },
  };

  const fakeEmbeddingPort: EmbeddingPort = {
    async embed(): Promise<EmbeddingResult> {
      return {
        vector: new Array(1536).fill(0.1),
        metadata: {
          model: 'text-embedding-3-small',
          usage: {
            inputTokens: 3,
            totalTokens: 3,
          },
        },
      };
    },
    async embedMany(reqs: readonly EmbeddingRequest[]): Promise<readonly EmbeddingResult[]> {
      return Promise.all(reqs.map((r) => this.embed(r)));
    },
  };

  test('validates model bindings up-front on creation', () => {
    const db = createFakeDb(null);

    // 1. Invalid profile -> throws ProviderBudgetError
    assert.throws(
      () =>
        createBudgetedApiModels(db, {
          chat: {
            port: fakeChatPort,
            profile: { ...sampleProfile, provider: '' },
            scopeId: sampleScopeId,
            caps: sampleCaps,
            priceRate: samplePriceRate,
          },
        }),
      ProviderBudgetError,
    );

    // 2. Empty scope ID -> throws ProviderBudgetError
    assert.throws(
      () =>
        createBudgetedApiModels(db, {
          chat: {
            port: fakeChatPort,
            profile: sampleProfile,
            scopeId: '   ',
            caps: sampleCaps,
            priceRate: samplePriceRate,
          },
        }),
      ProviderBudgetError,
    );
  });

  test('rejects execution if budget scope is not approved', async () => {
    const db = createFakeDb({
      id: sampleScopeId,
      approved: false,
      blocked: false,
      approvedModelProfiles: [collectionHash(sampleProfile)],
    });

    const { chatPort } = createBudgetedApiModels(db, {
      chat: {
        port: fakeChatPort,
        profile: sampleProfile,
        scopeId: sampleScopeId,
        caps: sampleCaps,
        priceRate: samplePriceRate,
      },
    });

    await assert.rejects(
      async () =>
        chatPort.complete({
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      (err: unknown) => err instanceof ProviderBudgetError && err.code === 'approval_required',
    );
  });

  test('rejects execution if budget scope is blocked', async () => {
    const db = createFakeDb({
      id: sampleScopeId,
      approved: true,
      blocked: true,
      approvedModelProfiles: [collectionHash(sampleProfile)],
    });

    const { chatPort } = createBudgetedApiModels(db, {
      chat: {
        port: fakeChatPort,
        profile: sampleProfile,
        scopeId: sampleScopeId,
        caps: sampleCaps,
        priceRate: samplePriceRate,
      },
    });

    await assert.rejects(
      async () =>
        chatPort.complete({
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      (err: unknown) => err instanceof ProviderBudgetError && err.code === 'approval_required',
    );
  });

  test('rejects execution if model profile is not in approvedModelProfiles', async () => {
    const db = createFakeDb({
      id: sampleScopeId,
      approved: true,
      blocked: false,
      approvedModelProfiles: ['different_profile_hash_that_does_not_match'],
    });

    const { chatPort } = createBudgetedApiModels(db, {
      chat: {
        port: fakeChatPort,
        profile: sampleProfile,
        scopeId: sampleScopeId,
        caps: sampleCaps,
        priceRate: samplePriceRate,
      },
    });

    await assert.rejects(
      async () =>
        chatPort.complete({
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      (err: unknown) => err instanceof ProviderBudgetError && err.code === 'approval_required',
    );
  });

  test('successfully authorizes and executes chat and embedding when scope is approved', async () => {
    const profileHash = collectionHash(sampleProfile);
    const db = createFakeDb({
      id: sampleScopeId,
      approved: true,
      blocked: false,
      approvedModelProfiles: [profileHash],
    });

    const { chatPort, embeddingPort } = createBudgetedApiModels(db, {
      chat: {
        port: fakeChatPort,
        profile: sampleProfile,
        scopeId: sampleScopeId,
        caps: sampleCaps,
        priceRate: samplePriceRate,
      },
      embedding: {
        port: fakeEmbeddingPort,
        profile: sampleProfile,
        scopeId: sampleScopeId,
        caps: sampleCaps,
        priceRate: samplePriceRate,
      },
    });

    const chatRes = await chatPort.complete({
      messages: [{ role: 'user', content: 'Tell me about TypeScript' }],
    });
    assert.match(chatRes.content, /Fake response/);
    assert.equal(chatRes.metadata?.usage?.totalTokens, 20);

    assert.ok(embeddingPort);
    const embedRes = await embeddingPort.embed({
      input: 'TypeScript features',
    });
    assert.equal(embedRes.vector.length, 1536);
  });

  test('EVAL-002 preserves the smaller output reservation through the actual runtime budget layer', async () => {
    let upstreamOutputCap: number | undefined;
    const upstream: ChatPort = {
      async complete(request) {
        upstreamOutputCap = request.maxOutputTokens;
        return {
          content: '{"answer":"fixture"}',
          metadata: {
            model: sampleProfile.model,
            latencyMs: 0,
            usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
          },
        };
      },
    };
    const binding = {
      profile: sampleProfile,
      scopeId: sampleScopeId,
      caps: sampleCaps,
      priceRate: samplePriceRate,
    };
    const bindings = {
      chat: { ...binding, port: upstream },
      embedding: { ...binding, port: fakeEmbeddingPort },
    };
    const db = createFakeDb({
      id: sampleScopeId,
      approved: true,
      blocked: false,
      approvedModelProfiles: [collectionHash(sampleProfile)],
    });
    const runtime = createBudgetedApiModels(db, bindings, { reserveFullInputCap: true });
    assert.ok(runtime.embeddingPort);
    const budget = createReleaseBudget(
      {
        schemaVersion: 1,
        decision: 'DEC-013',
        datasetSha256: FIXED_CORPUS.sha256,
        reconciled: true,
        reconciliationReference: 'COMPOSED-TEST-FIXTURE-ONLY',
        usage: ZERO_USAGE,
      },
      [],
      async () => {},
    );
    const ports = wrapReleasePorts(
      { chatPort: runtime.chatPort, embeddingPort: runtime.embeddingPort },
      bindings,
      budget,
    );
    await ports.chatPort.complete({
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 12,
    });
    assert.equal(upstreamOutputCap, 12);
    assert.equal(budget.snapshot().usage.chatOutputTokens, 12);
    assert.equal(budget.snapshot().unknownReservations, 0);
  });
});
