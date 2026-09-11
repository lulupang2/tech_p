import { randomUUID } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';
import type {
  ChatPort,
  EmbeddingPort,
  ChatCompletionRequest,
  EmbeddingRequest,
} from '@techpulse/domain';
import type { ApiModelBindings } from './runtime-models.js';
import { FIXED_CORPUS, sha256 } from './release-evaluation.js';

export const RELEASE_CAPS = {
  microUsd: 250_000,
  embeddingCalls: 100,
  embeddingInputTokens: 100_000,
  chatCalls: 60,
  chatInputTokens: 300_000,
  chatOutputTokens: 30_000,
} as const;

export type ReleaseUsage = { [K in keyof typeof RELEASE_CAPS]: number };
export const ZERO_USAGE: ReleaseUsage = {
  microUsd: 0,
  embeddingCalls: 0,
  embeddingInputTokens: 0,
  chatCalls: 0,
  chatInputTokens: 0,
  chatOutputTokens: 0,
};
export interface ReleaseHistory {
  readonly schemaVersion: 1;
  readonly decision: 'DEC-013';
  readonly datasetSha256: string;
  readonly reconciled: boolean;
  readonly reconciliationReference: string | null;
  /** A lower bound, NOT exact totals, until all earlier ad-hoc attempts are reconciled. */
  readonly usage: ReleaseUsage;
}
export interface ReleaseAllowance {
  readonly schemaVersion: 1;
  readonly decision: 'DEC-014';
  readonly datasetSha256: string;
  readonly approvedAt: string;
  readonly historySha256: string;
  readonly caps: ReleaseUsage;
  readonly liveExecutionAllowed: true;
}
export interface ReleaseReservation {
  readonly id: string;
  readonly kind: 'embedding' | 'chat';
  readonly requestSha256: string;
  readonly reserved: ReleaseUsage;
}
export type ReleaseBudgetEvent =
  | { readonly event: 'reserve'; readonly reservation: ReleaseReservation }
  | { readonly event: 'settle'; readonly id: string; readonly actual: ReleaseUsage };

function usage(value: unknown): ReleaseUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_release_usage');
  const record = value as Record<string, unknown>;
  const result = { ...ZERO_USAGE };
  for (const key of Object.keys(RELEASE_CAPS) as (keyof ReleaseUsage)[]) {
    const count = record[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('invalid_release_usage');
    }
    result[key] = count;
  }
  return result;
}
function sum(left: ReleaseUsage, right: ReleaseUsage): ReleaseUsage {
  const result = { ...left };
  for (const key of Object.keys(RELEASE_CAPS) as (keyof ReleaseUsage)[]) {
    result[key] += right[key];
    if (!Number.isSafeInteger(result[key])) throw new Error('invalid_release_usage');
  }
  return result;
}
function withinCaps(value: ReleaseUsage, caps: ReleaseUsage = RELEASE_CAPS): boolean {
  return (Object.keys(RELEASE_CAPS) as (keyof ReleaseUsage)[]).every(
    (key) => value[key] <= caps[key],
  );
}
function validateReservation(kind: ReleaseReservation['kind'], value: ReleaseUsage): void {
  const checked = usage(value);
  const valid =
    kind === 'embedding'
      ? checked.embeddingCalls === 1 &&
        checked.embeddingInputTokens > 0 &&
        checked.chatCalls === 0 &&
        checked.chatInputTokens === 0 &&
        checked.chatOutputTokens === 0
      : kind === 'chat' &&
        checked.chatCalls === 1 &&
        checked.chatInputTokens > 0 &&
        checked.chatOutputTokens > 0 &&
        checked.embeddingCalls === 0 &&
        checked.embeddingInputTokens === 0;
  if (!valid || checked.microUsd <= 0) throw new Error('invalid_release_reservation');
}
export function validateReleaseHistory(value: unknown): ReleaseHistory {
  if (!value || typeof value !== 'object') throw new Error('invalid_release_history');
  const record = value as ReleaseHistory;
  if (
    record.schemaVersion !== 1 ||
    record.decision !== 'DEC-013' ||
    record.datasetSha256 !== FIXED_CORPUS.sha256 ||
    typeof record.reconciled !== 'boolean' ||
    (record.reconciliationReference !== null &&
      typeof record.reconciliationReference !== 'string') ||
    (record.reconciled && !record.reconciliationReference?.trim())
  ) {
    throw new Error('invalid_release_history');
  }
  return { ...record, usage: usage(record.usage) };
}

