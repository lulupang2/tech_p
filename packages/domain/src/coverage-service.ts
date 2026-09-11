import { type CoverageReason, type ObservationCohort, type CohortComparison } from './coverage.js';
import { type CollectionWindow, CollectionStateError } from './collection-state.js';

export interface CoverageDiagnosisInput {
  readonly rawDocuments: number;
  readonly lexicalDocuments: number;
  readonly vectorDocuments: number;
  readonly partitionsChecked: number;
  readonly partitionsCompleted: number;
  readonly partitionsPartial: number;
  readonly targetCount?: number;
  readonly hasKnownMiss?: boolean;
}

/**
 * Deterministically derives coverage shortage reasons based on observable
 * evidence across raw items, lexical/vector stages, and partition states.
 */
export function diagnoseCoverageReasons(input: CoverageDiagnosisInput): readonly CoverageReason[] {
  const reasons: CoverageReason[] = [];

  const hasTargets = (input.targetCount ?? 0) > 0 || input.partitionsChecked > 0;
  const isRawShortage = hasTargets && input.rawDocuments === 0;
  if (isRawShortage) {
    reasons.push('raw_shortage');
  }

  const isProcessingPending =
    input.rawDocuments > 0 &&
    (input.lexicalDocuments < input.rawDocuments || input.vectorDocuments < input.rawDocuments);
  if (isProcessingPending) {
    reasons.push('processing_pending');
  }

  const hasPeriodGap =
    input.partitionsPartial > 0 ||
    input.partitionsChecked > input.partitionsCompleted ||
    (hasTargets && input.partitionsChecked === 0);
  if (hasPeriodGap) {
    reasons.push('period_gap');
  }

  if (input.hasKnownMiss) {
    reasons.push('retrieval_miss');
  }

  // If there are no raw items, no partitions, no targets, and no evidence at all, return 'unknown'
  if (
    reasons.length === 0 &&
    input.rawDocuments === 0 &&
    input.partitionsChecked === 0 &&
    (input.targetCount ?? 0) === 0
  ) {
    reasons.push('unknown');
  }

  return Object.freeze(reasons);
}

export function validateCoverageWindow(window: CollectionWindow): void {
  if (
    !Number.isFinite(window.from.getTime()) ||
    !Number.isFinite(window.to.getTime()) ||
    window.from.getTime() >= window.to.getTime()
  ) {
    throw new CollectionStateError('invalid_window');
  }
}

export interface MemberCoverageEvaluation {
  readonly targetRevisionId: string;
  readonly baselineCovered: boolean;
  readonly currentCovered: boolean;
  readonly baselineValue: number | null;
  readonly currentValue: number | null;
}

/**
 * Evaluates cohort comparison logic over common target revisions with verified coverage
 * in both baseline and current windows.
 */
export function evaluateCohortComparison(
  cohort: ObservationCohort,
  metric: string,
  unit: string,
  memberEvaluations: readonly MemberCoverageEvaluation[],
): CohortComparison {
  const matchingMembers = cohort.members.filter((m) => m.metric === metric && m.unit === unit);

  if (matchingMembers.length === 0) {
    return {
      cohortId: cohort.id,
      metric,
      unit,
      denominator: 0,
      excludedTargets: cohort.members.length,
      baseline: null,
      current: null,
      partial: true,
    };
  }

  let denominator = 0;
  let excludedTargets = 0;
  let baselineSum = 0;
  let currentSum = 0;

  for (const member of matchingMembers) {
    const evaluation = memberEvaluations.find(
      (e) => e.targetRevisionId === member.targetRevisionId,
    );

    if (evaluation && evaluation.baselineCovered && evaluation.currentCovered) {
      denominator += 1;
      if (evaluation.baselineValue !== null) {
        baselineSum += evaluation.baselineValue;
      }
      if (evaluation.currentValue !== null) {
        currentSum += evaluation.currentValue;
      }
    } else {
      excludedTargets += 1;
    }
  }

  if (denominator === 0) {
    return {
      cohortId: cohort.id,
      metric,
      unit,
      denominator: 0,
      excludedTargets,
      baseline: null,
      current: null,
      partial: true,
    };
  }

  return {
    cohortId: cohort.id,
    metric,
    unit,
    denominator,
    excludedTargets,
    baseline: baselineSum,
    current: currentSum,
    partial: excludedTargets > 0,
  };
}
