import { describe, expect, it } from 'vitest';
import {
  AiTimeoutError,
  createDeterministicChatPort,
  createDeterministicEmbeddingPort,
  type ChatPort,
} from '../src/ai.js';
import { collectionHash } from '../src/collection-state.js';
import {
  ProviderBudgetError,
  type BudgetReservation,
  type BudgetScope,
  type ModelProfile,
  type ProviderBudgetPort,
} from '../src/model-work.js';
import {
  assertValidBudgetCaps,
  assertValidModelProfile,
  assertValidPriceRate,
  calculateTokenUnits,
  createProviderBudgetService,
  estimateTokenCount,
  type BudgetedChatOptions,
  type BudgetedEmbeddingOptions,
  type ExecutionCaps,
  type PriceRate,
} from '../src/provider-budget.js';

export function createInMemoryProviderBudgetPort(): ProviderBudgetPort & {
  scopes: Map<string, BudgetScope & { blocked?: boolean }>;
  reservations: Map<
    string,
    BudgetReservation & {
      lane: string;
      utcDay: string;
      actualUnits?: number;
      actualTokens?: number;
    }
  >;
} {
  const scopes = new Map<string, BudgetScope & { blocked?: boolean }>();
  const reservations = new Map<
    string,
    BudgetReservation & {
      lane: string;
      utcDay: string;
      actualUnits?: number;
      actualTokens?: number;
    }
  >();
  let nextId = 1;

  return {
    scopes,
    reservations,
    async configureScope(scope) {
      if (
        !Number.isSafeInteger(scope.maxDailyUnits) ||
        scope.maxDailyUnits < 0 ||
        !Number.isSafeInteger(scope.maxDailyTokens) ||
        scope.maxDailyTokens < 0 ||
        !Number.isSafeInteger(scope.maxOutstandingUnits) ||
        scope.maxOutstandingUnits < 0
      ) {
        throw new ProviderBudgetError('invalid_usage');
      }
      if (!/^[A-Z]{3}$/u.test(scope.currency) || !scope.id) {
        throw new ProviderBudgetError('invalid_usage');
      }
      for (const limit of Object.values(scope.laneLimits)) {
        if (
          !Number.isSafeInteger(limit.maxDailyUnits) ||
          limit.maxDailyUnits < 0 ||
          !Number.isSafeInteger(limit.maxDailyTokens) ||
          limit.maxDailyTokens < 0
        ) {
          throw new ProviderBudgetError('invalid_usage');
        }
      }
      if (
        !Array.isArray(scope.approvedModelProfiles) ||
        scope.approvedModelProfiles.some((h) => !/^[a-f0-9]{64}$/u.test(h))
      ) {
        throw new ProviderBudgetError('invalid_usage');
      }
      const existing = scopes.get(scope.id);
      if (existing && existing.currency !== scope.currency) {
        throw new ProviderBudgetError('reservation_conflict');
      }
      scopes.set(scope.id, { ...scope });
    },

    async reserve(scopeId, attemptId, lane, units, tokens, now) {
      if (
        !Number.isSafeInteger(units) ||
        units < 0 ||
        !Number.isSafeInteger(tokens) ||
        tokens < 0 ||
        !attemptId ||
        attemptId.length > 256 ||
        !Number.isFinite(now.getTime())
      ) {
        throw new ProviderBudgetError('invalid_usage');
      }
      const scope = scopes.get(scopeId);
      if (!scope || !scope.approved || !scope.laneLimits[lane]) {
        throw new ProviderBudgetError('approval_required');
      }

      // Check existing attemptId idempotency
      for (const res of reservations.values()) {
        if (res.attemptId === attemptId) {
          if (
            res.scopeId !== scopeId ||
            res.lane !== lane ||
            res.units !== units ||
            res.tokens !== tokens
          ) {
            throw new ProviderBudgetError('reservation_conflict');
          }
          return {
            id: res.id,
            scopeId: res.scopeId,
            attemptId: res.attemptId,
            state: res.state,
            units: res.units,
            tokens: res.tokens,
          };
        }
      }

      if (scope.blocked) {
        throw new ProviderBudgetError('budget_exhausted');
      }

      const utcDay = now.toISOString().slice(0, 10);
      let dailyUnits = 0;
      let dailyTokens = 0;
      let outstandingUnits = 0;
      let laneUnits = 0;
      let laneTokens = 0;

      for (const res of reservations.values()) {
        if (res.scopeId !== scopeId || res.state === 'released') continue;
        const u = res.actualUnits ?? res.units;
        const t = res.actualTokens ?? res.tokens;
        if (res.utcDay === utcDay) {
          dailyUnits += u;
          dailyTokens += t;
          if (res.lane === lane) {
            laneUnits += u;
            laneTokens += t;
          }
        }
        if (res.state === 'reserved' || res.state === 'outcome_unknown') {
          outstandingUnits += res.units;
        }
      }

      const laneLimit = scope.laneLimits[lane]!;
      if (
        dailyUnits + units > scope.maxDailyUnits ||
        dailyTokens + tokens > scope.maxDailyTokens ||
        outstandingUnits + units > scope.maxOutstandingUnits ||
        laneUnits + units > laneLimit.maxDailyUnits ||
        laneTokens + tokens > laneLimit.maxDailyTokens
      ) {
        throw new ProviderBudgetError('budget_exhausted');
      }

      const id = `res-${nextId++}`;
      const reservation = {
        id,
        scopeId,
        attemptId,
        lane,
        utcDay,
        state: 'reserved' as const,
        units,
        tokens,
      };
      reservations.set(id, reservation);
      return {
        id,
        scopeId,
        attemptId,
        state: 'reserved',
        units,
        tokens,
      };
    },

    async settle(id, units, tokens) {
      if (
        !Number.isSafeInteger(units) ||
        units < 0 ||
        !Number.isSafeInteger(tokens) ||
        tokens < 0
      ) {
        throw new ProviderBudgetError('invalid_usage');
      }
      const reservation = reservations.get(id);
      if (!reservation || reservation.state === 'released') {
        throw new ProviderBudgetError('reservation_conflict');
      }
      if (reservation.state === 'settled') {
        if (reservation.actualUnits !== units || reservation.actualTokens !== tokens) {
          throw new ProviderBudgetError('reservation_conflict');
        }
        return;
      }
      reservation.state = 'settled';
      reservation.actualUnits = units;
      reservation.actualTokens = tokens;

      if (units > reservation.units || tokens > reservation.tokens) {
        const scope = scopes.get(reservation.scopeId);
        if (scope) {
          scope.blocked = true;
        }
      }
    },

    async holdUnknown(id) {
      const reservation = reservations.get(id);
      if (reservation && reservation.state === 'reserved') {
        reservation.state = 'outcome_unknown';
      }
    },

    async releaseUnsent(id) {
      const reservation = reservations.get(id);
      if (!reservation) throw new ProviderBudgetError('reservation_conflict');
      if (reservation.state === 'released') return;
      if (reservation.state !== 'reserved') throw new ProviderBudgetError('outcome_unknown');
      reservation.state = 'released';
    },
  };
}