export function validateReleaseAllowance(
  value: unknown,
  history: ReleaseHistory,
): ReleaseAllowance {
  if (!value || typeof value !== 'object') throw new Error('invalid_release_allowance');
  const record = value as ReleaseAllowance;
  const caps = usage(record.caps);
  if (
    record.schemaVersion !== 1 ||
    record.decision !== 'DEC-014' ||
    record.datasetSha256 !== FIXED_CORPUS.sha256 ||
    typeof record.approvedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.approvedAt)) ||
    record.historySha256 !== sha256(JSON.stringify(history)) ||
    record.liveExecutionAllowed !== true ||
    (Object.keys(RELEASE_CAPS) as (keyof ReleaseUsage)[]).some(
      (key) => caps[key] !== RELEASE_CAPS[key],
    )
  ) {
    throw new Error('invalid_release_allowance');
  }
  return { ...record, caps };
}

/** Conservative byte budget, not a claim of an exact provider tokenizer. */
export function embeddingInputUpperBound(request: EmbeddingRequest): number {
  return Buffer.byteLength(request.input, 'utf8') + 64;
}
export function chatInputUpperBound(request: ChatCompletionRequest): number {
  return request.messages.reduce(
    (total, message) =>
      total +
      Buffer.byteLength(message.role, 'utf8') +
      Buffer.byteLength(message.content, 'utf8') +
      64,
    64,
  );
}

