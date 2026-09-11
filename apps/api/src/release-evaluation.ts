import { createHash } from 'node:crypto';
import type { SearchHit } from '@techpulse/domain';
import { GOLDEN_SET_ITEMS, type GoldenSetItem } from '@techpulse/rag';

export const FIXED_CORPUS = {
  runKey: 'cov009-20260910-live-v1',
  sha256: '0cb1435f0629039f5189008ac189013c85d8766e8d7507328409355eb80f655f',
  revisions: 28,
  chunks: 500,
  embeddings: 500,
  from: '2026-06-12T03:50:22.000Z',
  to: '2026-09-10T03:50:22.000Z',
} as const;

export const RETRIEVAL_SCORE_VERSION = 'chunk-cutoff10-unique-revision-v2';

export interface CorpusMembership {
  readonly chunkId: string;
  readonly revisionId: string;
  readonly target: string;
  readonly publishedAt: string;
}

export const MVP_LIVE_RETRIEVAL_IDS = ['L-001', 'L-007', 'L-014', 'L-017'] as const;
export const MVP_LIVE_NEGATIVE_IDS = ['L-040', 'L-041', 'L-044', 'L-045'] as const;
export const MVP_LIVE_ANSWER_IDS = [...MVP_LIVE_RETRIEVAL_IDS, ...MVP_LIVE_NEGATIVE_IDS] as const;
export const ANSWER_SUBSET_IDS = [
  'L-013',
  'L-036',
  'L-037',
  'L-038',
  'L-006',
  'L-039',
  'L-014',
  'L-001',
  'L-002',
  'L-003',
  'L-004',
  'L-005',
] as const;

export interface LiveEvaluationItem {
  readonly id: string;
  readonly category: 'target_latest' | 'release_exact' | 'target_window' | 'coverage_negative';
  readonly language: 'ko' | 'en';
  readonly question: string;
  readonly expectedStatus: 'answered' | 'insufficient_evidence';
  readonly expectedTarget: string | null;
  readonly relevantRevisionIds: readonly string[];
  readonly relevantChunkIds: readonly string[];
  readonly expectedLimitation: string | null;
  readonly publishedAfter: string | null;
  readonly publishedBeforeExclusive: string | null;
}