const validProfile: ModelProfile = {
  provider: 'deterministic-fake',
  model: 'fake-chat-v1',
  version: '2026-09-01',
  dimensions: 8,
  priceVersion: 'v1-standard',
  tokenizerVersion: 'v1-cl100k',
  approvalReference: 'DEC-007-APPROVAL',
};

const validPriceRate: PriceRate = {
  unitsPerThousandTokens: 10,
};

const validCaps: ExecutionCaps = {
  maxInputTokens: 2000,
  maxOutputTokens: 1000,
  timeoutMs: 5000,
};

describe('provider-budget validation and estimation', () => {
  it('validates model profile fields strictly', () => {
    expect(() => assertValidModelProfile(validProfile)).not.toThrow();

    expect(() => assertValidModelProfile({ ...validProfile, provider: '' })).toThrow(
      'approval_required',
    );
    expect(() => assertValidModelProfile({ ...validProfile, model: '  ' })).toThrow(
      'approval_required',
    );
    expect(() => assertValidModelProfile({ ...validProfile, priceVersion: '' })).toThrow(
      'approval_required',
    );
    expect(() => assertValidModelProfile({ ...validProfile, tokenizerVersion: '' })).toThrow(
      'approval_required',
    );
    expect(() => assertValidModelProfile({ ...validProfile, approvalReference: '' })).toThrow(
      'approval_required',
    );
    expect(() => assertValidModelProfile({ ...validProfile, dimensions: 0 })).toThrow(
      'invalid_usage',
    );
    expect(() => assertValidModelProfile({ ...validProfile, dimensions: 20000 })).toThrow(
      'invalid_usage',
    );
  });

  it('validates budget execution caps', () => {
    expect(() => assertValidBudgetCaps(validCaps)).not.toThrow();
    expect(() => assertValidBudgetCaps({ maxInputTokens: 0 })).toThrow('approval_required');
    expect(() => assertValidBudgetCaps({ maxInputTokens: -1 })).toThrow('approval_required');
    expect(() => assertValidBudgetCaps({ maxInputTokens: 100, maxOutputTokens: -5 })).toThrow(
      'approval_required',
    );
    expect(() => assertValidBudgetCaps({ maxInputTokens: 100, timeoutMs: -10 })).toThrow(
      'invalid_usage',
    );
  });

  it('validates price rates and calculates token units deterministically', () => {
    expect(() => assertValidPriceRate({ unitsPerThousandTokens: 15 })).not.toThrow();
    expect(() => assertValidPriceRate({ unitsPerThousandTokens: -1 })).toThrow('invalid_usage');

    expect(calculateTokenUnits(0, { unitsPerThousandTokens: 10 })).toBe(0);
    expect(calculateTokenUnits(100, { unitsPerThousandTokens: 10 })).toBe(1);
    expect(calculateTokenUnits(1000, { unitsPerThousandTokens: 10 })).toBe(10);
    expect(calculateTokenUnits(1500, { unitsPerThousandTokens: 10 })).toBe(15);
  });

  it('estimates token count deterministically without live tokenizers', () => {
    expect(estimateTokenCount('')).toBe(0);
    expect(estimateTokenCount('   ')).toBe(0);
    expect(estimateTokenCount('hello world')).toBeGreaterThanOrEqual(2);
    expect(() => estimateTokenCount('test', '')).toThrow('invalid_usage');
  });
});

