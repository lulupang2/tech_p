export type TombstoneScope = 'source' | 'document' | 'document_revision' | 'raw_item';

export interface TombstoneRecord {
  readonly id: string;
  readonly scope: TombstoneScope;
  readonly targetKey: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly effectiveAt: Date;
  readonly purgeAfter: Date | null;
  readonly createdAt: Date;
}

export interface CreateTombstoneInput {
  readonly scope: TombstoneScope;
  readonly targetKey: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly effectiveAt?: Date;
  readonly purgeAfter?: Date | null;
}

export interface TombstoneResult {
  readonly scope: TombstoneScope;
  readonly targetKey: string;
  readonly affectedRevisionCount: number;
  readonly effectiveAt: string;
  readonly reason: string;
}

export interface ReindexResult {
  readonly scope: TombstoneScope;
  readonly targetKey: string;
  readonly restoredRevisionCount: number;
  readonly restoredAt: string;
}

export class TombstoneTargetNotFoundError extends Error {
  readonly code = 'TOMBSTONE_TARGET_NOT_FOUND' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TombstoneTargetNotFoundError';
  }
}

export class InvalidTombstoneRequestError extends Error {
  readonly code = 'INVALID_TOMBSTONE_REQUEST' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidTombstoneRequestError';
  }
}

export interface TombstoneTargetPort {
  readonly exists: (scope: TombstoneScope, targetKey: string) => Promise<boolean>;
  /**
   * Applies tombstone to the target scope:
   * - If scope === 'source': disables source and transitions associated revisions from 'searchable' to 'tombstoned'
   * - If scope === 'document': transitions all revisions of document to 'tombstoned'
   * - If scope === 'document_revision': transitions revision to 'tombstoned'
   * Returns count of revisions transitioned to 'tombstoned'.
   */
  readonly applyTombstone: (
    input: CreateTombstoneInput,
  ) => Promise<{ affectedRevisionCount: number }>;
  /**
   * Reindexes / restores searchable status for non-deleted target items:
   * - If scope === 'source': enables source and transitions revisions with valid chunks back to 'searchable'
   * - If scope === 'document': transitions revisions with valid chunks back to 'searchable'
   * Returns count of revisions transitioned back to 'searchable'.
   */
  readonly restoreSearchable: (
    scope: TombstoneScope,
    targetKey: string,
  ) => Promise<{ restoredRevisionCount: number }>;
}

export interface TombstoneAuditEvent {
  readonly action: 'tombstone_create' | 'tombstone_reindex';
  readonly scope: TombstoneScope;
  readonly targetKey: string;
  readonly affectedCount: number;
  readonly reason?: string;
  readonly requestedBy: string;
  readonly occurredAt: Date;
}

export interface TombstoneAuditPort {
  readonly record: (event: TombstoneAuditEvent) => Promise<void>;
}

export interface TombstoneServicePort {
  readonly createTombstone: (input: CreateTombstoneInput) => Promise<TombstoneResult>;
  readonly reindex: (
    scope: TombstoneScope,
    targetKey: string,
    requestedBy?: string,
  ) => Promise<ReindexResult>;
}

export function createTombstoneService(options: {
  readonly targets: TombstoneTargetPort;
  readonly audit?: TombstoneAuditPort;
}): TombstoneServicePort {
  return {
    async createTombstone(input: CreateTombstoneInput): Promise<TombstoneResult> {
      if (!input.targetKey || input.targetKey.trim().length === 0) {
        throw new InvalidTombstoneRequestError('targetKey must not be empty');
      }
      if (!input.reason || input.reason.trim().length === 0) {
        throw new InvalidTombstoneRequestError('reason must be provided for tombstone operation');
      }
      if (!input.requestedBy || input.requestedBy.trim().length === 0) {
        throw new InvalidTombstoneRequestError('requestedBy must be provided for audit tracking');
      }

      const exists = await options.targets.exists(input.scope, input.targetKey);
      if (!exists) {
        throw new TombstoneTargetNotFoundError(
          `Tombstone target not found: [${input.scope}] ${input.targetKey}`,
        );
      }

      const effectiveAt = input.effectiveAt ?? new Date();
      const { affectedRevisionCount } = await options.targets.applyTombstone({
        ...input,
        effectiveAt,
      });

      await options.audit?.record({
        action: 'tombstone_create',
        scope: input.scope,
        targetKey: input.targetKey,
        affectedCount: affectedRevisionCount,
        reason: input.reason,
        requestedBy: input.requestedBy,
        occurredAt: new Date(),
      });

      return {
        scope: input.scope,
        targetKey: input.targetKey,
        affectedRevisionCount,
        effectiveAt: effectiveAt.toISOString(),
        reason: input.reason,
      };
    },

    async reindex(
      scope: TombstoneScope,
      targetKey: string,
      requestedBy = 'system_operator',
    ): Promise<ReindexResult> {
      if (!targetKey || targetKey.trim().length === 0) {
        throw new InvalidTombstoneRequestError('targetKey must not be empty');
      }

      const exists = await options.targets.exists(scope, targetKey);
      if (!exists) {
        throw new TombstoneTargetNotFoundError(`Reindex target not found: [${scope}] ${targetKey}`);
      }

      const { restoredRevisionCount } = await options.targets.restoreSearchable(scope, targetKey);
      const restoredAt = new Date();

      await options.audit?.record({
        action: 'tombstone_reindex',
        scope,
        targetKey,
        affectedCount: restoredRevisionCount,
        requestedBy,
        occurredAt: restoredAt,
      });

      return {
        scope,
        targetKey,
        restoredRevisionCount,
        restoredAt: restoredAt.toISOString(),
      };
    },
  };
}
