import {
  FIXED_CORPUS,
  MVP_LIVE_ANSWER_IDS,
  MVP_LIVE_RETRIEVAL_IDS,
  sha256,
} from './release-evaluation.js';

export class ReleaseReviewError extends Error {
  constructor(code: string) {
    super(`release_review_${code}`);
    this.name = 'ReleaseReviewError';
  }
}

function requireReview(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ReleaseReviewError(code);
}

function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  requireReview(value !== null && typeof value === 'object' && !Array.isArray(value), 'shape');
  const result = value as Record<string, unknown>;
  if (keys) {
    requireReview(
      Object.keys(result).length === keys.length && keys.every((key) => Object.hasOwn(result, key)),
      'fields',
    );
  }
  return result;
}

function parse(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ReleaseReviewError('json');
  }
  return record(value);
}

function hash(value: unknown): string {
  requireReview(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'hash');
  return value;
}

function count(value: unknown): number {
  requireReview(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'counts');
  return value;
}

function orderedRows(value: unknown, ids: readonly string[]): Record<string, unknown>[] {
  requireReview(Array.isArray(value) && value.length === ids.length, 'ids');
  const rows = value.map((row: unknown) => record(row));
  const byId = new Map(rows.map((row) => [row['id'], row]));
  requireReview(byId.size === ids.length && ids.every((id) => byId.has(id)), 'ids');
  return ids.map((id) => byId.get(id)!);
}

const COUNT_KEYS = [
  'claimCount',
  'totalCitations',
  'supportedCitations',
  'coveredClaims',
  'unsupportedClaims',
] as const;

const REVIEW_KEYS = [
  'schemaVersion',
  'sourceReportSha256',
  'labelsSha256',
  'reviewer',
  'reviewedAt',
  'attestation',
  'labels',
  'answers',
] as const;

/**
 * Offline only. attestation=true asserts a human inspected the exact labels and
 * answer/evidence pairs. Hash identity is not itself evidence of semantic support.
 * Unknown review fields are rejected; raw prompts, answers and bodies are not accepted.
 */