export interface LiveEvaluationSet {
  readonly schemaVersion: 1;
  readonly status: string;
  readonly dataset: Pick<typeof FIXED_CORPUS, 'runKey' | 'sha256' | 'revisions' | 'chunks'>;
  readonly items: readonly LiveEvaluationItem[];
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function validateLiveEvaluationSet(value: unknown): LiveEvaluationSet {
  if (!value || typeof value !== 'object') throw new Error('invalid_live_labels');
  const set = value as LiveEvaluationSet;
  if (
    set.schemaVersion !== 1 ||
    typeof set.status !== 'string' ||
    set.dataset?.runKey !== FIXED_CORPUS.runKey ||
    set.dataset.sha256 !== FIXED_CORPUS.sha256 ||
    set.dataset.revisions !== 28 ||
    set.dataset.chunks !== 500 ||
    !Array.isArray(set.items) ||
    set.items.length !== 45 ||
    set.items.some((item) => !item || typeof item !== 'object') ||
    new Set(set.items.map((item) => item.id)).size !== 45
  )
    throw new Error('invalid_live_labels');
  for (let i = 0; i < 45; i += 1) {
    const item = set.items.find((row) => row.id === `L-${String(i + 1).padStart(3, '0')}`);
    if (
      !item ||
      typeof item.question !== 'string' ||
      !item.question.trim() ||
      !['ko', 'en'].includes(item.language) ||
      !['target_latest', 'release_exact', 'target_window', 'coverage_negative'].includes(
        item.category,
      ) ||
      !Array.isArray(item.relevantRevisionIds) ||
      !Array.isArray(item.relevantChunkIds) ||
      [...item.relevantRevisionIds, ...item.relevantChunkIds].some(
        (id) =>
          typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(id),
      ) ||
      new Set(item.relevantRevisionIds).size !== item.relevantRevisionIds.length ||
      new Set(item.relevantChunkIds).size !== item.relevantChunkIds.length ||
      (item.expectedTarget !== null && typeof item.expectedTarget !== 'string') ||
      (item.expectedLimitation !== null && typeof item.expectedLimitation !== 'string') ||
      (i < 39
        ? item.expectedStatus !== 'answered' ||
          item.category === 'coverage_negative' ||
          item.relevantRevisionIds.length === 0 ||
          item.relevantChunkIds.length === 0 ||
          typeof item.expectedTarget !== 'string' ||
          !item.expectedTarget.trim()
        : item.expectedStatus !== 'insufficient_evidence' ||
          item.category !== 'coverage_negative' ||
          item.relevantRevisionIds.length !== 0 ||
          item.relevantChunkIds.length !== 0 ||
          !item.expectedLimitation?.trim())
    )
      throw new Error('invalid_live_label_row');
    for (const date of [item.publishedAfter, item.publishedBeforeExclusive]) {
      if (
        date !== null &&
        (typeof date !== 'string' || !/T.*Z$/u.test(date) || !Number.isFinite(Date.parse(date)))
      ) {
        throw new Error('invalid_live_label_date');
      }
    }
    if (
      item.publishedAfter &&
      item.publishedBeforeExclusive &&
      Date.parse(item.publishedAfter) >= Date.parse(item.publishedBeforeExclusive)
    ) {
      throw new Error('invalid_live_label_window');
    }
  }
  return set;
}

/** Trusted manifest comes from an independently verified DB snapshot, never from label counts. */
export function validateLiveLabelMembership(
  items: readonly LiveEvaluationItem[],
  corpus: readonly CorpusMembership[],
) {
  const byChunk = new Map<string, CorpusMembership>();
  const byRevision = new Map<string, CorpusMembership[]>();
  for (const row of corpus) {
    const publishedAt = Date.parse(row.publishedAt);
    if (
      !Number.isFinite(publishedAt) ||
      publishedAt < Date.parse(FIXED_CORPUS.from) ||
      publishedAt >= Date.parse(FIXED_CORPUS.to) ||
      byChunk.has(row.chunkId)
    ) {
      throw new Error('fixed_corpus_membership_invalid');
    }
    byChunk.set(row.chunkId, row);
    const revisions = byRevision.get(row.revisionId) ?? [];
    if (
      revisions.some(
        (other) => other.target !== row.target || other.publishedAt !== row.publishedAt,
      )
    ) {
      throw new Error('fixed_corpus_membership_invalid');
    }
    revisions.push(row);
    byRevision.set(row.revisionId, revisions);
  }
  for (const item of items) {
    const eligible = (row: CorpusMembership) =>
      row.target === item.expectedTarget &&
      (!item.publishedAfter || Date.parse(row.publishedAt) >= Date.parse(item.publishedAfter)) &&
      (!item.publishedBeforeExclusive ||
        Date.parse(row.publishedAt) < Date.parse(item.publishedBeforeExclusive));
    for (const id of item.relevantRevisionIds) {
      const rows = byRevision.get(id);
      if (
        !rows?.length ||
        !rows.every(eligible) ||
        !rows.some((row) => item.relevantChunkIds.includes(row.chunkId))
      ) {
        throw new Error('live_labels_outside_fixed_corpus');
      }
    }
    for (const id of item.relevantChunkIds) {
      const row = byChunk.get(id);
      if (!row || !item.relevantRevisionIds.includes(row.revisionId) || !eligible(row)) {
        throw new Error('live_labels_outside_fixed_corpus');
      }
    }
  }
}

export function answerSubsetCoverage(set: LiveEvaluationSet, corpus?: readonly CorpusMembership[]) {
  validateLiveEvaluationSet(set);
  const subset = ANSWER_SUBSET_IDS.map((id) => set.items.find((item) => item.id === id)!);
  const revisions = new Set(subset.flatMap((item) => item.relevantRevisionIds));
  const chunks = new Set(subset.flatMap((item) => item.relevantChunkIds));
  const countsMatchExpected =
    revisions.size === FIXED_CORPUS.revisions && chunks.size === FIXED_CORPUS.chunks;
  let complete: boolean | null = null;
  if (corpus) {
    validateLiveLabelMembership(set.items, corpus);
    const corpusRevisions = new Set(corpus.map((row) => row.revisionId));
    const corpusChunks = new Set(corpus.map((row) => row.chunkId));
    complete =
      countsMatchExpected &&
      corpusRevisions.size === revisions.size &&
      corpusChunks.size === chunks.size &&
      [...corpusRevisions].every((id) => revisions.has(id)) &&
      [...corpusChunks].every((id) => chunks.has(id));
  }
  return {
    ids: ANSWER_SUBSET_IDS,
    questions: subset.length,
    relevantRevisions: revisions.size,
    relevantChunks: chunks.size,
    countsMatchExpected,
    membershipVerification: corpus ? 'verified' : 'pending',
    complete,
  };
}

export function percentile(values: readonly number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
}

export function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** Cut off at ten actual returned chunks BEFORE counting unique relevant revisions. */
export function scoreRetrieval(
  item: LiveEvaluationItem,
  hits: readonly SearchHit[],
  latencyMs: number,
) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new Error('release_invalid_latency');
  const top = hits.slice(0, 10);
  const revisions: string[] = [];
  for (const hit of top) {
    if (!revisions.includes(hit.documentRevisionId)) revisions.push(hit.documentRevisionId);
  }
  const relevant = new Set(item.relevantRevisionIds);
  const seen = new Set<string>();
  let dcg = 0;
  top.forEach((hit, index) => {
    if (relevant.has(hit.documentRevisionId) && !seen.has(hit.documentRevisionId)) {
      dcg += 1 / Math.log2(index + 2);
    }
    seen.add(hit.documentRevisionId);
  });
  const ideal = Array.from(
    { length: Math.min(10, relevant.size) },
    (_, i) => 1 / Math.log2(i + 2),
  ).reduce((sum, value) => sum + value, 0);
  const independent = new Set(top.map((hit) => hit.duplicateClusterId ?? hit.documentId));
  return {
    scoreVersion: RETRIEVAL_SCORE_VERSION,
    id: item.id,
    chunkIds: top.map((hit) => hit.chunkId),
    revisionIds: top.map((hit) => hit.documentRevisionId),
    recallAt10: relevant.size
      ? revisions.filter((id) => relevant.has(id)).length / relevant.size
      : null,
    ndcgAt10: ideal ? dcg / ideal : null,
    duplicateRedundancyAt10: top.length ? 1 - independent.size / top.length : 0,
    repeatedChunkRatio: top.length
      ? 1 - new Set(top.map((hit) => hit.chunkId)).size / top.length
      : 0,
    latencyMs,
  };
}

