import { describe, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ChatPort, EmbeddingPort } from '@techpulse/domain';
import { FIXED_CORPUS, sha256 } from '../src/release-evaluation.js';
import {
  createReleaseBudget,
  RELEASE_CAPS,
  ZERO_USAGE,
  validateReleaseAllowance,
  wrapReleasePorts,
  openReleaseJournal,
  type ReleaseHistory,
  type ReleaseAllowance,
  type ReleaseBudgetEvent,
  type ReleaseUsage,
} from '../src/release-budget.js';
import type { ApiModelBindings } from '../src/runtime-models.js';

const history: ReleaseHistory = {
  schemaVersion: 1,
  decision: 'DEC-013',
  datasetSha256: FIXED_CORPUS.sha256,
  reconciled: true,
  reconciliationReference: 'TEST-FIXTURE-NOT-LIVE-APPROVAL',
  usage: ZERO_USAGE,
};
const allowance: ReleaseAllowance = {
  schemaVersion: 1,
  decision: 'DEC-014',
  datasetSha256: FIXED_CORPUS.sha256,
  approvedAt: '2026-09-11T00:49:46+09:00',
  historySha256: sha256(JSON.stringify(history)),
  caps: RELEASE_CAPS,
  liveExecutionAllowed: true,
};
const reservation: ReleaseUsage = {
  ...ZERO_USAGE,
  embeddingCalls: 1,
  embeddingInputTokens: 80,
  microUsd: 1,
};

function fixtureBindings(chatPort: ChatPort, embeddingPort: EmbeddingPort): ApiModelBindings {
  const binding = {
    profile: {
      provider: 'fixture',
      model: 'fixture',
      version: '1',
      dimensions: 3,
      priceVersion: '1',
      tokenizerVersion: '1',
      approvalReference: 'fixture-only',
    },
    scopeId: 'fixture',
    caps: { maxInputTokens: 1000, maxOutputTokens: 100, timeoutMs: 100 },
    priceRate: { unitsPerThousandTokens: 1 },
  };
  return { chat: { ...binding, port: chatPort }, embedding: { ...binding, port: embeddingPort } };
}
const unusedChat: ChatPort = {
  async complete() {
    throw new Error('unexpected fixture call');
  },
};
const unusedEmbedding: EmbeddingPort = {
  async embed() {
    throw new Error('unexpected fixture call');
  },
  async embedMany() {
    return [];
  },
};