function deadline(request: { timeoutMs?: number; signal?: AbortSignal }, cap: number): number {
  const timeout = Math.min(request.timeoutMs ?? cap, cap);
  if (!Number.isFinite(timeout) || timeout <= 0 || request.signal?.aborted) {
    throw new Error('release_deadline_expired');
  }
  return timeout;
}
async function boundedCall<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || signal?.aborted)
    throw new Error('release_deadline_expired');
  const controller = new AbortController();
  let rejectDeadline!: (reason: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  // Install cancellation before dispatch. Reject directly: aborting an already-aborted
  // controller does not emit another event, and upstream ports may ignore cancellation.
  const onAbort = () => {
    rejectDeadline(new Error('release_deadline_expired'));
    controller.abort();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(onAbort, timeoutMs);
  try {
    return await Promise.race([
      cancelled,
      Promise.resolve().then(() => {
        if (signal?.aborted || controller.signal.aborted)
          throw new Error('release_deadline_expired');
        return call(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Durable reservation must succeed BEFORE calling the already DB-budgeted runtime ports. */
export function createReleaseBudget(
  history: ReleaseHistory,
  events: readonly ReleaseBudgetEvent[],
  persist: (event: ReleaseBudgetEvent) => Promise<void>,
  allowance?: ReleaseAllowance,
) {
  const checked = validateReleaseHistory(history);
  const checkedAllowance = allowance ? validateReleaseAllowance(allowance, checked) : null;
  const caps = checkedAllowance?.caps ?? RELEASE_CAPS;
  // A new explicitly approved allowance is a separate tranche. Historical usage is retained
  // for audit but is never reset, subtracted, or added to this tranche's spend counters.
  let total = checkedAllowance ? { ...ZERO_USAGE } : { ...checked.usage };
  const pending = new Map<string, ReleaseReservation>();
  const used = new Set<string>();
  let busy = false;
  let poisoned = false;
  for (const entry of events) {
    if (!entry || (entry.event !== 'reserve' && entry.event !== 'settle'))
      throw new Error('invalid_release_journal');
    if (entry.event === 'reserve') {
      const reservation = entry.reservation;
      if (
        !reservation ||
        typeof reservation.id !== 'string' ||
        used.has(reservation.id) ||
        pending.size ||
        !['chat', 'embedding'].includes(reservation.kind) ||
        !/^[a-f0-9]{64}$/u.test(reservation.requestSha256)
      ) {
        throw new Error('invalid_release_journal');
      }
      validateReservation(reservation.kind, reservation.reserved);
      if (!withinCaps(sum(total, reservation.reserved), caps))
        throw new Error('invalid_release_journal_budget');
      used.add(reservation.id);
      pending.set(reservation.id, reservation);
    } else {
      const reservation = pending.get(entry.id);
      if (!reservation) throw new Error('invalid_release_journal');
      const actual = usage(entry.actual);
      if (
        (Object.keys(RELEASE_CAPS) as (keyof ReleaseUsage)[]).some(
          (key) => actual[key] > reservation.reserved[key],
        ) ||
        actual.chatCalls !== reservation.reserved.chatCalls ||
        actual.embeddingCalls !== reservation.reserved.embeddingCalls
      ) {
        throw new Error('invalid_release_journal');
      }
      total = sum(total, actual);
      pending.delete(entry.id);
    }
  }
  function snapshot() {
    return {
      usage: { ...total },
      outstanding: [...pending.values()].reduce((value, item) => sum(value, item.reserved), {
        ...ZERO_USAGE,
      }),
      unknownReservations: pending.size,
      historyReconciled: checked.reconciled,
      historicalUsage: { ...checked.usage },
      budgetScope: checkedAllowance ? ('additional_allowance' as const) : ('legacy_total' as const),
      allowanceDecision: checkedAllowance?.decision ?? null,
      caps: { ...caps },
      exceededCaps: (Object.keys(RELEASE_CAPS) as (keyof ReleaseUsage)[]).filter(
        (key) => total[key] > caps[key],
      ),
    };
  }
  function assertReady() {
    if (!withinCaps(total, caps)) throw new Error('release_budget_exhausted');
    // Legacy DEC-013 admission remains fail-closed. DEC-014 explicitly authorizes a separate
    // tranche even though the older aggregate history is intentionally still unreconciled.
    if (!checkedAllowance && !checked.reconciled) throw new Error('release_history_unreconciled');
    if (poisoned || pending.size) throw new Error('release_outcome_unknown');
  }
  async function execute<T>(
    kind: ReleaseReservation['kind'],
    requestSha256: string,
    reserved: ReleaseUsage,
    call: () => Promise<T>,
    actualUsage: (result: T) => ReleaseUsage,
  ): Promise<T> {
    assertReady();
    if (busy) throw new Error('release_concurrency_exceeded');
    usage(reserved);
    if (!withinCaps(sum(total, reserved), caps)) throw new Error('release_budget_exhausted');
    validateReservation(kind, reserved);
    if (!/^[a-f0-9]{64}$/u.test(requestSha256)) throw new Error('invalid_release_request_hash');
    busy = true;
    const reservation: ReleaseReservation = { id: randomUUID(), kind, requestSha256, reserved };
    try {
      await persist({ event: 'reserve', reservation });
      pending.set(reservation.id, reservation);
      const result = await call();
      const actual = usage(actualUsage(result));
      if (
        (Object.keys(RELEASE_CAPS) as (keyof ReleaseUsage)[]).some(
          (key) => actual[key] > reserved[key],
        ) ||
        actual.chatCalls !== reserved.chatCalls ||
        actual.embeddingCalls !== reserved.embeddingCalls
      ) {
        throw new Error('release_provider_usage_exceeded_reservation');
      }
      await persist({ event: 'settle', id: reservation.id, actual });
      total = sum(total, actual);
      pending.delete(reservation.id);
      return result;
    } catch {
      // Do not store raw errors, release uncertain funds, retry, or choose another provider.
      poisoned = true;
      throw new Error('release_call_failed_or_outcome_unknown');
    } finally {
      busy = false;
    }
  }
  return { snapshot, assertReady, execute };
}

export function wrapReleasePorts(
  ports: { chatPort: ChatPort; embeddingPort: EmbeddingPort },
  bindings: ApiModelBindings,
  budget: ReturnType<typeof createReleaseBudget>,
) {
  const embedding = bindings.embedding;
  if (!embedding) throw new Error('release_embedding_binding_required');
  const money = (tokens: number, rate: number) => Math.ceil((tokens * rate) / 1000);
  const embeddingPort: EmbeddingPort = {
    async embed(request) {
      const timeoutMs = deadline(request, embedding.caps.timeoutMs ?? 10_000);
      const expiresAt = Date.now() + timeoutMs;
      if (request.model && request.model !== embedding.profile.model)
        throw new Error('release_model_mismatch');
      const input = embeddingInputUpperBound(request);
      if (input > embedding.caps.maxInputTokens) throw new Error('release_input_cap_exceeded');
      return budget.execute(
        'embedding',
        sha256(request.input),
        {
          ...ZERO_USAGE,
          embeddingCalls: 1,
          embeddingInputTokens: input,
          microUsd: money(input, embedding.priceRate.unitsPerThousandTokens),
        },
        () =>
          boundedCall(expiresAt - Date.now(), request.signal, (signal) =>
            ports.embeddingPort.embed({
              ...request,
              model: embedding.profile.model,
              timeoutMs,
              signal,
            }),
          ),
        (result) => {
          const reported = result.metadata.usage;
          if (
            result.metadata.model !== embedding.profile.model ||
            result.metadata.dimensions !== embedding.profile.dimensions ||
            result.vector.length !== embedding.profile.dimensions ||
            reported.totalTokens !== reported.inputTokens ||
            !result.vector.every(Number.isFinite) ||
            !result.vector.some((value) => value !== 0)
          ) {
            throw new Error('release_provider_contract_violation');
          }
          return {
            ...ZERO_USAGE,
            embeddingCalls: 1,
            embeddingInputTokens: reported.inputTokens,
            microUsd: money(reported.inputTokens, embedding.priceRate.unitsPerThousandTokens),
          };
        },
      );
    },
    async embedMany() {
      throw new Error('release_batch_forbidden');
    },
  };
  const chatPort: ChatPort = {
    async complete(request) {
      const timeoutMs = deadline(request, bindings.chat.caps.timeoutMs ?? 15_000);
      const expiresAt = Date.now() + timeoutMs;
      if (request.model && request.model !== bindings.chat.profile.model)
        throw new Error('release_model_mismatch');
      const input = chatInputUpperBound(request);
      const outputCap = bindings.chat.caps.maxOutputTokens;
      if (
        !outputCap ||
        !Number.isSafeInteger(outputCap) ||
        outputCap <= 0 ||
        input > bindings.chat.caps.maxInputTokens
      )
        throw new Error('release_input_cap_exceeded');
      if (
        request.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)
      ) {
        throw new Error('release_output_cap_invalid');
      }
      const output = Math.min(request.maxOutputTokens ?? outputCap, outputCap);
      return budget.execute(
        'chat',
        sha256(JSON.stringify(request.messages)),
        {
          ...ZERO_USAGE,
          chatCalls: 1,
          chatInputTokens: input,
          chatOutputTokens: output,
          microUsd: money(input + output, bindings.chat.priceRate.unitsPerThousandTokens),
        },
        () =>
          boundedCall(expiresAt - Date.now(), request.signal, (signal) =>
            ports.chatPort.complete({
              ...request,
              model: bindings.chat.profile.model,
              maxOutputTokens: output,
              responseFormat: 'json_object',
              timeoutMs,
              signal,
            }),
          ),
        (result) => {
          const reported = result.metadata.usage;
          if (
            result.metadata.model !== bindings.chat.profile.model ||
            reported.totalTokens !== reported.inputTokens + reported.outputTokens
          ) {
            throw new Error('release_provider_contract_violation');
          }
          return {
            ...ZERO_USAGE,
            chatCalls: 1,
            chatInputTokens: reported.inputTokens,
            chatOutputTokens: reported.outputTokens,
            microUsd: money(reported.totalTokens, bindings.chat.priceRate.unitsPerThousandTokens),
          };
        },
      );
    },
  };
  return { embeddingPort, chatPort };
}

/**
 * Existing append-only journal only: no auto-initialization/reset switch. One canonical
 * checkout owns the journal. Crash locks and unfinished reservations require reconciliation.
 */
export async function openReleaseJournal(
  path: string,
  history: ReleaseHistory,
  allowance?: ReleaseAllowance,
) {
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, 'wx');
  try {
    const text = await readFile(path, 'utf8');
    if (!text.endsWith('\n')) throw new Error('release_journal_incomplete_record');
    const lines = text.slice(0, -1).split('\n');
    const header = JSON.parse(lines[0] ?? '') as {
      historySha256?: unknown;
      allowanceSha256?: unknown;
    };
    if (header.historySha256 !== sha256(JSON.stringify(history)))
      throw new Error('release_journal_history_mismatch');
    if (
      allowance &&
      header.allowanceSha256 !==
        sha256(JSON.stringify(validateReleaseAllowance(allowance, history)))
    ) {
      throw new Error('release_journal_allowance_mismatch');
    }
    const events = lines.slice(1).map((line) => JSON.parse(line) as ReleaseBudgetEvent);
    const file = await open(path, 'a');
    try {
      const budget = createReleaseBudget(
        history,
        events,
        async (event) => {
          await file.writeFile(`${JSON.stringify(event)}\n`);
          await file.sync();
        },
        allowance,
      );
      let closed = false;
      return {
        budget,
        async close() {
          if (closed) return;
          closed = true;
          await file.close();
          await lock.close();
          await unlink(lockPath);
        },
      };
    } catch (error) {
      await file.close();
      throw error;
    }
  } catch (error) {
    await lock.close();
    await unlink(lockPath);
    throw error;
  }
}
