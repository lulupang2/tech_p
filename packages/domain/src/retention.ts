import type { SourceKey } from './collector.js';

export const DEFAULT_RAW_RETENTION_DAYS = 90 as const;
export const PIPELINE_EVENTS_RETENTION_DAYS = 30 as const;
export const QUERY_RUNS_RETENTION_DAYS = 30 as const;

/**
 * Per-source raw payload retention policies in days per DATA_PIPELINE.md §9 and DATABASE.md §8.
 * Re-collectable API metrics/search snapshots retain raw payloads for 30 days,
 * while full articles/papers/releases retain raw payloads for 90 days.
 * Normalized document revisions and metric observations are preserved across all sources.
 */
export const SOURCE_RAW_RETENTION_DAYS: Readonly<Record<SourceKey, number>> = {
  github_releases: 90,
  users_rust_lang: 90,
  arxiv: 90,
  chrome_release_notes: 90,
  chrome_origin_trials: 90,
  react_blog: 90,
  stack_exchange: 30,
  npm_registry: 30,
  npm_downloads: 30,
  github_search: 30,
  huggingface_hub: 30,
};

export const CONFIRM_IRREVERSIBLE_PURGE_TOKEN = 'CONFIRM_IRREVERSIBLE_RETENTION_PURGE' as const;

export class IrreversibleActionRefusalError extends Error {
  readonly code = 'IRREVERSIBLE_ACTION_REFUSED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'IrreversibleActionRefusalError';
  }
}

export class InvalidRetentionRequestError extends Error {
  readonly code = 'INVALID_RETENTION_REQUEST' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidRetentionRequestError';
  }
}

/**
 * Computes the exact UTC cutoff timestamp for a given retention duration in days.
 * Any records with timestamp strictly before (<) the cutoff date are eligible for purge.
 */
export function computeRetentionCutoff(retentionDays: number, referenceDate = new Date()): Date {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new InvalidRetentionRequestError(
      `Retention days must be a non-negative number: ${retentionDays}`,
    );
  }
  const refTime = referenceDate.getTime();
  if (!Number.isFinite(refTime)) {
    throw new InvalidRetentionRequestError(`Invalid reference date: ${referenceDate}`);
  }
  const cutoffMs = refTime - retentionDays * 24 * 60 * 60 * 1000;
  return new Date(cutoffMs);
}

/**
 * Deterministically checks whether an item with `collectedAt`/`occurredAt` date is eligible for purge.
 * Returns true if itemDate < cutoffDate (candidate for purge).
 */
export function isRetentionCandidate(
  itemDate: Date | string | number | null | undefined,
  retentionDays: number,
  referenceDate = new Date(),
): boolean {
  if (!itemDate) return false;
  const parsed = itemDate instanceof Date ? itemDate : new Date(itemDate);
  if (isNaN(parsed.getTime())) return false;
  const cutoff = computeRetentionCutoff(retentionDays, referenceDate);
  return parsed.getTime() < cutoff.getTime();
}

export interface RetentionCountSummary {
  readonly rawItemsBySource: Record<string, number>;
  readonly pipelineEvents: number;
  readonly queryRuns: number;
}

export interface RetentionTargetPort {
  /**
   * Counts candidates eligible for retention purge at the given cutoff dates without mutating anything.
   */
  readonly countCandidates: (cutoffs: {
    readonly rawCutoffsBySource: Record<string, Date>;
    readonly pipelineEventsCutoff: Date;
    readonly queryRunsCutoff: Date;
  }) => Promise<RetentionCountSummary>;

  /**
   * Executes the actual purge of expired raw item payloads, pipeline events, and query runs.
   * MUST NEVER delete or alter immutable document revisions, chunks, embeddings, metrics, or audit events.
   */
  readonly purgeExpired?: (cutoffs: {
    readonly rawCutoffsBySource: Record<string, Date>;
    readonly pipelineEventsCutoff: Date;
    readonly queryRunsCutoff: Date;
  }) => Promise<RetentionCountSummary>;
}

export interface RetentionAuditEvent {
  readonly action: 'retention_dry_run' | 'retention_purge';
  readonly referenceDate: Date;
  readonly totalCandidates: number;
  readonly dryRun: boolean;
  readonly purgedCounts?: RetentionCountSummary;
  readonly actor?: { readonly type: string; readonly ref: string };
  readonly occurredAt: Date;
}

export interface RetentionAuditPort {
  readonly record: (event: RetentionAuditEvent) => Promise<void>;
}

export interface RetentionPlanOptions {
  readonly referenceDate?: Date;
  readonly dryRun?: boolean;
  readonly confirmation?: string;
  readonly customRawRetentionDays?: Partial<Record<SourceKey, number>>;
  readonly actor?: { readonly type: string; readonly ref: string };
}

