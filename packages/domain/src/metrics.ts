import type { NormalizedMetricObservation, NormalizedMetricType } from './normalization.js';

export const METRIC_TYPES: readonly NormalizedMetricType[] = [
  'community_mentions',
  'issue_discussion',
  'repo_attention',
  'source_diversity',
  'release_activity',
  'paper_activity',
  'model_activity',
  'package_downloads',
] as const;

export const METRIC_UNITS: Readonly<Record<NormalizedMetricType, readonly string[]>> = {
  community_mentions: ['deduplicated_documents', 'mentions', 'posts'],
  issue_discussion: ['comments', 'reactions', 'interactions'],
  repo_attention: ['stars', 'new_repositories'],
  source_diversity: ['sources'],
  release_activity: ['releases'],
  paper_activity: ['papers', 'submissions'],
  model_activity: ['models', 'datasets', 'downloads', 'likes'],
  package_downloads: ['downloads'],
};

export type DuplicateMembershipStatus = 'accepted' | 'suggested' | 'superseded' | null;

export interface MetricAggregationObservation extends NormalizedMetricObservation {
  /** Document identity is used only for provenance; cluster identity controls deduplication. */
  readonly documentId?: string | null;
  readonly duplicateClusterId?: string | null;
  readonly duplicateMembershipStatus?: DuplicateMembershipStatus;
  /** The collection start boundary for snapshot metrics, when known. */
  readonly collectionStartedAt?: Date;
}

export interface AggregatedMetricObservation {
  readonly subjectKey: string;
  readonly metricType: NormalizedMetricType;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly value: number;
  readonly unit: string;
  readonly sourceKeys: readonly string[];
  readonly rawItemIds: readonly string[];
  readonly querySignatures: readonly string[];
  readonly isIncomplete: boolean;
  readonly isSnapshot: boolean;
  readonly deduplicatedObservationCount: number;
}

export class MetricAggregationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricAggregationError';
  }
}

export function validateMetricObservation(observation: {
  readonly metricType: string;
  readonly unit: string;
  readonly value: number;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly collectionStartedAt?: Date;
}): void {
  if (!METRIC_TYPES.includes(observation.metricType as NormalizedMetricType)) {
    throw new MetricAggregationError(`Unsupported metric type: ${observation.metricType}`);
  }
  const metricType = observation.metricType as NormalizedMetricType;
  if (!METRIC_UNITS[metricType].includes(observation.unit)) {
    throw new MetricAggregationError(
      `Invalid unit '${observation.unit}' for metric '${metricType}'`,
    );
  }
  if (!Number.isSafeInteger(observation.value)) {
    throw new MetricAggregationError('Metric value must be a safe integer');
  }
  if (
    Number.isNaN(observation.windowStart.getTime()) ||
    Number.isNaN(observation.windowEnd.getTime()) ||
    observation.windowStart.getTime() > observation.windowEnd.getTime()
  ) {
    throw new MetricAggregationError('Metric window must be valid UTC dates in order');
  }
  if (
    metricType === 'repo_attention' &&
    observation.collectionStartedAt &&
    observation.windowStart < observation.collectionStartedAt
  ) {
    throw new MetricAggregationError('repo_attention cannot precede collection start');
  }
}

export function validateCohortMetricType(metricType: string, unit: string): void {
  if (!METRIC_TYPES.includes(metricType as NormalizedMetricType)) {
    throw new MetricAggregationError(`Unsupported metric type: ${metricType}`);
  }
  if (!METRIC_UNITS[metricType as NormalizedMetricType].includes(unit)) {
    throw new MetricAggregationError(`Invalid unit '${unit}' for metric '${metricType}'`);
  }
}

function observationKey(observation: MetricAggregationObservation): string {
  const sourceScope =
    observation.metricType === 'community_mentions' ? '' : `|${observation.sourceKey}`;
  return [
    observation.subjectKey,
    observation.metricType,
    observation.unit,
    observation.windowStart.toISOString(),
    observation.windowEnd.toISOString(),
    sourceScope,
  ].join('|');
}

function deduplicationKey(observation: MetricAggregationObservation, index: number): string {
  if (
    observation.metricType === 'community_mentions' &&
    observation.duplicateClusterId &&
    observation.duplicateMembershipStatus === 'accepted'
  ) {
    return `cluster:${observation.duplicateClusterId}`;
  }
  return `observation:${observation.rawItemId ?? observation.documentId ?? index}`;
}

/**
 * Aggregates only supplied observations. It never creates zero-valued rows for absent windows and
 * never mutates/deletes the source observations passed by the caller.
 */
export function aggregateMetricObservations(
  observations: readonly MetricAggregationObservation[],
): readonly AggregatedMetricObservation[] {
  const grouped = new Map<
    string,
    { representative: MetricAggregationObservation; members: MetricAggregationObservation[] }
  >();
  observations.forEach((observation) => {
    validateMetricObservation(observation);
    if (
      observation.metricType === 'repo_attention' &&
      observation.collectionStartedAt &&
      observation.windowStart < observation.collectionStartedAt
    ) {
      throw new MetricAggregationError('repo_attention cannot precede collection start');
    }
    const key = observationKey(observation);
    const group = grouped.get(key);
    if (group) group.members.push(observation);
    else grouped.set(key, { representative: observation, members: [observation] });
  });

  return [...grouped.values()].map(({ representative, members }) => {
    const selected = new Map<string, MetricAggregationObservation>();
    const acceptedClusters = new Set(
      members
        .filter(
          (member) =>
            member.metricType === 'community_mentions' &&
            member.duplicateClusterId &&
            member.duplicateMembershipStatus === 'accepted',
        )
        .map((member) => member.duplicateClusterId as string),
    );
    for (const member of members) {
      if (
        member.metricType === 'community_mentions' &&
        member.duplicateClusterId &&
        acceptedClusters.has(member.duplicateClusterId) &&
        member.duplicateMembershipStatus !== 'accepted'
      ) {
        continue;
      }
      const key = deduplicationKey(member, selected.size);
      if (!selected.has(key)) {
        selected.set(key, member);
      }
    }
    const rawItemIds = [
      ...new Set(members.flatMap((member) => (member.rawItemId ? [member.rawItemId] : []))),
    ];
    const querySignatures = [
      ...new Set(
        members.flatMap((member) => (member.querySignature ? [member.querySignature] : [])),
      ),
    ];
    return {
      subjectKey: representative.subjectKey,
      metricType: representative.metricType,
      windowStart: representative.windowStart,
      windowEnd: representative.windowEnd,
      value: [...selected.values()].reduce((sum, member) => sum + member.value, 0),
      unit: representative.unit,
      sourceKeys: [...new Set(members.map((member) => member.sourceKey))],
      rawItemIds,
      querySignatures,
      isIncomplete: members.some((member) => member.isIncomplete),
      isSnapshot: representative.metricType === 'repo_attention',
      deduplicatedObservationCount: selected.size,
    };
  });
}

export interface MetricAggregationServicePort {
  readonly aggregate: (
    observations: readonly MetricAggregationObservation[],
  ) => readonly AggregatedMetricObservation[];
}

export function createMetricAggregationService(): MetricAggregationServicePort {
  return { aggregate: aggregateMetricObservations };
}