export function isStrictAnswerObject(content: string): boolean {
  try {
    const value: unknown = JSON.parse(content);
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      'answer' in value &&
      typeof value.answer === 'string' &&
      value.answer.trim().length > 0
    );
  } catch {
    return false;
  }
}

interface ApplicabilityRule {
  readonly applicability:
    'live_applicable' | 'coverage_not_applicable' | 'controlled_fixture_required';
  readonly reason: string;
  readonly neededSourceKeys: readonly string[];
  readonly neededTargets?: readonly string[];
}

const missing = (reason: string, ...neededSourceKeys: string[]): ApplicabilityRule => ({
  applicability: 'coverage_not_applicable',
  reason,
  neededSourceKeys,
});
const fixture = (reason: string, ...neededSourceKeys: string[]): ApplicabilityRule => ({
  applicability: 'controlled_fixture_required',
  reason,
  neededSourceKeys,
});
const live: ApplicabilityRule = {
  applicability: 'live_applicable',
  reason: 'Question can be checked against the fixed approved releases or their absence.',
  neededSourceKeys: [],
};

/** Applicability is a DRAFT evaluation annotation, never a replacement golden label or a pass. */
const BASELINE_RULES: Readonly<Record<string, ApplicabilityRule>> = {
  'G-001': missing(
    'Multi-source backend/community trends are not covered by releases alone.',
    'users_rust_lang',
    'stack_exchange',
    'github_search',
  ),
  'G-002': live,
  'G-003': missing(
    'Bun/Node downloads and attention time series are absent.',
    'npm_downloads',
    'github_search',
  ),
  'G-004': missing(
    'RAG papers and community mention changes are absent.',
    'arxiv',
    'github_search',
    'users_rust_lang',
  ),
  'G-005': live,
  'G-006': live,
  'G-007': missing('Rust forum discussion corpus is not activated.', 'users_rust_lang'),
  'G-008': missing('Papers cannot be inferred from release notes.', 'arxiv'),
  'G-009': {
    ...missing('Elysia release target is not activated.', 'github_releases'),
    neededTargets: ['elysiajs/elysia'],
  },
  'G-010': {
    ...missing(
      'Next.js candidates are outside the approved target set; ambiguity still requires a fixture.',
      'github_releases',
      'npm_registry',
    ),
    neededTargets: ['vercel/next.js'],
  },
  'G-011': missing(
    'Chrome release/trial sources are not activated.',
    'chrome_release_notes',
    'chrome_origin_trials',
  ),
  'G-012': missing(
    'React blog announcements are a different evidence type from releases.',
    'react_blog',
  ),
  'G-013': fixture(
    'Future-window parsing and abstention must be exercised without fabricating future data.',
  ),
  'G-014': fixture(
    'Exact source-history limitation requires the existing controlled policy fixture.',
    'npm_downloads',
  ),
  'G-015': fixture(
    'Non-backfillable historical attention requires the controlled collection-history fixture.',
    'github_search',
  ),
  'G-016': missing(
    'Download time series and 18-month clamping are not measurable on releases.',
    'npm_downloads',
  ),
  'G-017': fixture(
    'An inactive Deno target cannot establish the original 24-hour coverage claim.',
    'github_releases',
  ),
  'G-018': fixture(
    'Unknown-entity abstention must be exercised with the original negative fixture.',
  ),
  'G-019': {
    ...missing('Bun stable release target is not activated.', 'github_releases', 'npm_registry'),
    neededTargets: ['oven-sh/bun'],
  },
  'G-020': live,
  'G-021': missing(
    'The original React 19 release is outside the fixed 90-day snapshot; later patches do not establish its release date.',
    'react_blog',
    'github_releases',
  ),
  'G-022': fixture('Unsupported forecasting intent remains an independent behavioral regression.'),
  'G-023': fixture(
    'Unsupported subjective recommendation remains an independent behavioral regression.',
  ),
  'G-024': fixture(
    'The low-volume noise threshold needs a controlled metric series.',
    'npm_downloads',
  ),
  'G-025': missing(
    'New-package publication and download-spike observations are absent.',
    'npm_registry',
    'npm_downloads',
  ),
  'G-026': missing(
    'Separate Vite/Vue metric series are absent; prohibited aggregate score is never an acceptable substitute.',
    'npm_downloads',
    'github_search',
    'users_rust_lang',
  ),
  'G-027': missing(
    'Separate mention and download observations are absent.',
    'npm_downloads',
    'users_rust_lang',
  ),
  'G-028': fixture(
    'Zero-baseline arithmetic needs controlled observations, not release text.',
    'users_rust_lang',
  ),
  'G-029': missing('Model-activity observations are absent.', 'huggingface_hub'),
  'G-030': missing('Verbatim Stack Exchange evidence is not in this corpus.', 'stack_exchange'),
  'G-031': missing(
    'Null-publication-date origin-trial evidence is absent.',
    'chrome_origin_trials',
  ),
  'G-032': missing(
    'Chrome release-note attribution cannot be tested using GitHub release rights.',
    'chrome_release_notes',
  ),
  'G-033': fixture(
    'Full-text redistribution request refers to a prior answer and needs a controlled conversation.',
  ),
  'G-034': fixture(
    'Mandatory injected system-prompt-exfiltration regression; NEVER waived by coverage.',
  ),
  'G-035': fixture('Mandatory fake-citation/phishing regression; NEVER waived by coverage.'),
  'G-036': fixture('Mandatory SSRF/egress injection regression; NEVER waived by coverage.'),
  'G-037': fixture('Mandatory hidden-HTML sanitization regression; NEVER waived by coverage.'),
  'G-038': fixture('Mandatory token-flooding regression; NEVER waived by coverage.'),
  'G-039': fixture(
    'Single-source corpus cannot establish cross-source duplicate independence.',
    'users_rust_lang',
    'react_blog',
  ),
  'G-040': fixture(
    'Cross-source cluster provenance requires multiple-source members.',
    'users_rust_lang',
    'react_blog',
  ),
  'G-041': missing(
    'Bun/Deno matched metric time series are absent.',
    'npm_downloads',
    'github_search',
  ),
  'G-042': missing(
    'Agent-tooling papers, forums and targets are not activated.',
    'arxiv',
    'users_rust_lang',
    'github_search',
  ),
  'G-043': live,
};

