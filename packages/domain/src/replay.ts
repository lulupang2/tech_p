export type ReplayScope = 'run' | 'raw' | 'stage';
export type ReplayStage = 'normalization' | 'deduplication';
export type ReplayStatus = 'queued' | 'duplicate' | 'skipped_disabled' | 'quarantined';
export type FailureDisposition = 'retryable' | 'quarantined' | 'dead_letter';

export interface ReplayRequest {
  readonly scope: ReplayScope;
  readonly targetId: string;
  readonly stage?: ReplayStage;
  readonly requestedAt: Date;
}

export interface ReplayJob {
  readonly schemaVersion: 1;
  readonly replayId: string;
  readonly naturalKey: string;
  readonly scope: ReplayScope;
  readonly targetId: string;
  readonly stage: ReplayStage;
  readonly requestedAt: string;
}

export interface ReplayResult {
  readonly status: ReplayStatus;
  readonly jobs: readonly ReplayJob[];
}

export interface ReplayPublisherPort {
  readonly publish: (job: ReplayJob) => Promise<{ readonly duplicate: boolean }>;
}

export interface ReplayAuditEvent {
  readonly action: 'replay';
  readonly scope: ReplayScope;
  readonly targetId: string;
  readonly status: ReplayStatus | 'failed';
  readonly errorSummary?: string;
  readonly occurredAt: Date;
}

export interface ReplayAuditPort {
  readonly record: (event: ReplayAuditEvent) => Promise<void>;
}

export function redactErrorSummary(error: unknown, maxLength = 256): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(token|secret|password|cookie|authorization)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, maxLength);
}

export function classifyFailure(
  error: unknown,
  attemptsMade: number,
  maxAttempts: number,
): FailureDisposition {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  const transient =
    Boolean(
      typeof error === 'object' &&
      error !== null &&
      'isTransient' in error &&
      (error as { isTransient?: unknown }).isTransient,
    ) || code === 'TRANSIENT_ERROR';
  if (transient && attemptsMade < maxAttempts) return 'retryable';
  if (transient) return 'dead_letter';
  return 'quarantined';
}

export class ReplayTargetNotFoundError extends Error {
  readonly code = 'REPLAY_TARGET_NOT_FOUND';
}

export class InvalidReplayRequestError extends Error {
  readonly code = 'INVALID_REPLAY_REQUEST';
}

export interface ReplayTargetPort {
  readonly isEnabled: (scope: ReplayScope, targetId: string) => Promise<boolean>;
  readonly exists: (scope: ReplayScope, targetId: string) => Promise<boolean>;
}

export function createReplayService(options: {
  readonly targets: ReplayTargetPort;
  readonly publisher: ReplayPublisherPort;
  readonly audit?: ReplayAuditPort;
}): { readonly replay: (request: ReplayRequest) => Promise<ReplayResult> } {
  return {
    async replay(request) {
      if (!request.targetId || !Number.isFinite(request.requestedAt.getTime()))
        throw new InvalidReplayRequestError('Invalid replay request');
      const stage = request.stage ?? 'normalization';
      if (request.scope === 'stage' && !request.stage)
        throw new InvalidReplayRequestError('Stage replay requires stage');
      if (!(await options.targets.exists(request.scope, request.targetId)))
        throw new ReplayTargetNotFoundError(request.targetId);
      if (!(await options.targets.isEnabled(request.scope, request.targetId))) {
        const result = { status: 'skipped_disabled' as const, jobs: [] };
        await options.audit?.record({
          action: 'replay',
          scope: request.scope,
          targetId: request.targetId,
          status: result.status,
          occurredAt: new Date(request.requestedAt),
        });
        return result;
      }
      const requestedAt = request.requestedAt.toISOString();
      const naturalKey = `replay:v1:${request.scope}:${request.targetId}:${stage}`;
      const job: ReplayJob = {
        schemaVersion: 1,
        replayId: naturalKey,
        naturalKey,
        scope: request.scope,
        targetId: request.targetId,
        stage,
        requestedAt,
      };
      const published = await options.publisher.publish(job);
      const status = published.duplicate ? 'duplicate' : 'queued';
      await options.audit?.record({
        action: 'replay',
        scope: request.scope,
        targetId: request.targetId,
        status,
        occurredAt: new Date(request.requestedAt),
      });
      return { status, jobs: [job] };
    },
  };
}
