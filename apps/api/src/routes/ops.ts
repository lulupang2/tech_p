import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { type StructuredLogger } from '@techpulse/observability';
import {
  type SourceRepositoryPort,
  type CollectionRunRepositoryPort,
  type ReplayRequest,
  type ReplayResult,
  type TombstoneServicePort,
  type CollectionRunRecord,
  type CollectionRunStatus,
} from '@techpulse/domain';
import { Elysia, t } from 'elysia';
import { ApiHttpError } from '../errors.js';
import { resolveRequestCorrelation } from '../correlation.js';

export interface IdempotencyEntry {
  readonly payloadHash: string;
  readonly statusCode: number;
  readonly response: unknown;
  readonly createdAt: number;
}

export interface IdempotencyStore {
  readonly get: (
    key: string,
  ) => Promise<IdempotencyEntry | undefined> | IdempotencyEntry | undefined;
  readonly set: (key: string, entry: IdempotencyEntry) => Promise<void> | void;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get(key: string): IdempotencyEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, entry: IdempotencyEntry): void {
    this.entries.set(key, entry);
  }
}

export interface OpsAuditEvent {
  readonly schemaVersion: 1;
  readonly event: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly service: 'api-ops';
  readonly timestamp: string;
  readonly requestId: string;
  readonly actor: string;
  readonly action: string;
  readonly target?: string | undefined;
  readonly data: Record<string, unknown>;
}

export function timingSafeCompare(provided: string, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const bufProvided = Buffer.from(provided, 'utf-8');
  const bufExpected = Buffer.from(expected, 'utf-8');
  if (bufProvided.length !== bufExpected.length) return false;
  return timingSafeEqual(bufProvided, bufExpected);
}

function canonicalizePayload(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizePayload);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) {
    sorted[k] = canonicalizePayload(obj[k]);
  }
  return sorted;
}

export function computePayloadHash(payload: unknown): string {
  const str = JSON.stringify(canonicalizePayload(payload));
  return createHash('sha256').update(str).digest('hex');
}

