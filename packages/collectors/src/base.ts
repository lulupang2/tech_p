import { createHash } from 'node:crypto';
import type {
  CollectorPort,
  SourcePolicy,
  CollectionContext,
  CollectionResult,
  CollectedRawItem,
  PolicyGuardPort,
} from '@techpulse/domain';
import { DefaultPolicyGuard } from './guard.js';

export abstract class BaseCollector implements CollectorPort {
  abstract readonly sourceKey: CollectorPort['sourceKey'];
  abstract readonly policy: SourcePolicy;

  protected readonly guard: PolicyGuardPort;

  constructor(guard?: PolicyGuardPort) {
    this.guard = guard ?? new DefaultPolicyGuard();
  }

  abstract collect(context: CollectionContext): Promise<CollectionResult>;

  /**
   * Helper to construct a validated CollectedRawItem with PII stripped and sha256 hash computed.
   */
  protected createRawItem(params: {
    externalId: string;
    payload: Record<string, unknown>;
    publishedAt: Date | null;
    cursor: string | null;
    metadata?: Record<string, unknown>;
  }): CollectedRawItem {
    // 1. Strip PII before persistence (SECURITY.md §8)
    const sanitizedPayload = this.guard.stripPii(params.payload, this.policy);

    // 2. Compute canonical raw payload sha256
    const rawJson = JSON.stringify(sanitizedPayload);
    const rawHash = createHash('sha256').update(rawJson).digest('hex');

    const item: CollectedRawItem = {
      externalId: params.externalId,
      payload: sanitizedPayload,
      rawHash,
      publishedAt: params.publishedAt,
      cursor: params.cursor,
      metadata: params.metadata,
    };

    // 3. Enforce content integrity
    const validation = this.guard.enforceContentPolicy(item, this.policy);
    if (!validation.valid) {
      throw new Error(
        `Content policy violation for source ${this.sourceKey}: ${validation.reason}`,
      );
    }

    return item;
  }
}