export function finalizeReleaseReview(sourceReportJson: string, reviewJson: string) {
  const source = parse(sourceReportJson);
  const review = record(parse(reviewJson), REVIEW_KEYS);
  requireReview(
    source['schemaVersion'] === 1 && source['task'] === 'EVAL-002' && source['mode'] === 'live',
    'source',
  );
  requireReview(source['automatedMvpGatePassed'] === true, 'automated_gate');
  requireReview(source['executionFailure'] == null, 'automated_gate');
  const pending = source['blockers'];
  requireReview(
    Array.isArray(pending) &&
      pending.every(
        (item: unknown) =>
          item === 'live_label_review_pending' || item === 'semantic_answer_review_pending',
      ),
    'automated_gate',
  );
  const datasetSha256 = hash(record(source['dataset'])['sha256']);
  requireReview(datasetSha256 === FIXED_CORPUS.sha256, 'dataset');
  const labelsSha256 = hash(record(source['labels'])['sha256']);
  const sourceReportSha256 = sha256(sourceReportJson);
  requireReview(
    review['schemaVersion'] === 1 &&
      hash(review['sourceReportSha256']) === sourceReportSha256 &&
      hash(review['labelsSha256']) === labelsSha256,
    'binding',
  );

  const reviewer = review['reviewer'];
  const reviewedAt = review['reviewedAt'];
  requireReview(
    typeof reviewer === 'string' &&
      reviewer.trim().length > 0 &&
      reviewer.length <= 160 &&
      [...reviewer].every((character) => character >= ' ' && character !== '\u007f') &&
      review['attestation'] === true,
    'attestation',
  );
  requireReview(typeof reviewedAt === 'string', 'reviewed_at');
  const date =
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(
      reviewedAt,
    );
  requireReview(date && Number.isFinite(Date.parse(reviewedAt)), 'reviewed_at');
  requireReview(
    new Date(`${date[1]}T00:00:00Z`).toISOString().slice(0, 10) === date[1],
    'reviewed_at',
  );

  const labels = orderedRows(review['labels'], MVP_LIVE_ANSWER_IDS).map((row) => {
    record(row, ['id', 'reviewed', 'approved']);
    requireReview(row['reviewed'] === true && row['approved'] === true, 'label_approval');
    return { id: row['id'] as string, reviewed: true, approved: true };
  });
  const sourceRows = orderedRows(record(source['answers'])['rows'], MVP_LIVE_ANSWER_IDS);
  for (const row of sourceRows) {
    const answered = MVP_LIVE_RETRIEVAL_IDS.some((id) => id === row['id']);
    const expected = answered ? 'answered' : 'insufficient_evidence';
    requireReview(
      row['expectedStatus'] === expected && row['status'] === expected,
      'source_status',
    );
    hash(row['questionSha256']);
    hash(row['answerSha256']);
    requireReview(Array.isArray(row['citations']), 'source_citations');
    const citationIds = new Set<string>();
    for (const value of row['citations']) {
      const citation = record(value);
      const id = citation['id'];
      requireReview(
        typeof id === 'string' && /^C[1-9]\d*$/u.test(id) && !citationIds.has(id),
        'source_citations',
      );
      hash(citation['excerptSha256']);
      citationIds.add(id);
    }
    requireReview(answered ? citationIds.size > 0 : citationIds.size === 0, 'source_citations');
  }

  const answers = orderedRows(review['answers'], MVP_LIVE_RETRIEVAL_IDS).map((row) => {
    record(row, ['id', 'questionSha256', 'answerSha256', ...COUNT_KEYS]);
    const original = sourceRows.find((item) => item['id'] === row['id'])!;
    const questionSha256 = hash(row['questionSha256']);
    const answerSha256 = hash(row['answerSha256']);
    requireReview(
      questionSha256 === original['questionSha256'] && answerSha256 === original['answerSha256'],
      'answer_binding',
    );
    const counts = {
      claimCount: count(row['claimCount']),
      totalCitations: count(row['totalCitations']),
      supportedCitations: count(row['supportedCitations']),
      coveredClaims: count(row['coveredClaims']),
      unsupportedClaims: count(row['unsupportedClaims']),
    };
    requireReview(
      counts.claimCount > 0 &&
        counts.totalCitations === (original['citations'] as unknown[]).length &&
        counts.supportedCitations <= counts.totalCitations &&
        counts.coveredClaims <= counts.claimCount &&
        counts.unsupportedClaims <= counts.claimCount,
      'counts',
    );
    return { id: row['id'] as string, questionSha256, answerSha256, ...counts };
  });
  const totals = {
    claimCount: 0,
    totalCitations: 0,
    supportedCitations: 0,
    coveredClaims: 0,
    unsupportedClaims: 0,
  };
  for (const row of answers) {
    for (const key of COUNT_KEYS) totals[key] = count(totals[key] + row[key]);
  }
  const semanticMetrics = {
    citationPrecision: totals.supportedCitations / totals.totalCitations,
    citationCoverage: totals.coveredClaims / totals.claimCount,
    unsupportedClaimRate: totals.unsupportedClaims / totals.claimCount,
  };
  // Compare integer ratios exactly, including at the inclusive threshold boundaries.
  const percent = (value: number) => BigInt(value) * BigInt(100);
  const checks = {
    citationPrecision:
      percent(totals.supportedCitations) >= BigInt(totals.totalCitations) * BigInt(95),
    citationCoverage: percent(totals.coveredClaims) >= BigInt(totals.claimCount) * BigInt(90),
    unsupportedClaimRate:
      percent(totals.unsupportedClaims) <= BigInt(totals.claimCount) * BigInt(5),
  };
  const blockers = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([key]) => key);
  return {
    schemaVersion: 1,
    task: 'EVAL-002',
    decision: 'ADR-0019',
    scope: 'portfolio-mvp-evaluation-only',
    sourceReportSha256,
    labelsSha256,
    reviewSha256: sha256(reviewJson),
    datasetSha256,
    reviewer: reviewer.trim(),
    reviewedAt,
    attestation: true,
    labels,
    answers,
    totals,
    semanticMetrics,
    thresholds: { citationPrecision: 0.95, citationCoverage: 0.9, unsupportedClaimRate: 0.05 },
    automatedMvpGatePassed: true,
    semanticGatePassed: blockers.length === 0,
    releaseGatePassed: blockers.length === 0,
    blockers,
  };
}