describe('provider-budget service execution for chat and query embeddings', () => {
  const profileHash = collectionHash(validProfile);
  const validScope: BudgetScope = {
    id: 'scope-main',
    approved: true,
    currency: 'USD',
    maxDailyUnits: 1000,
    maxDailyTokens: 100000,
    maxOutstandingUnits: 500,
    laneLimits: {
      chat: { maxDailyUnits: 500, maxDailyTokens: 50000 },
      query_embedding: { maxDailyUnits: 200, maxDailyTokens: 20000 },
      ingestion_embedding: { maxDailyUnits: 500, maxDailyTokens: 50000 },
    },
    approvedModelProfiles: [profileHash],
  };

  it('executes chat with budget reservation and settlement', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(validScope);
    const service = createProviderBudgetService(budgetPort);

    const chatPort = createDeterministicChatPort({
      response: 'Hello from budget chat',
      model: 'fake-chat-v1',
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    });

    const options: BudgetedChatOptions = {
      scopeId: validScope.id,
      attemptId: 'chat-attempt-1',
      profile: validProfile,
      caps: validCaps,
      priceRate: validPriceRate,
      now: new Date('2026-09-09T10:00:00Z'),
    };

    const result = await service.executeChatWithBudget(
      chatPort,
      { messages: [{ role: 'user', content: 'What is coverage?' }] },
      options,
    );

    expect(result.content).toBe('Hello from budget chat');
    expect(result.metadata.usage.totalTokens).toBe(10);

    const reservation = budgetPort.reservations.get('res-1');
    expect(reservation).toBeDefined();
    expect(reservation?.state).toBe('settled');
    expect(reservation?.actualTokens).toBe(10);
  });

  it('executes query embedding with budget reservation and settlement', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(validScope);
    const service = createProviderBudgetService(budgetPort);

    const embeddingPort = createDeterministicEmbeddingPort({
      dimensions: 8,
      model: 'fake-chat-v1',
    });

    const options: BudgetedEmbeddingOptions = {
      scopeId: validScope.id,
      attemptId: 'query-embed-attempt-1',
      profile: validProfile,
      lane: 'query_embedding',
      caps: { maxInputTokens: 500 },
      priceRate: validPriceRate,
      now: new Date('2026-09-09T10:00:00Z'),
    };

    const result = await service.executeQueryEmbeddingWithBudget(
      embeddingPort,
      { input: 'search for compiler optimization' },
      options,
    );

    expect(result.vector).toHaveLength(8);
    const reservation = budgetPort.reservations.get('res-1');
    expect(reservation?.state).toBe('settled');
    expect(reservation?.lane).toBe('query_embedding');
  });

  it('reserves an explicit conservative input bound while retaining the approved output cap', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(validScope);
    const service = createProviderBudgetService(budgetPort);
    const chat = createDeterministicChatPort({
      usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
    });
    await service.executeChatWithBudget(
      chat,
      { messages: [{ role: 'user', content: 'hello' }] },
      {
        scopeId: validScope.id,
        attemptId: 'bounded-chat',
        profile: validProfile,
        caps: validCaps,
        priceRate: validPriceRate,
        inputTokenUpperBound: 1000,
      },
    );
    expect(budgetPort.reservations.get('res-1')?.tokens).toBe(2000);
    expect(chat.calls[0]?.maxOutputTokens).toBe(1000);
    const embedding = createDeterministicEmbeddingPort({ dimensions: 8 });
    await service.executeQueryEmbeddingWithBudget(
      embedding,
      { input: 'hello' },
      {
        scopeId: validScope.id,
        attemptId: 'bounded-query',
        profile: validProfile,
        caps: validCaps,
        lane: 'query_embedding',
        priceRate: validPriceRate,
        inputTokenUpperBound: 1000,
      },
    );
    expect(budgetPort.reservations.get('res-2')?.tokens).toBe(1000);
  });

  it.each([12, 10000])(
    'never expands the caller output cap or the approved output cap: %s',
    async (requested) => {
      const budgetPort = createInMemoryProviderBudgetPort();
      await budgetPort.configureScope(validScope);
      const service = createProviderBudgetService(budgetPort);
      const chat = createDeterministicChatPort({
        usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
      });
      await service.executeChatWithBudget(
        chat,
        { messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: requested },
        {
          scopeId: validScope.id,
          attemptId: 'output-cap-fixture',
          profile: validProfile,
          caps: validCaps,
          priceRate: validPriceRate,
          inputTokenUpperBound: 1000,
        },
      );
      const expected = Math.min(requested, validCaps.maxOutputTokens!);
      expect(chat.calls[0]?.maxOutputTokens).toBe(expected);
      expect(budgetPort.reservations.get('res-1')?.tokens).toBe(1000 + expected);
    },
  );

  it('rejects invalid requested output caps before budget reservation or dispatch', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(validScope);
    const service = createProviderBudgetService(budgetPort);
    const chat = createDeterministicChatPort();
    for (const maxOutputTokens of [0, -1, 0.5, NaN, Infinity]) {
      await expect(
        service.executeChatWithBudget(
          chat,
          { messages: [{ role: 'user', content: 'hello' }], maxOutputTokens },
          {
            scopeId: validScope.id,
            attemptId: 'invalid-output-cap',
            profile: validProfile,
            caps: validCaps,
            priceRate: validPriceRate,
          },
        ),
      ).rejects.toThrow('invalid_usage');
    }
    expect(budgetPort.reservations.size).toBe(0);
    expect(chat.calls).toHaveLength(0);
  });

  it('rejects invalid or insufficient input bounds before reserving or calling a provider', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(validScope);
    const service = createProviderBudgetService(budgetPort);
    const chat = createDeterministicChatPort();
    const embedding = createDeterministicEmbeddingPort();
    for (const inputTokenUpperBound of [-1, 0, 0.5, Number.NaN, 2001]) {
      await expect(
        service.executeChatWithBudget(
          chat,
          { messages: [{ role: 'user', content: 'hello world' }] },
          {
            scopeId: validScope.id,
            attemptId: 'invalid-bound-chat',
            profile: validProfile,
            caps: validCaps,
            priceRate: validPriceRate,
            inputTokenUpperBound,
          },
        ),
      ).rejects.toThrow('invalid_usage');
      await expect(
        service.executeQueryEmbeddingWithBudget(
          embedding,
          { input: 'hello world' },
          {
            scopeId: validScope.id,
            attemptId: 'invalid-bound-query',
            profile: validProfile,
            caps: validCaps,
            lane: 'query_embedding',
            priceRate: validPriceRate,
            inputTokenUpperBound,
          },
        ),
      ).rejects.toThrow('invalid_usage');
    }
    expect(chat.calls).toHaveLength(0);
    expect(embedding.calls).toHaveLength(0);
    expect(budgetPort.reservations.size).toBe(0);
  });

  it('rejects duplicate reservation with different parameters with reservation_conflict', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(validScope);

    const now = new Date('2026-09-09T10:00:00Z');
    await budgetPort.reserve(validScope.id, 'attempt-dup-1', 'chat', 10, 100, now);

    // Same attemptId, different units -> conflict!
    await expect(
      budgetPort.reserve(validScope.id, 'attempt-dup-1', 'chat', 20, 100, now),
    ).rejects.toMatchObject({ code: 'reservation_conflict' });

    // Same attemptId, identical parameters -> returns existing reservation (idempotent)
    const existing = await budgetPort.reserve(validScope.id, 'attempt-dup-1', 'chat', 10, 100, now);
    expect(existing.id).toBe('res-1');
  });

  it('holds reservation as outcome_unknown on timeout or provider error without refund', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(validScope);
    const service = createProviderBudgetService(budgetPort);

    const failingChatPort: ChatPort = {
      async complete() {
        throw new AiTimeoutError('Chat request timed out');
      },
    };

    const options: BudgetedChatOptions = {
      scopeId: validScope.id,
      attemptId: 'chat-timeout-attempt',
      profile: validProfile,
      caps: validCaps,
      priceRate: validPriceRate,
      now: new Date('2026-09-09T10:00:00Z'),
    };

    await expect(
      service.executeChatWithBudget(
        failingChatPort,
        { messages: [{ role: 'user', content: 'test timeout' }] },
        options,
      ),
    ).rejects.toBeInstanceOf(AiTimeoutError);

    const reservation = budgetPort.reservations.get('res-1');
    expect(reservation).toBeDefined();
    expect(reservation?.state).toBe('outcome_unknown');
  });

  it('fails closed when provider returns missing or invalid usage and holds reservation', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(validScope);
    const service = createProviderBudgetService(budgetPort);

    // Malformed chat port that returns no usage
    const malformedChatPort: ChatPort = {
      async complete() {
        return {
          content: 'No usage here',
          metadata: {
            model: 'fake-chat-v1',
            latencyMs: 5,
          } as unknown as ChatCompletionResult['metadata'],
        };
      },
    };

    const options: BudgetedChatOptions = {
      scopeId: validScope.id,
      attemptId: 'chat-missing-usage',
      profile: validProfile,
      caps: validCaps,
      priceRate: validPriceRate,
      now: new Date('2026-09-09T10:00:00Z'),
    };

    await expect(
      service.executeChatWithBudget(
        malformedChatPort,
        { messages: [{ role: 'user', content: 'test usage' }] },
        options,
      ),
    ).rejects.toMatchObject({ code: 'invalid_usage' });

    const reservation = budgetPort.reservations.get('res-1');
    expect(reservation?.state).toBe('outcome_unknown');
  });

  it('fails closed on overspend and blocks future reservations on the scope', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    await budgetPort.configureScope(validScope);

    const now = new Date('2026-09-09T10:00:00Z');
    const res = await budgetPort.reserve(validScope.id, 'attempt-overspend', 'chat', 10, 100, now);

    // Settle with units > reserved units (overspend!)
    await budgetPort.settle(res.id, 25, 250, now);

    const scope = budgetPort.scopes.get(validScope.id);
    expect(scope?.blocked).toBe(true);

    // Subsequent reserve fails with budget_exhausted because scope is blocked
    await expect(
      budgetPort.reserve(validScope.id, 'attempt-after-overspend', 'chat', 5, 50, now),
    ).rejects.toMatchObject({ code: 'budget_exhausted' });
  });

  it('preserves exposure across UTC days and accounts for outstanding unknown reservations', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    const tightScope: BudgetScope = {
      ...validScope,
      maxOutstandingUnits: 50,
      maxDailyUnits: 100,
    };
    await budgetPort.configureScope(tightScope);

    const day1 = new Date('2026-09-08T23:50:00Z');
    // Day 1 reservation that becomes outcome_unknown
    const res1 = await budgetPort.reserve(tightScope.id, 'day1-attempt', 'chat', 40, 400, day1);
    await budgetPort.holdUnknown(res1.id, day1);

    // Day 2 arrives: UTC day boundary crosses
    const day2 = new Date('2026-09-09T00:10:00Z');
    // Day 2 has fresh daily allowance, BUT outstanding allowance is 50.
    // Outstanding from day 1 is 40.
    // A new reservation of 20 exceeds maxOutstandingUnits (40 + 20 = 60 > 50)!
    await expect(
      budgetPort.reserve(tightScope.id, 'day2-attempt-too-big', 'chat', 20, 200, day2),
    ).rejects.toMatchObject({ code: 'budget_exhausted' });

    // A small reservation of 10 fits (40 + 10 = 50 <= 50)
    const res2 = await budgetPort.reserve(tightScope.id, 'day2-attempt-ok', 'chat', 10, 100, day2);
    expect(res2.id).toBe('res-2');
  });

  it('blocks unapproved scope and absent profile approval', async () => {
    const budgetPort = createInMemoryProviderBudgetPort();
    const unapprovedScope: BudgetScope = {
      ...validScope,
      approved: false,
    };
    await budgetPort.configureScope(unapprovedScope);

    const now = new Date('2026-09-09T10:00:00Z');
    await expect(
      budgetPort.reserve(unapprovedScope.id, 'attempt-unapproved', 'chat', 10, 100, now),
    ).rejects.toMatchObject({ code: 'approval_required' });
  });
});