export interface RetentionPlanResult {
  readonly dryRun: boolean;
  readonly referenceDate: string;
  readonly totalCandidates: number;
  readonly byCategory: {
    readonly rawItems: number;
    readonly pipelineEvents: number;
    readonly queryRuns: number;
  };
  readonly bySource: Record<string, number>;
  readonly cutoffs: {
    readonly rawItemsBySource: Record<string, string>;
    readonly pipelineEvents: string;
    readonly queryRuns: string;
  };
  readonly executed: boolean;
  readonly purgedCounts?: RetentionCountSummary;
}

export interface RetentionServicePort {
  readonly evaluateAndExecute: (options?: RetentionPlanOptions) => Promise<RetentionPlanResult>;
}

export function createRetentionService(options: {
  readonly targets: RetentionTargetPort;
  readonly audit?: RetentionAuditPort;
}): RetentionServicePort {
  return {
    async evaluateAndExecute(planOptions: RetentionPlanOptions = {}): Promise<RetentionPlanResult> {
      const referenceDate = planOptions.referenceDate ?? new Date();
      if (!Number.isFinite(referenceDate.getTime())) {
        throw new InvalidRetentionRequestError(
          'Invalid referenceDate provided to retention service',
        );
      }

      const dryRun = planOptions.dryRun ?? true;

      // 1. Calculate cutoff boundaries for each source and category
      const rawCutoffsBySource: Record<string, Date> = {};
      const rawCutoffsIsoBySource: Record<string, string> = {};

      const sourceKeys = Object.keys(SOURCE_RAW_RETENTION_DAYS) as SourceKey[];
      for (const key of sourceKeys) {
        const days =
          planOptions.customRawRetentionDays?.[key] ??
          SOURCE_RAW_RETENTION_DAYS[key] ??
          DEFAULT_RAW_RETENTION_DAYS;
        const cutoff = computeRetentionCutoff(days, referenceDate);
        rawCutoffsBySource[key] = cutoff;
        rawCutoffsIsoBySource[key] = cutoff.toISOString();
      }

      const pipelineEventsCutoff = computeRetentionCutoff(
        PIPELINE_EVENTS_RETENTION_DAYS,
        referenceDate,
      );
      const queryRunsCutoff = computeRetentionCutoff(QUERY_RUNS_RETENTION_DAYS, referenceDate);

      // 2. Count candidates deterministically (safe dry-run / observation)
      const counts = await options.targets.countCandidates({
        rawCutoffsBySource,
        pipelineEventsCutoff,
        queryRunsCutoff,
      });

      const totalRawItems = Object.values(counts.rawItemsBySource).reduce((sum, n) => sum + n, 0);
      const totalCandidates = totalRawItems + counts.pipelineEvents + counts.queryRuns;

      // 3. If live purge is requested, enforce the irreversible confirmation guard
      if (!dryRun) {
        if (planOptions.confirmation !== CONFIRM_IRREVERSIBLE_PURGE_TOKEN) {
          throw new IrreversibleActionRefusalError(
            `Destructive retention purge refused: confirmation token "${CONFIRM_IRREVERSIBLE_PURGE_TOKEN}" is required. Passed: "${planOptions.confirmation ?? ''}"`,
          );
        }

        if (!options.targets.purgeExpired) {
          throw new IrreversibleActionRefusalError(
            'Purge capability is not configured on target adapter',
          );
        }

        const purged = await options.targets.purgeExpired({
          rawCutoffsBySource,
          pipelineEventsCutoff,
          queryRunsCutoff,
        });

        await options.audit?.record({
          action: 'retention_purge',
          referenceDate,
          totalCandidates,
          dryRun: false,
          purgedCounts: purged,
          ...(planOptions.actor !== undefined ? { actor: planOptions.actor } : {}),
          occurredAt: new Date(),
        });

        return {
          dryRun: false,
          referenceDate: referenceDate.toISOString(),
          totalCandidates,
          byCategory: {
            rawItems: totalRawItems,
            pipelineEvents: counts.pipelineEvents,
            queryRuns: counts.queryRuns,
          },
          bySource: counts.rawItemsBySource,
          cutoffs: {
            rawItemsBySource: rawCutoffsIsoBySource,
            pipelineEvents: pipelineEventsCutoff.toISOString(),
            queryRuns: queryRunsCutoff.toISOString(),
          },
          executed: true,
          purgedCounts: purged,
        };
      }

      // 4. Record dry-run audit event
      await options.audit?.record({
        action: 'retention_dry_run',
        referenceDate,
        totalCandidates,
        dryRun: true,
        ...(planOptions.actor !== undefined ? { actor: planOptions.actor } : {}),
        occurredAt: new Date(),
      });

      return {
        dryRun: true,
        referenceDate: referenceDate.toISOString(),
        totalCandidates,
        byCategory: {
          rawItems: totalRawItems,
          pipelineEvents: counts.pipelineEvents,
          queryRuns: counts.queryRuns,
        },
        bySource: counts.rawItemsBySource,
        cutoffs: {
          rawItemsBySource: rawCutoffsIsoBySource,
          pipelineEvents: pipelineEventsCutoff.toISOString(),
          queryRuns: queryRunsCutoff.toISOString(),
        },
        executed: false,
      };
    },
  };
}