export function sanitizeAuditData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const isSensitive =
      /(api_?key|secret|password|bearer|authorization|cookie|session|database_url|db_url)/iu.test(
        key,
      ) && !['sourceKey', 'targetKey', 'idempotencyKey'].includes(key);

    if (isSensitive) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeAuditData(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export interface CollectionDispatchRequest {
  readonly collectionRunId: string;
  readonly sourceKey: string;
  readonly cursor: string | null;
  readonly scheduledAt: Date;
}

export interface CollectionDispatcher {
  readonly dispatch: (request: CollectionDispatchRequest) => Promise<void>;
}

export interface OpsRouteOptions {
  readonly opsApiKey?: string | undefined;
  readonly sourceRepository?: SourceRepositoryPort | undefined;
  readonly collectionRunRepository?: CollectionRunRepositoryPort | undefined;
  readonly collectionDispatcher?: CollectionDispatcher | undefined;
  readonly replayService?:
    { readonly replay: (request: ReplayRequest) => Promise<ReplayResult> } | undefined;
  readonly tombstoneService?: TombstoneServicePort | undefined;
  readonly logger?: StructuredLogger | undefined;
  readonly auditSink?: ((event: OpsAuditEvent) => void | Promise<void>) | undefined;
  readonly idempotencyStore?: IdempotencyStore | undefined;
}

export function createOpsRoutes(options: OpsRouteOptions = {}) {
  const idempotencyStore = options.idempotencyStore ?? new MemoryIdempotencyStore();

  const emitAudit = async (event: OpsAuditEvent) => {
    options.logger?.withContext({ requestId: event.requestId }).info(event.event, {
      actor: event.actor,
      action: event.action,
      target: event.target,
      ...event.data,
    });
    if (options.auditSink) {
      try {
        await options.auditSink(event);
      } catch {
        // Safe sink failure ignore
      }
    }
  };

  const handleIdempotency = async <T>(
    idempotencyKey: string | null | undefined,
    payload: unknown,
    handler: () => Promise<T>,
  ): Promise<T> => {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new ApiHttpError({
        code: 'INVALID_REQUEST',
        status: 400,
        message: 'Idempotency-Key header is required for operations mutations',
        details: [{ path: 'headers.idempotency-key', reason: 'missing_idempotency_key' }],
      });
    }

    const payloadHash = computePayloadHash(payload);
    const existing = await idempotencyStore.get(idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ApiHttpError({
          code: 'IDEMPOTENCY_CONFLICT',
          status: 409,
          message: 'Idempotency key was already used with a different request payload',
          details: [{ path: 'headers.idempotency-key', reason: 'payload_mismatch' }],
        });
      }
      return existing.response as T;
    }

    const result = await handler();
    await idempotencyStore.set(idempotencyKey, {
      payloadHash,
      statusCode: 200,
      response: result,
      createdAt: Date.now(),
    });
    return result;
  };

  return new Elysia({ prefix: '/ops' })
    .onBeforeHandle(({ request }) => {
      const authHeader = request.headers.get('authorization');
      if (!authHeader) {
        throw new ApiHttpError({
          code: 'UNAUTHENTICATED',
          status: 401,
          message: 'Authentication required for operations endpoint',
        });
      }

      const expectedToken = options.opsApiKey || process.env['OPS_API_KEY'];
      if (!expectedToken) {
        throw new ApiHttpError({
          code: 'FORBIDDEN',
          status: 403,
          message: 'Operations endpoint is not configured or disabled',
        });
      }

      const match = /^Bearer\s+(.+)$/iu.exec(authHeader);
      const token = match ? match[1] : authHeader;

      if (!token || !timingSafeCompare(token, expectedToken)) {
        throw new ApiHttpError({
          code: 'FORBIDDEN',
          status: 403,
          message: 'Invalid operations authorization token',
        });
      }
    })
    .get('/status', () => {
      return {
        status: 'ok',
        service: 'api-ops',
        timestamp: new Date().toISOString(),
      };
    })
    .get(
      '/collection-runs',
      async ({ query, request }) => {
        const correlation = resolveRequestCorrelation(request);
        const limitNum = query.limit !== undefined ? Number(query.limit) : 20;
        if (Number.isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
          throw new ApiHttpError({
            code: 'INVALID_REQUEST',
            status: 400,
            message: 'limit must be an integer between 1 and 100',
            details: [{ path: 'limit', reason: 'out_of_bounds' }],
          });
        }

        let fromDate: Date | undefined;
        if (query.from) {
          const d = new Date(query.from);
          if (Number.isNaN(d.getTime())) {
            throw new ApiHttpError({
              code: 'INVALID_REQUEST',
              status: 400,
              message: 'Invalid ISO date for from parameter',
              details: [{ path: 'from', reason: 'invalid_date' }],
            });
          }
          fromDate = d;
        }

        let toDate: Date | undefined;
        if (query.to) {
          const d = new Date(query.to);
          if (Number.isNaN(d.getTime())) {
            throw new ApiHttpError({
              code: 'INVALID_REQUEST',
              status: 400,
              message: 'Invalid ISO date for to parameter',
              details: [{ path: 'to', reason: 'invalid_date' }],
            });
          }
          toDate = d;
        }

        if (fromDate && toDate && toDate.getTime() < fromDate.getTime()) {
          throw new ApiHttpError({
            code: 'INVALID_TIME_RANGE',
            status: 400,
            message: 'to must be after from',
            details: [{ path: 'to', reason: 'must_be_after_from' }],
          });
        }

        let sourceId: string | undefined;
        if (query.sourceKey && options.sourceRepository) {
          const src = await options.sourceRepository.findByKey(query.sourceKey);
          if (src) {
            sourceId = src.id;
          } else {
            // Source key does not exist -> return empty list
            return {
              requestId: correlation.requestId,
              items: [],
            };
          }
        }

        let items: readonly CollectionRunRecord[] = [];
        if (options.collectionRunRepository?.list) {
          items = await options.collectionRunRepository.list({
            ...(sourceId !== undefined ? { sourceId } : {}),
            ...(query.status !== undefined ? { status: query.status as CollectionRunStatus } : {}),
            ...(fromDate !== undefined ? { from: fromDate } : {}),
            ...(toDate !== undefined ? { to: toDate } : {}),
            limit: limitNum,
            ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
          });
        }

        return {
          requestId: correlation.requestId,
          items: items.map((r) => ({
            id: r.id,
            sourceId: r.sourceId,
            scheduledAt: r.scheduledAt.toISOString(),
            startedAt: r.startedAt ? r.startedAt.toISOString() : null,
            endedAt: r.endedAt ? r.endedAt.toISOString() : null,
            status: r.status,
            counts: r.counts,
            errorSummary: r.errorSummary,
            createdAt: r.createdAt ? r.createdAt.toISOString() : undefined,
          })),
        };
      },
      {
        query: t.Object({
          sourceKey: t.Optional(t.String()),
          status: t.Optional(t.String()),
          from: t.Optional(t.String()),
          to: t.Optional(t.String()),
          limit: t.Optional(t.Union([t.String(), t.Number()])),
          cursor: t.Optional(t.String()),
        }),
      },
    )
    .get(
      '/collection-runs/:id',
      async ({ params, request }) => {
        const correlation = resolveRequestCorrelation(request);
        if (!options.collectionRunRepository) {
          throw new ApiHttpError({
            code: 'NOT_FOUND',
            status: 404,
            message: `Collection run '${params.id}' was not found`,
          });
        }

        const run = await options.collectionRunRepository.findById(params.id);
        if (!run) {
          throw new ApiHttpError({
            code: 'NOT_FOUND',
            status: 404,
            message: `Collection run '${params.id}' was not found`,
          });
        }

        return {
          requestId: correlation.requestId,
          run: {
            id: run.id,
            sourceId: run.sourceId,
            scheduledAt: run.scheduledAt.toISOString(),
            startedAt: run.startedAt ? run.startedAt.toISOString() : null,
            endedAt: run.endedAt ? run.endedAt.toISOString() : null,
            status: run.status,
            cursorBefore: run.cursorBefore,
            cursorAfter: run.cursorAfter,
            counts: run.counts,
            errorSummary: run.errorSummary,
            createdAt: run.createdAt ? run.createdAt.toISOString() : undefined,
          },
        };
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )
    .post(
      '/collection-runs',
      async ({ body, request }) => {
        const correlation = resolveRequestCorrelation(request);
        const idempotencyKey = request.headers.get('idempotency-key');
        const actor = request.headers.get('x-actor') || 'operator';

        return handleIdempotency(idempotencyKey, body, async () => {
          if (body.limit !== undefined && (body.limit < 1 || body.limit > 500)) {
            throw new ApiHttpError({
              code: 'INVALID_REQUEST',
              status: 400,
              message: 'Collection limit must be between 1 and 500',
              details: [{ path: 'limit', reason: 'out_of_bounds' }],
            });
          }

          let sourceId = body.sourceKey;
          if (options.sourceRepository) {
            const src = await options.sourceRepository.findByKey(body.sourceKey);
            if (!src) {
              throw new ApiHttpError({
                code: 'NOT_FOUND',
                status: 404,
                message: `Source '${body.sourceKey}' was not found`,
              });
            }
            if (src.enabled === false) {
              throw new ApiHttpError({
                code: 'INVALID_REQUEST',
                status: 400,
                message: `Source '${body.sourceKey}' is disabled and cannot be collected`,
              });
            }
            sourceId = src.id;
          }

          const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : new Date();
          let createdRunId = `run_${randomUUID().replace(/-/gu, '')}`;

          if (options.collectionRunRepository && !body.dryRun) {
            const created = await options.collectionRunRepository.create({
              sourceId,
              scheduledAt,
              status: 'pending',
              cursorBefore: body.cursor ?? null,
              counts: {},
            });
            createdRunId = created.id;
          }

          if (options.collectionDispatcher && !body.dryRun) {
            try {
              await options.collectionDispatcher.dispatch({
                collectionRunId: createdRunId,
                sourceKey: body.sourceKey,
                cursor: body.cursor ?? null,
                scheduledAt,
              });
            } catch {
              if (options.collectionRunRepository) {
                await options.collectionRunRepository.update(createdRunId, {
                  status: 'failed',
                  endedAt: new Date(),
                  errorSummary: 'Collection job dispatch failed',
                });
              }
              throw new ApiHttpError({
                code: 'DEPENDENCY_UNAVAILABLE',
                status: 503,
                message: 'Collection queue is unavailable',
              });
            }
          }

          const auditEvent: OpsAuditEvent = {
            schemaVersion: 1,
            event: 'ops.collection_run.triggered',
            level: 'info',
            service: 'api-ops',
            timestamp: new Date().toISOString(),
            requestId: correlation.requestId,
            actor,
            action: 'collection_run',
            target: body.sourceKey,
            data: sanitizeAuditData({
              runId: createdRunId,
              sourceKey: body.sourceKey,
              limit: body.limit,
              dryRun: Boolean(body.dryRun),
            }),
          };
          await emitAudit(auditEvent);

          return {
            status: 'accepted',
            runId: createdRunId,
            sourceKey: body.sourceKey,
            scheduledAt: scheduledAt.toISOString(),
            counts: {},
            dryRun: Boolean(body.dryRun),
          };
        });
      },
      {
        body: t.Object({
          sourceKey: t.String({ minLength: 1 }),
          limit: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
          cursor: t.Optional(t.String({ maxLength: 4096 })),
          scheduledAt: t.Optional(t.String()),
          dryRun: t.Optional(t.Boolean()),
        }),
      },
    )
    .post(
      '/pipeline-replays',
      async ({ body, request }) => {
        const correlation = resolveRequestCorrelation(request);
        const idempotencyKey = request.headers.get('idempotency-key');
        const actor = request.headers.get('x-actor') || 'operator';

        return handleIdempotency(idempotencyKey, body, async () => {
          if (body.scope === 'stage' && !body.stage) {
            throw new ApiHttpError({
              code: 'INVALID_REQUEST',
              status: 400,
              message: 'stage is required when scope is stage',
              details: [{ path: 'stage', reason: 'missing_stage' }],
            });
          }

          if (body.limit !== undefined && (body.limit < 1 || body.limit > 500)) {
            throw new ApiHttpError({
              code: 'INVALID_REQUEST',
              status: 400,
              message: 'limit must be between 1 and 500',
              details: [{ path: 'limit', reason: 'out_of_bounds' }],
            });
          }

          const stage = body.stage ?? 'normalization';
          const naturalKey = `replay:v1:${body.scope}:${body.targetId}:${stage}`;

          let replayStatus: string = 'accepted';
          let jobsCount = 1;

          if (options.replayService && !body.dryRun) {
            try {
              const res = await options.replayService.replay({
                scope: body.scope as 'run' | 'raw' | 'stage',
                targetId: body.targetId,
                stage: stage as 'normalization' | 'deduplication',
                requestedAt: new Date(),
              });
              replayStatus = res.status;
              jobsCount = res.jobs.length;
            } catch (err: unknown) {
              const error = err as { code?: string; message?: string };
              if (error.code === 'REPLAY_TARGET_NOT_FOUND') {
                throw new ApiHttpError({
                  code: 'NOT_FOUND',
                  status: 404,
                  message: `Replay target '${body.targetId}' was not found`,
                });
              }
              if (error.code === 'INVALID_REPLAY_REQUEST') {
                throw new ApiHttpError({
                  code: 'INVALID_REQUEST',
                  status: 400,
                  message: error.message || 'Invalid replay request',
                });
              }
              throw err;
            }
          }

          const auditEvent: OpsAuditEvent = {
            schemaVersion: 1,
            event: 'ops.pipeline_replay.requested',
            level: 'info',
            service: 'api-ops',
            timestamp: new Date().toISOString(),
            requestId: correlation.requestId,
            actor,
            action: 'pipeline_replay',
            target: body.targetId,
            data: sanitizeAuditData({
              replayId: naturalKey,
              scope: body.scope,
              targetId: body.targetId,
              stage,
              status: replayStatus,
              dryRun: Boolean(body.dryRun),
            }),
          };
          await emitAudit(auditEvent);

          return {
            status: replayStatus,
            replayId: naturalKey,
            scope: body.scope,
            targetId: body.targetId,
            stage,
            jobsCount,
            dryRun: Boolean(body.dryRun),
          };
        });
      },
      {
        body: t.Object({
          scope: t.Union([t.Literal('run'), t.Literal('raw'), t.Literal('stage')]),
          targetId: t.String({ minLength: 1, maxLength: 128 }),
          stage: t.Optional(t.Union([t.Literal('normalization'), t.Literal('deduplication')])),
          limit: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
          dryRun: t.Optional(t.Boolean()),
        }),
      },
    )
    .post(
      '/replay',
      async ({ body, request }) => {
        // Alias for /pipeline-replays with simplified payload
        const correlation = resolveRequestCorrelation(request);
        const idempotencyKey = request.headers.get('idempotency-key');
        const actor = request.headers.get('x-actor') || 'operator';

        return handleIdempotency(idempotencyKey, body, async () => {
          const scope = body.scope ?? 'run';
          const targetId = body.targetId || body.sourceKey || '';
          if (!targetId) {
            throw new ApiHttpError({
              code: 'INVALID_REQUEST',
              status: 400,
              message: 'targetId or sourceKey is required for replay',
            });
          }
          const stage = body.stage ?? 'normalization';
          const naturalKey = `replay:v1:${scope}:${targetId}:${stage}`;
          let replayStatus = 'accepted';
          let jobsCount = 1;
          if (options.replayService && !body.dryRun) {
            try {
              const res = await options.replayService.replay({
                scope: scope as 'run' | 'raw' | 'stage',
                targetId,
                stage: stage as 'normalization' | 'deduplication',
                requestedAt: new Date(),
              });
              replayStatus = res.status;
              jobsCount = res.jobs.length;
            } catch (err: unknown) {
              const error = err as { code?: string; message?: string };
              if (error.code === 'REPLAY_TARGET_NOT_FOUND') {
                throw new ApiHttpError({
                  code: 'NOT_FOUND',
                  status: 404,
                  message: `Replay target '${targetId}' was not found`,
                });
              }
              throw err;
            }
          }

          const auditEvent: OpsAuditEvent = {
            schemaVersion: 1,
            event: 'ops.pipeline_replay.requested',
            level: 'info',
            service: 'api-ops',
            timestamp: new Date().toISOString(),
            requestId: correlation.requestId,
            actor,
            action: 'pipeline_replay',
            target: targetId,
            data: sanitizeAuditData({
              replayId: naturalKey,
              sourceKey: body.sourceKey,
              scope,
              targetId,
              stage,
              status: replayStatus,
              dryRun: Boolean(body.dryRun),
            }),
          };
          await emitAudit(auditEvent);

          return {
            status: replayStatus,
            replayId: naturalKey,
            sourceKey: body.sourceKey,
            scope,
            targetId,
            stage,
            jobsCount,
            dryRun: Boolean(body.dryRun),
          };
        });
      },
      {
        body: t.Object({
          sourceKey: t.Optional(t.String()),
          scope: t.Optional(t.Union([t.Literal('run'), t.Literal('raw'), t.Literal('stage')])),
          targetId: t.Optional(t.String()),
          stage: t.Optional(t.Union([t.Literal('normalization'), t.Literal('deduplication')])),
          dryRun: t.Optional(t.Boolean()),
        }),
      },
    )
    .post(
      '/sources/:key/enable',
      async ({ params, body, request }) => {
        const correlation = resolveRequestCorrelation(request);
        const idempotencyKey = request.headers.get('idempotency-key');
        const actor = request.headers.get('x-actor') || 'operator';
        const requestedBy = body?.requestedBy || actor;

        return handleIdempotency(
          idempotencyKey,
          { action: 'enable', key: params.key, ...body },
          async () => {
            if (options.sourceRepository) {
              const src = await options.sourceRepository.findByKey(params.key);
              if (!src) {
                throw new ApiHttpError({
                  code: 'NOT_FOUND',
                  status: 404,
                  message: `Source '${params.key}' was not found`,
                });
              }
            }

            if (options.tombstoneService) {
              try {
                await options.tombstoneService.reindex('source', params.key, requestedBy);
              } catch {
                // Service may handle target
              }
            }

            if (options.sourceRepository?.updateEnabled) {
              await options.sourceRepository.updateEnabled(params.key, true);
            }

            const auditEvent: OpsAuditEvent = {
              schemaVersion: 1,
              event: 'ops.source.enabled',
              level: 'info',
              service: 'api-ops',
              timestamp: new Date().toISOString(),
              requestId: correlation.requestId,
              actor: requestedBy,
              action: 'source_enable',
              target: params.key,
              data: sanitizeAuditData({
                sourceKey: params.key,
                enabled: true,
                requestedBy,
              }),
            };
            await emitAudit(auditEvent);

            return {
              status: 'ok',
              sourceKey: params.key,
              enabled: true,
              timestamp: new Date().toISOString(),
            };
          },
        );
      },
      {
        params: t.Object({
          key: t.String(),
        }),
        body: t.Optional(
          t.Object({
            requestedBy: t.Optional(t.String()),
          }),
        ),
      },
    )
    .post(
      '/sources/:key/disable',
      async ({ params, body, request }) => {
        const correlation = resolveRequestCorrelation(request);
        const idempotencyKey = request.headers.get('idempotency-key');
        const actor = request.headers.get('x-actor') || 'operator';
        const requestedBy = body?.requestedBy || actor;
        const reason = body?.reason || 'Disabled via operations interface';

        return handleIdempotency(
          idempotencyKey,
          { action: 'disable', key: params.key, ...body },
          async () => {
            if (options.sourceRepository) {
              const src = await options.sourceRepository.findByKey(params.key);
              if (!src) {
                throw new ApiHttpError({
                  code: 'NOT_FOUND',
                  status: 404,
                  message: `Source '${params.key}' was not found`,
                });
              }
            }

            if (options.tombstoneService) {
              try {
                await options.tombstoneService.createTombstone({
                  scope: 'source',
                  targetKey: params.key,
                  reason,
                  requestedBy,
                });
              } catch {
                // Service handling
              }
            }

            if (options.sourceRepository?.updateEnabled) {
              await options.sourceRepository.updateEnabled(params.key, false);
            }

            const auditEvent: OpsAuditEvent = {
              schemaVersion: 1,
              event: 'ops.source.disabled',
              level: 'info',
              service: 'api-ops',
              timestamp: new Date().toISOString(),
              requestId: correlation.requestId,
              actor: requestedBy,
              action: 'source_disable',
              target: params.key,
              data: sanitizeAuditData({
                sourceKey: params.key,
                enabled: false,
                reason,
                requestedBy,
              }),
            };
            await emitAudit(auditEvent);

            return {
              status: 'ok',
              sourceKey: params.key,
              enabled: false,
              timestamp: new Date().toISOString(),
            };
          },
        );
      },
      {
        params: t.Object({
          key: t.String(),
        }),
        body: t.Optional(
          t.Object({
            reason: t.Optional(t.String()),
            requestedBy: t.Optional(t.String()),
          }),
        ),
      },
    )
    .patch(
      '/sources/:key',
      async ({ params, body, request }) => {
        const correlation = resolveRequestCorrelation(request);
        const idempotencyKey = request.headers.get('idempotency-key');
        const actor = request.headers.get('x-actor') || 'operator';
        const requestedBy = body.requestedBy || actor;

        return handleIdempotency(
          idempotencyKey,
          { action: 'patch', key: params.key, ...body },
          async () => {
            if (options.sourceRepository) {
              const src = await options.sourceRepository.findByKey(params.key);
              if (!src) {
                throw new ApiHttpError({
                  code: 'NOT_FOUND',
                  status: 404,
                  message: `Source '${params.key}' was not found`,
                });
              }
            }

            if (body.enabled) {
              if (options.tombstoneService) {
                try {
                  await options.tombstoneService.reindex('source', params.key, requestedBy);
                } catch {
                  // Ignore
                }
              }
              if (options.sourceRepository?.updateEnabled) {
                await options.sourceRepository.updateEnabled(params.key, true);
              }

              const auditEvent: OpsAuditEvent = {
                schemaVersion: 1,
                event: 'ops.source.enabled',
                level: 'info',
                service: 'api-ops',
                timestamp: new Date().toISOString(),
                requestId: correlation.requestId,
                actor: requestedBy,
                action: 'source_enable',
                target: params.key,
                data: sanitizeAuditData({
                  sourceKey: params.key,
                  enabled: true,
                  requestedBy,
                }),
              };
              await emitAudit(auditEvent);
            } else {
              const reason = body.reason || 'Disabled via operations interface';
              if (options.tombstoneService) {
                try {
                  await options.tombstoneService.createTombstone({
                    scope: 'source',
                    targetKey: params.key,
                    reason,
                    requestedBy,
                  });
                } catch {
                  // Ignore
                }
              }
              if (options.sourceRepository?.updateEnabled) {
                await options.sourceRepository.updateEnabled(params.key, false);
              }

              const auditEvent: OpsAuditEvent = {
                schemaVersion: 1,
                event: 'ops.source.disabled',
                level: 'info',
                service: 'api-ops',
                timestamp: new Date().toISOString(),
                requestId: correlation.requestId,
                actor: requestedBy,
                action: 'source_disable',
                target: params.key,
                data: sanitizeAuditData({
                  sourceKey: params.key,
                  enabled: false,
                  reason,
                  requestedBy,
                }),
              };
              await emitAudit(auditEvent);
            }

            return {
              status: 'ok',
              sourceKey: params.key,
              enabled: body.enabled,
              timestamp: new Date().toISOString(),
            };
          },
        );
      },
      {
        params: t.Object({
          key: t.String(),
        }),
        body: t.Object({
          enabled: t.Boolean(),
          reason: t.Optional(t.String()),
          requestedBy: t.Optional(t.String()),
        }),
      },
    );
}