describe('EVAL-002 aggregate fail-closed budget', () => {
  test('DEC-014 preserves unreconciled historical usage but opens only a separate bounded tranche', async () => {
    const old = {
      ...history,
      reconciled: false,
      reconciliationReference: null,
      usage: { ...ZERO_USAGE, embeddingCalls: 195, embeddingInputTokens: 6290, microUsd: 6 },
    } satisfies ReleaseHistory;
    const approved = { ...allowance, historySha256: sha256(JSON.stringify(old)) };
    const guard = createReleaseBudget(old, [], async () => {}, approved);
    expect(guard.snapshot()).toMatchObject({
      budgetScope: 'additional_allowance',
      allowanceDecision: 'DEC-014',
      usage: ZERO_USAGE,
      historicalUsage: old.usage,
      historyReconciled: false,
      caps: RELEASE_CAPS,
    });
    expect(() => guard.assertReady()).not.toThrow();
    await guard.execute(
      'embedding',
      sha256('q'),
      reservation,
      async () => 1,
      () => reservation,
    );
    expect(guard.snapshot().usage.embeddingCalls).toBe(1);
    expect(guard.snapshot().historicalUsage.embeddingCalls).toBe(195);
  });

  test('DEC-014 is bound to the exact retained history and approved caps', () => {
    expect(validateReleaseAllowance(allowance, history)).toEqual(allowance);
    expect(() =>
      validateReleaseAllowance({ ...allowance, historySha256: sha256('other') }, history),
    ).toThrow('invalid_release_allowance');
    expect(() =>
      validateReleaseAllowance(
        { ...allowance, caps: { ...RELEASE_CAPS, embeddingCalls: 101 } },
        history,
      ),
    ).toThrow('invalid_release_allowance');
  });
  test('incomplete historical usage causes zero provider calls', async () => {
    let calls = 0;
    const guard = createReleaseBudget({ ...history, reconciled: false }, [], async () => {});
    await expect(
      guard.execute(
        'embedding',
        sha256('q'),
        reservation,
        async () => {
          calls += 1;
          return 1;
        },
        () => reservation,
      ),
    ).rejects.toThrow('release_history_unreconciled');
    expect(calls).toBe(0);
  });
  test.each([false, true])(
    'a proven historical overrun stays blocked with reconciled=%s',
    async (reconciled) => {
      let calls = 0;
      const guard = createReleaseBudget(
        {
          ...history,
          reconciled,
          usage: { ...ZERO_USAGE, embeddingCalls: 195, embeddingInputTokens: 6290 },
        },
        [],
        async () => {},
      );
      expect(guard.snapshot().exceededCaps).toEqual(['embeddingCalls']);
      expect(guard.snapshot().usage.embeddingCalls).toBe(195);
      await expect(
        guard.execute(
          'embedding',
          sha256('q'),
          reservation,
          async () => {
            calls += 1;
            return 1;
          },
          () => reservation,
        ),
      ).rejects.toThrow('release_budget_exhausted');
      expect(calls).toBe(0);
    },
  );
  test.each(Object.keys(RELEASE_CAPS))('enforces %s before any call', async (name) => {
    const key = name as keyof ReleaseUsage;
    const guard = createReleaseBudget(
      { ...history, usage: { ...ZERO_USAGE, [key]: RELEASE_CAPS[key] } },
      [],
      async () => {},
    );
    let calls = 0;
    await expect(
      guard.execute(
        'chat',
        sha256('q'),
        { ...ZERO_USAGE, [key]: 1 },
        async () => {
          calls += 1;
          return 1;
        },
        () => ZERO_USAGE,
      ),
    ).rejects.toThrow('release_budget_exhausted');
    expect(calls).toBe(0);
  });
  test('reserves durably first, settles actuals and carries usage into the next process', async () => {
    const events: ReleaseBudgetEvent[] = [];
    const guard = createReleaseBudget(history, events, async (event) => {
      events.push(event);
    });
    await guard.execute(
      'embedding',
      sha256('q'),
      reservation,
      async () => {
        expect(events[0]?.event).toBe('reserve');
        return 1;
      },
      () => ({ ...reservation, embeddingInputTokens: 10 }),
    );
    expect(guard.snapshot().usage.embeddingInputTokens).toBe(10);
    const restarted = createReleaseBudget(history, events, async () => {});
    expect(restarted.snapshot()).toEqual(guard.snapshot());
    expect(events).toHaveLength(2);
  });
  test('journal write failure occurs before the provider and poisons the runner', async () => {
    let calls = 0;
    const guard = createReleaseBudget(history, [], async () => {
      throw new Error('disk full');
    });
    await expect(
      guard.execute(
        'embedding',
        sha256('q'),
        reservation,
        async () => {
          calls += 1;
          return 1;
        },
        () => reservation,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    expect(() => guard.assertReady()).toThrow('release_outcome_unknown');
  });
  test('unknown provider outcomes remain reserved across restart without refund or retry', async () => {
    const events: ReleaseBudgetEvent[] = [];
    const guard = createReleaseBudget(history, [], async (event) => {
      events.push(event);
    });
    await expect(
      guard.execute(
        'embedding',
        sha256('q'),
        reservation,
        async () => {
          throw new Error('credential must never be logged');
        },
        () => reservation,
      ),
    ).rejects.toThrow('release_call_failed_or_outcome_unknown');
    expect(guard.snapshot().outstanding.embeddingCalls).toBe(1);
    const restarted = createReleaseBudget(history, events, async () => {});
    expect(() => restarted.assertReady()).toThrow('release_outcome_unknown');
    expect(JSON.stringify(events)).not.toContain('credential');
  });
  test('actual token overrun and missing usage do not become successful settlements', async () => {
    const guard = createReleaseBudget(history, [], async () => {});
    await expect(
      guard.execute(
        'embedding',
        sha256('q'),
        reservation,
        async () => 1,
        () => ({ ...reservation, embeddingInputTokens: 81 }),
      ),
    ).rejects.toThrow();
    expect(guard.snapshot().unknownReservations).toBe(1);
  });
  test('zero-call or wrong-lane journals cannot launder paid attempts on replay', () => {
    for (const reserved of [ZERO_USAGE, { ...reservation, chatCalls: 1 }]) {
      expect(() =>
        createReleaseBudget(
          history,
          [
            {
              event: 'reserve',
              reservation: {
                id: 'test-reservation',
                kind: 'embedding',
                requestSha256: sha256('q'),
                reserved,
              },
            },
          ],
          async () => {},
        ),
      ).toThrow('invalid_release_reservation');
    }
    expect(() =>
      createReleaseBudget(
        { ...history, usage: { ...ZERO_USAGE, embeddingCalls: 100 } },
        [
          {
            event: 'reserve',
            reservation: {
              id: 'test-reservation',
              kind: 'embedding',
              requestSha256: sha256('q'),
              reserved: reservation,
            },
          },
        ],
        async () => {},
      ),
    ).toThrow('invalid_release_journal_budget');
  });
  test('concurrent reservation is rejected even while durable admission is pending', async () => {
    let unlock!: () => void;
    const admitted = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const guard = createReleaseBudget(history, [], async () => admitted);
    const first = guard.execute(
      'embedding',
      sha256('first'),
      reservation,
      async () => 1,
      () => reservation,
    );
    await expect(
      guard.execute(
        'embedding',
        sha256('second'),
        reservation,
        async () => 2,
        () => reservation,
      ),
    ).rejects.toThrow('release_concurrency_exceeded');
    unlock();
    await first;
  });
  test('wrapper rejects wrong model, batches and expired deadlines without a call', async () => {
    let calls = 0;
    const chatPort: ChatPort = {
      complete: async () => {
        calls += 1;
        throw new Error('must not call');
      },
    };
    const embeddingPort: EmbeddingPort = {
      embed: async () => {
        calls += 1;
        throw new Error('must not call');
      },
      embedMany: async () => [],
    };
    const binding = {
      profile: {
        provider: 'fixture',
        model: 'fixture',
        version: '1',
        dimensions: 3,
        priceVersion: '1',
        tokenizerVersion: '1',
        approvalReference: 'fixture-only',
      },
      scopeId: 'fixture',
      caps: { maxInputTokens: 1000, maxOutputTokens: 100, timeoutMs: 100 },
      priceRate: { unitsPerThousandTokens: 1 },
    };
    const bindings: ApiModelBindings = {
      chat: { ...binding, port: chatPort },
      embedding: { ...binding, port: embeddingPort },
    };
    const ports = wrapReleasePorts(
      { chatPort, embeddingPort },
      bindings,
      createReleaseBudget(history, [], async () => {}),
    );
    await expect(ports.embeddingPort.embed({ input: 'q', model: 'other' })).rejects.toThrow(
      'release_model_mismatch',
    );
    await expect(ports.embeddingPort.embed({ input: 'q', timeoutMs: 0 })).rejects.toThrow(
      'release_deadline_expired',
    );
    await expect(ports.embeddingPort.embedMany([{ input: 'q' }])).rejects.toThrow(
      'release_batch_forbidden',
    );
    expect(calls).toBe(0);
  });

  test('filesystem journal locks one runner and preserves unknown costs across reopening', async () => {
    const parent = fileURLToPath(new URL('../../../test-results/', import.meta.url));
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'release-budget-fixture-'));
    const path = join(directory, 'ledger.jsonl');
    try {
      await expect(openReleaseJournal(path, history)).rejects.toThrow();
      await writeFile(
        path,
        `${JSON.stringify({ historySha256: sha256(JSON.stringify(history)) })}\n`,
        { flag: 'wx' },
      );
      const first = await openReleaseJournal(path, history);
      try {
        await expect(openReleaseJournal(path, history)).rejects.toThrow();
        await first.budget.execute(
          'embedding',
          sha256('first'),
          reservation,
          async () => 1,
          () => reservation,
        );
        await expect(
          first.budget.execute(
            'embedding',
            sha256('unknown'),
            reservation,
            async () => {
              throw new Error('fixture unknown');
            },
            () => reservation,
          ),
        ).rejects.toThrow();
      } finally {
        await first.close();
      }
      const restarted = await openReleaseJournal(path, history);
      try {
        expect(restarted.budget.snapshot().usage.embeddingCalls).toBe(1);
        expect(restarted.budget.snapshot().outstanding.embeddingCalls).toBe(1);
        expect(() => restarted.budget.assertReady()).toThrow('release_outcome_unknown');
      } finally {
        await restarted.close();
      }
      await expect(
        openReleaseJournal(path, { ...history, usage: { ...ZERO_USAGE, embeddingCalls: 1 } }),
      ).rejects.toThrow('release_journal_history_mismatch');
    } finally {
      await unlink(path).catch(() => {});
      await rmdir(directory);
    }
  });

  test('additional allowance journal is bound to both history and allowance digests', async () => {
    const parent = fileURLToPath(new URL('../../../test-results/', import.meta.url));
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'release-allowance-fixture-'));
    const path = join(directory, 'ledger.jsonl');
    try {
      await writeFile(
        path,
        `${JSON.stringify({
          historySha256: sha256(JSON.stringify(history)),
          allowanceSha256: sha256(JSON.stringify(allowance)),
        })}\n`,
        { flag: 'wx' },
      );
      const opened = await openReleaseJournal(path, history, allowance);
      await opened.close();
      await expect(
        openReleaseJournal(path, history, {
          ...allowance,
          approvedAt: '2026-09-11T00:50:00+09:00',
        }),
      ).rejects.toThrow('release_journal_allowance_mismatch');
    } finally {
      await unlink(path).catch(() => {});
      await rmdir(directory);
    }
  });

  test.each(['synchronous_abort', 'ignored_timeout'])(
    'bounds a non-cooperative port: %s',
    async (mode) => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        let calls = 0;
        const embeddingPort: EmbeddingPort = {
          ...unusedEmbedding,
          embed() {
            calls += 1;
            if (mode === 'synchronous_abort') controller.abort();
            return new Promise(() => {});
          },
        };
        const events: ReleaseBudgetEvent[] = [];
        const guard = createReleaseBudget(history, [], async (event) => {
          events.push(event);
        });
        const ports = wrapReleasePorts(
          { chatPort: unusedChat, embeddingPort },
          fixtureBindings(unusedChat, embeddingPort),
          guard,
        );
        let result: string | undefined;
        void ports.embeddingPort.embed({ input: 'q', signal: controller.signal }).then(
          () => {
            result = 'unexpected_success';
          },
          (error: Error) => {
            result = error.message;
          },
        );
        await vi.advanceTimersByTimeAsync(101);
        expect(result).toBe('release_call_failed_or_outcome_unknown');
        expect(calls).toBe(1);
        expect(guard.snapshot().unknownReservations).toBe(1);
        expect(() => createReleaseBudget(history, events, async () => {}).assertReady()).toThrow(
          'release_outcome_unknown',
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('cancellation during durable reservation dispatches no provider call and retains the hold', async () => {
    const controller = new AbortController();
    let calls = 0;
    const embeddingPort: EmbeddingPort = {
      ...unusedEmbedding,
      async embed() {
        calls += 1;
        throw new Error('must not dispatch');
      },
    };
    const guard = createReleaseBudget(history, [], async () => {
      controller.abort();
    });
    const ports = wrapReleasePorts(
      { chatPort: unusedChat, embeddingPort },
      fixtureBindings(unusedChat, embeddingPort),
      guard,
    );
    await expect(
      ports.embeddingPort.embed({ input: 'q', signal: controller.signal }),
    ).rejects.toThrow('release_call_failed_or_outcome_unknown');
    expect(calls).toBe(0);
    expect(guard.snapshot().outstanding.embeddingCalls).toBe(1);
  });

  test.each([undefined, 10000, 12])(
    'pins the raw chat port output to its reservation: %s',
    async (requested) => {
      const expected = requested === 12 ? 12 : 100;
      const chatPort: ChatPort = {
        async complete(request) {
          expect(request.model).toBe('fixture');
          expect(request.maxOutputTokens).toBe(expected);
          expect(request.responseFormat).toBe('json_object');
          return {
            content: '{"answer":"fixture"}',
            metadata: {
              model: 'fixture',
              latencyMs: 0,
              usage: { inputTokens: 2, outputTokens: expected, totalTokens: 2 + expected },
            },
          };
        },
      };
      const events: ReleaseBudgetEvent[] = [];
      const guard = createReleaseBudget(history, [], async (event) => {
        events.push(event);
      });
      const ports = wrapReleasePorts(
        { chatPort, embeddingPort: unusedEmbedding },
        fixtureBindings(chatPort, unusedEmbedding),
        guard,
      );
      await ports.chatPort.complete({
        messages: [{ role: 'user', content: 'q' }],
        ...(requested === undefined ? {} : { maxOutputTokens: requested }),
      });
      expect(events[0]).toMatchObject({
        event: 'reserve',
        reservation: { reserved: { chatOutputTokens: expected } },
      });
      expect(guard.snapshot().usage.chatOutputTokens).toBe(expected);
    },
  );

  test('pins embedding model and rejects invalid output caps before reservation', async () => {
    const embeddingPort: EmbeddingPort = {
      ...unusedEmbedding,
      async embed(request) {
        expect(request.model).toBe('fixture');
        return {
          vector: [1, 0, 0],
          metadata: {
            model: 'fixture',
            dimensions: 3,
            latencyMs: 0,
            usage: { inputTokens: 1, totalTokens: 1 },
          },
        };
      },
    };
    const events: ReleaseBudgetEvent[] = [];
    const guard = createReleaseBudget(history, [], async (event) => {
      events.push(event);
    });
    const ports = wrapReleasePorts(
      { chatPort: unusedChat, embeddingPort },
      fixtureBindings(unusedChat, embeddingPort),
      guard,
    );
    for (const maxOutputTokens of [0, -1, 1.5, NaN, Infinity]) {
      await expect(
        ports.chatPort.complete({ messages: [{ role: 'user', content: 'q' }], maxOutputTokens }),
      ).rejects.toThrow('release_output_cap_invalid');
    }
    expect(events).toHaveLength(0);
    await ports.embeddingPort.embed({ input: 'q' });
    expect(guard.snapshot().usage.embeddingCalls).toBe(1);
  });

  test('rejects a missing terminal newline without appending or repairing the journal', async () => {
    const parent = fileURLToPath(new URL('../../../test-results/', import.meta.url));
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'release-framing-fixture-'));
    const path = join(directory, 'ledger.jsonl');
    const header = JSON.stringify({ historySha256: sha256(JSON.stringify(history)) });
    const events: ReleaseBudgetEvent[] = [
      {
        event: 'reserve',
        reservation: {
          id: 'fixture-1',
          kind: 'embedding',
          requestSha256: sha256('q'),
          reserved: reservation,
        },
      },
      { event: 'settle', id: 'fixture-1', actual: reservation },
    ];
    try {
      for (const text of [
        header,
        [header, ...events.map((event) => JSON.stringify(event))].join('\n'),
      ]) {
        await writeFile(path, text);
        await expect(openReleaseJournal(path, history)).rejects.toThrow(
          'release_journal_incomplete_record',
        );
        expect(await readFile(path, 'utf8')).toBe(text);
      }
    } finally {
      await unlink(path);
      await rmdir(directory);
    }
  });
});