export function baselineApplicability(items: readonly GoldenSetItem[] = GOLDEN_SET_ITEMS) {
  if (items.length !== 43 || new Set(items.map((item) => item.id)).size !== 43) {
    throw new Error('baseline_must_contain_all_43_items');
  }
  const rows = items.map((item) => {
    const rule = BASELINE_RULES[item.id];
    if (!rule) throw new Error('missing_baseline_applicability_rule');
    return {
      id: item.id,
      questionSha256: sha256(item.question),
      originalExpectedStatus: item.expectedStatus,
      ...rule,
      neededTargets: rule.neededTargets ?? [],
      mandatoryHardInvariants: true,
      isSecurityInjection: item.isSecurityInjection,
      executionState: 'not_executed' as const,
      semanticReview: 'pending' as const,
    };
  });
  return {
    status: 'draft-applicability-human-review-required',
    baselineLabelsSha256: sha256(JSON.stringify(items)),
    denominator: {
      allItems: 43,
      liveApplicable: rows.filter((row) => row.applicability === 'live_applicable').length,
      coverageNotApplicable: rows.filter((row) => row.applicability === 'coverage_not_applicable')
        .length,
      controlledFixtureRequired: rows.filter(
        (row) => row.applicability === 'controlled_fixture_required',
      ).length,
      hardInvariantItems: 43,
      securityInjectionItems: 5,
      executed: 0,
    },
    rows,
    gatePassed: false,
  };
}
