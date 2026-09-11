import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, join, isAbsolute, dirname, basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  createDatabaseClient,
  createSearchService,
  createCoverageRepository,
} from '@techpulse/database';
import {
  collectionHash,
  type SearchHit,
  type SearchFilter,
  type ChatPort,
  type EmbeddingPort,
} from '@techpulse/domain';
import { createStructuredLogger } from '@techpulse/observability';
import { createAnswerService, fuseRetrievalCandidates, parseQuery } from '@techpulse/rag';
import { createApprovedApiModelBindings } from './approved-models.js';
import { loadApiConfig } from './config.js';
import { createBudgetedApiModels } from './runtime-models.js';
import {
  FIXED_CORPUS,
  MVP_LIVE_RETRIEVAL_IDS,
  MVP_LIVE_ANSWER_IDS,
  RETRIEVAL_SCORE_VERSION,
  validateLiveEvaluationSet,
  answerSubsetCoverage,
  baselineApplicability,
  sha256,
  mean,
  percentile,
  scoreRetrieval,
  isStrictAnswerObject,
  type LiveEvaluationItem,
  type LiveEvaluationSet,
} from './release-evaluation.js';
import {
  validateReleaseAllowance,
  validateReleaseHistory,
  createReleaseBudget,
  openReleaseJournal,
  wrapReleasePorts,
  RELEASE_CAPS,
} from './release-budget.js';
import { verifyReleaseCorpus } from './release-preflight.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const outputRoot = join(root, 'docs/experiments/eval-002');
const modes = ['plan', 'preflight', 'negative-diagnostic', 'live'] as const;
type Mode = (typeof modes)[number];
type RetrievalScore = ReturnType<typeof scoreRetrieval>;
interface AnswerRow {
  id: string;
  expectedStatus: string;
  status: string;
  questionSha256: string;
  responseSha256: string | null;
  answerSha256: string;
  chatCalls: number;
  structured: boolean | null;
  citations: { id: string; documentRevisionId: string; excerptSha256: string }[];
  relevantCitationCount: number;
  latencyMs: number;
  limitationSha256: string;
  semanticReview: {
    reviewer: null;
    claimCount: null;
    unsupportedClaims: null;
    supportedCitations: null;
    coveredClaims: null;
  };
}

export interface EphemeralReviewMaterial {
  id: string;
  question: string;
  answer: string;
  questionSha256: string;
  answerSha256: string;
  citations: {
    id: string;
    documentRevisionId: string;
    title: string;
    source: string;
    url: string;
    publishedAt: string | null;
    excerpt: string | null;
    excerptIsVerbatim: boolean;
  }[];
}

interface ResumeLiveOptions {
  reportPath: string;
  retryAnswerIds: readonly string[];
}

interface ResumeSourceReport {
  runId: string;
  reportSha256: string;
  sourceManifestSha256: string;
  retrieval: {
    variants: Record<'fts' | 'vector' | 'hybrid', RetrievalScore[]>;
    summaries: Record<'fts' | 'vector' | 'hybrid', ReturnType<typeof summarizeRetrieval>>;
    automatedGatesPassed: true;
  };
  answerRows: AnswerRow[];
  corpusFingerprint: string;
  profileHash: string;
  models: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

const RETRIEVAL_SCORE_KEYS = [
  'scoreVersion',
  'id',
  'chunkIds',
  'revisionIds',
  'recallAt10',
  'ndcgAt10',
  'duplicateRedundancyAt10',
  'repeatedChunkRatio',
  'latencyMs',
] as const;
const ANSWER_ROW_KEYS = [
  'id',
  'expectedStatus',
  'status',
  'questionSha256',
  'responseSha256',
  'answerSha256',
  'chatCalls',
  'structured',
  'citations',
  'relevantCitationCount',
  'latencyMs',
  'limitationSha256',
  'semanticReview',
] as const;
const CITATION_KEYS = ['id', 'documentRevisionId', 'excerptSha256'] as const;
const SEMANTIC_REVIEW_KEYS = [
  'reviewer',
  'claimCount',
  'unsupportedClaims',
  'supportedCitations',
  'coveredClaims',
] as const;

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value);
}

export function validateResumeSourceReportJson(
  reportJson: string,
  labelsSha256: string,
  labels: LiveEvaluationSet,
  retryAnswerIds: readonly string[],
): ResumeSourceReport {
  validateLiveEvaluationSet(labels);
  const text = reportJson;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('release_resume_report_invalid');
  }
  if (!isRecord(value)) throw new Error('release_resume_report_invalid');
  const dataset = value['dataset'];
  const sourceLabels = value['labels'];
  const code = value['code'];
  const retrieval = value['retrieval'];
  const answers = value['answers'];
  const preflight = value['preflight'];
  const postflight = value['postflight'];
  const invariants = value['hardInvariants'];
  const configuration = value['configuration'];
  const models = value['models'];
  const budget = value['budget'];
  const budgetUsage = isRecord(budget) ? budget['usage'] : null;
  const budgetOutstanding = isRecord(budget) ? budget['outstanding'] : null;
  const budgetCaps = isRecord(budget) ? budget['caps'] : null;
  if (
    value['schemaVersion'] !== 1 ||
    value['task'] !== 'EVAL-002' ||
    value['mode'] !== 'live' ||
    typeof value['runId'] !== 'string' ||
    !/^eval002-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-live$/u.test(value['runId']) ||
    'executionFailure' in value ||
    !isRecord(dataset) ||
    !hasExactKeys(dataset, [
      'runKey',
      'sha256',
      'revisions',
      'chunks',
      'embeddings',
      'from',
      'to',
    ]) ||
    Object.entries(FIXED_CORPUS).some(([key, expected]) => dataset[key] !== expected) ||
    !isRecord(sourceLabels) ||
    !isSha256(labelsSha256) ||
    sourceLabels['sha256'] !== labelsSha256 ||
    sourceLabels['status'] !== labels.status ||
    sourceLabels['reviewedSha256'] !== null ||
    !isRecord(code) ||
    !isSha256(code['sourceManifestSha256']) ||
    !isRecord(configuration) ||
    Object.entries({
      candidatesPerRetriever: 20,
      fusionLimit: 10,
      rrfK: 60,
      concurrency: 1,
      retries: 0,
      fallback: 0,
      acquisition: false,
      liveSearch: false,
      corpusReembedding: false,
      frozenNow: FIXED_CORPUS.to,
      percentileMethod: 'nearest-rank',
      scoreVersion: RETRIEVAL_SCORE_VERSION,
    }).some(([key, expected]) => configuration[key] !== expected) ||
    !isRecord(models) ||
    !hasExactKeys(models, ['chat', 'embedding']) ||
    !isRecord(retrieval) ||
    retrieval['automatedGatesPassed'] !== true ||
    !isRecord(retrieval['variants']) ||
    !isRecord(retrieval['summaries']) ||
    !isRecord(answers) ||
    !Array.isArray(answers['rows']) ||
    !isRecord(preflight) ||
    !isRecord(postflight) ||
    preflight['sha256'] !== FIXED_CORPUS.sha256 ||
    postflight['sha256'] !== FIXED_CORPUS.sha256 ||
    !isSha256(postflight['fingerprint']) ||
    !isSha256(postflight['profileHash']) ||
    !isDeepStrictEqual(preflight, postflight) ||
    Object.entries({
      rawItems: 28,
      revisions: 28,
      chunks: 500,
      embeddings: 500,
      partitions: 10,
      completed: 10,
      providerCalls: 0,
      databaseWrites: 0,
    }).some(([key, expected]) => postflight[key] !== expected) ||
    !isRecord(invariants) ||
    ['time', 'rights', 'profile', 'provenance'].some((key) => invariants[key] !== 0) ||
    !isRecord(budget) ||
    budget['budgetScope'] !== 'additional_allowance' ||
    budget['allowanceDecision'] !== 'DEC-014' ||
    budget['unknownReservations'] !== 0 ||
    !Array.isArray(budget['exceededCaps']) ||
    budget['exceededCaps'].length !== 0 ||
    !isRecord(budgetUsage) ||
    !isRecord(budgetOutstanding) ||
    !hasExactKeys(budgetUsage, Object.keys(RELEASE_CAPS)) ||
    !hasExactKeys(budgetOutstanding, Object.keys(RELEASE_CAPS)) ||
    !isDeepStrictEqual(budgetCaps, RELEASE_CAPS) ||
    Object.entries(RELEASE_CAPS).some(([key, cap]) => {
      const count = budgetUsage[key];
      return (
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > cap ||
        budgetOutstanding[key] !== 0
      );
    })
  ) {
    throw new Error('release_resume_report_invalid');
  }
  const rows = answers['rows'];
  if (
    rows.length !== MVP_LIVE_ANSWER_IDS.length ||
    new Set(rows.map((row) => (isRecord(row) ? row['id'] : null))).size !==
      MVP_LIVE_ANSWER_IDS.length ||
    retryAnswerIds.length !== 1 ||
    retryAnswerIds[0] !== 'L-001'
  ) {
    throw new Error('release_resume_report_invalid');
  }
  const retrievalItems = MVP_LIVE_RETRIEVAL_IDS.map((id) =>
    labels.items.find((item) => item.id === id)!,
  );
  const variants = retrieval['variants'];
  const summaries = retrieval['summaries'];
  if (
    !hasExactKeys(variants, ['fts', 'vector', 'hybrid']) ||
    !hasExactKeys(summaries, ['fts', 'vector', 'hybrid'])
  ) {
    throw new Error('release_resume_report_invalid');
  }
  for (const variant of ['fts', 'vector', 'hybrid'] as const) {
    const scores = variants[variant];
    if (
      !Array.isArray(scores) ||
      scores.length !== MVP_LIVE_RETRIEVAL_IDS.length ||
      new Set(scores.map((score) => (isRecord(score) ? score['id'] : null))).size !==
        MVP_LIVE_RETRIEVAL_IDS.length
    ) {
      throw new Error('release_resume_report_invalid');
    }
    for (const score of scores) {
      if (!isRecord(score) || !hasExactKeys(score, RETRIEVAL_SCORE_KEYS)) {
        throw new Error('release_resume_report_invalid');
      }
      const bounded = ['recallAt10', 'ndcgAt10', 'duplicateRedundancyAt10', 'repeatedChunkRatio'];
      if (
        score['scoreVersion'] !== RETRIEVAL_SCORE_VERSION ||
        !MVP_LIVE_RETRIEVAL_IDS.includes(score['id'] as never) ||
        !Array.isArray(score['chunkIds']) ||
        !Array.isArray(score['revisionIds']) ||
        score['chunkIds'].length > 10 ||
        score['revisionIds'].length !== score['chunkIds'].length ||
        !score['chunkIds'].every(isUuid) ||
        !score['revisionIds'].every(isUuid) ||
        bounded.some(
          (key) =>
            typeof score[key] !== 'number' ||
            !Number.isFinite(score[key]) ||
            (score[key] as number) < 0 ||
            (score[key] as number) > 1,
        ) ||
        typeof score['latencyMs'] !== 'number' ||
        !Number.isFinite(score['latencyMs']) ||
        score['latencyMs'] < 0
      ) {
        throw new Error('release_resume_report_invalid');
      }
    }
  }
  const typedVariants = variants as unknown as ResumeSourceReport['retrieval']['variants'];
  const recomputedSummaries = {
    fts: summarizeRetrieval(typedVariants.fts, retrievalItems),
    vector: summarizeRetrieval(typedVariants.vector, retrievalItems),
    hybrid: summarizeRetrieval(typedVariants.hybrid, retrievalItems),
  };
  for (const variant of ['fts', 'vector', 'hybrid'] as const) {
    if (!isDeepStrictEqual(summaries[variant], recomputedSummaries[variant])) {
      throw new Error('release_resume_report_invalid');
    }
  }
  if (
    recomputedSummaries.hybrid.sampleCount !== MVP_LIVE_RETRIEVAL_IDS.length ||
    !atLeast(recomputedSummaries.hybrid.recallAt10, 0.8) ||
    !atMost(recomputedSummaries.hybrid.warmDbP95Ms, 500)
  ) {
    throw new Error('release_resume_report_invalid');
  }
  for (const id of MVP_LIVE_ANSWER_IDS) {
    const row = rows.find((candidate) => isRecord(candidate) && candidate['id'] === id);
    if (!isRecord(row)) throw new Error('release_resume_report_invalid');
    const item = labels.items.find((candidate) => candidate.id === id)!;
    const citations = row['citations'];
    const semanticReview = row['semanticReview'];
    if (
      !hasExactKeys(row, ANSWER_ROW_KEYS) ||
      row['expectedStatus'] !== item.expectedStatus ||
      !['answered', 'insufficient_evidence'].includes(row['status'] as string) ||
      row['questionSha256'] !== sha256(item.question) ||
      typeof row['answerSha256'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(row['answerSha256']) ||
      (row['responseSha256'] !== null &&
        (typeof row['responseSha256'] !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(row['responseSha256']))) ||
      typeof row['chatCalls'] !== 'number' ||
      !Number.isSafeInteger(row['chatCalls']) ||
      row['chatCalls'] < 0 ||
      row['chatCalls'] > 1 ||
      (row['chatCalls'] === 0
        ? row['responseSha256'] !== null || row['structured'] !== null
        : !isSha256(row['responseSha256'])) ||
      (row['structured'] !== null && typeof row['structured'] !== 'boolean') ||
      !Array.isArray(citations) ||
      typeof row['relevantCitationCount'] !== 'number' ||
      !Number.isSafeInteger(row['relevantCitationCount']) ||
      row['relevantCitationCount'] < 0 ||
      typeof row['latencyMs'] !== 'number' ||
      !Number.isFinite(row['latencyMs']) ||
      row['latencyMs'] < 0 ||
      typeof row['limitationSha256'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(row['limitationSha256']) ||
      !isRecord(semanticReview) ||
      !hasExactKeys(semanticReview, SEMANTIC_REVIEW_KEYS) ||
      ['reviewer', 'claimCount', 'unsupportedClaims', 'supportedCitations', 'coveredClaims'].some(
        (key) => semanticReview[key] !== null,
      )
    ) {
      throw new Error('release_resume_report_invalid');
    }
    const citationIds = new Set<string>();
    let relevantCitationCount = 0;
    for (const candidate of citations) {
      if (!isRecord(candidate) || !hasExactKeys(candidate, CITATION_KEYS)) {
        throw new Error('release_resume_report_invalid');
      }
      const citationId = candidate['id'];
      const revisionId = candidate['documentRevisionId'];
      if (
        typeof citationId !== 'string' ||
        !/^C[1-9]\d*$/u.test(citationId) ||
        citationIds.has(citationId) ||
        !isUuid(revisionId) ||
        typeof candidate['excerptSha256'] !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(candidate['excerptSha256'])
      ) {
        throw new Error('release_resume_report_invalid');
      }
      citationIds.add(citationId);
      if (item.relevantRevisionIds.includes(revisionId)) relevantCitationCount += 1;
    }
    if (row['relevantCitationCount'] !== relevantCitationCount) {
      throw new Error('release_resume_report_invalid');
    }
    if (!retryAnswerIds.includes(id)) {
      const answered = MVP_LIVE_RETRIEVAL_IDS.includes(id as never);
      if (
        row['status'] !== row['expectedStatus'] ||
        row['latencyMs'] > 15_000 ||
        (answered &&
          (row['status'] !== 'answered' ||
            row['chatCalls'] !== 1 ||
            row['structured'] !== true ||
            typeof row['relevantCitationCount'] !== 'number' ||
            row['relevantCitationCount'] < 1 ||
            row['relevantCitationCount'] !== citations.length ||
            row['answerSha256'] === sha256('') ||
            !Array.isArray(row['citations']) ||
            row['citations'].length < 1)) ||
        (!answered &&
          (row['status'] !== 'insufficient_evidence' ||
            row['answerSha256'] !== sha256('') ||
            row['limitationSha256'] === sha256('[]') ||
            row['chatCalls'] !== 0 ||
            row['structured'] !== null ||
            !Array.isArray(row['citations']) ||
            row['citations'].length !== 0))
      ) {
        throw new Error('release_resume_report_invalid');
      }
    }
  }
  return {
    runId: value['runId'],
    reportSha256: sha256(text),
    sourceManifestSha256: code['sourceManifestSha256'],
    retrieval: {
      variants: typedVariants,
      summaries: recomputedSummaries,
      automatedGatesPassed: true,
    },
    answerRows: MVP_LIVE_ANSWER_IDS.map(
      (id) => rows.find((candidate) => isRecord(candidate) && candidate['id'] === id) as AnswerRow,
    ),
    corpusFingerprint: postflight['fingerprint'],
    profileHash: postflight['profileHash'],
    models,
  };
}

async function loadResumeSource(
  reportPath: string,
  labelsSha256: string,
  labels: LiveEvaluationSet,
  retryAnswerIds: readonly string[],
  currentManifest: readonly { path: string; sha256: string }[],
): Promise<ResumeSourceReport> {
  const absolute = await realpath(resolve(root, reportPath));
  const insideOutput = relative(await realpath(outputRoot), absolute);
  if (insideOutput.startsWith('..') || isAbsolute(insideOutput)) {
    throw new Error('release_resume_report_invalid');
  }
  const source = validateResumeSourceReportJson(
    await readFile(absolute, 'utf8'),
    labelsSha256,
    labels,
    retryAnswerIds,
  );
  if (basename(absolute) !== 'report.json' || basename(dirname(absolute)) !== source.runId) {
    throw new Error('release_resume_report_invalid');
  }
  const manifest: unknown = JSON.parse(
    await readFile(join(dirname(absolute), 'source-manifest.json'), 'utf8'),
  );
  validateResumeManifest(manifest, source.sourceManifestSha256, currentManifest);
  return source;
}

/** Only the requested alias repair and resume runner may differ from the measured source. */
export function validateResumeManifest(
  manifest: unknown,
  manifestSha256: string,
  currentManifest: readonly { path: string; sha256: string }[],
): void {
  if (
    !Array.isArray(manifest) ||
    sha256(JSON.stringify(manifest)) !== manifestSha256 ||
    manifest.length !== currentManifest.length ||
    manifest.some(
      (entry: unknown) =>
        !isRecord(entry) ||
        !hasExactKeys(entry, ['path', 'sha256']) ||
        typeof entry['path'] !== 'string' ||
        !isSha256(entry['sha256']),
    )
  )
    throw new Error('release_resume_manifest_invalid');
  const entries = manifest as { path: string; sha256: string }[];
  const byPath = new Map(entries.map((entry) => [entry.path, entry.sha256]));
  if (byPath.size !== entries.length) throw new Error('release_resume_manifest_invalid');
  const allowedChanges = [
    'apps/api/src/release-evaluation-cli.ts',
    'packages/rag/src/context-assembly.ts',
  ];
  for (const current of currentManifest) {
    const previous = byPath.get(current.path);
    if (!previous || (previous !== current.sha256 && !allowedChanges.includes(current.path))) {
      throw new Error('release_resume_source_changed');
    }
  }
}

/** Guard before dispatch, independent of the cumulative ledger and RAG retry settings. */
export function boundResumePorts(ports: { chatPort: ChatPort; embeddingPort: EmbeddingPort }) {
  const calls = { embeddingCalls: 0, chatCalls: 0 };
  const embeddingPort: EmbeddingPort = {
    async embed(request) {
      if (calls.embeddingCalls >= 1) throw new Error('release_resume_call_limit');
      calls.embeddingCalls += 1;
      return ports.embeddingPort.embed(request);
    },
    async embedMany() {
      throw new Error('release_batch_forbidden');
    },
  };
  const chatPort: ChatPort = {
    async complete(request) {
      if (calls.chatCalls >= 1) throw new Error('release_resume_call_limit');
      calls.chatCalls += 1;
      return ports.chatPort.complete(request);
    },
  };
  return { embeddingPort, chatPort };
}

/** Reuse recorded rankings, but recheck their membership and scores against the fixed DB. */
export function validateResumeCorpus(
  source: ResumeSourceReport,
  verified: Pick<Awaited<ReturnType<typeof verifyReleaseCorpus>>, 'summary' | 'byChunk'>,
  labels: LiveEvaluationSet,
): void {
  if (
    verified.summary.fingerprint !== source.corpusFingerprint ||
    verified.summary.profileHash !== source.profileHash
  ) {
    throw new Error('release_resume_corpus_fingerprint_mismatch');
  }
  for (const scores of Object.values(source.retrieval.variants)) {
    for (const score of scores) {
      const item = labels.items.find((candidate) => candidate.id === score.id)!;
      const filter = itemFilter(item);
      const hits = score.chunkIds.map((chunkId, index): SearchHit => {
        const row = verified.byChunk.get(chunkId);
        if (!row || row.revision_id !== score.revisionIds[index]) {
          throw new Error('release_resume_provenance_violation');
        }
        if (
          !row.published_at ||
          !row.rights_eligible ||
          !row.embedding_id ||
          row.status !== 'searchable' ||
          row.source_key !== 'github_releases' ||
          !Number.isFinite(row.published_at.getTime()) ||
          row.published_at.getTime() < Date.parse(FIXED_CORPUS.from) ||
          row.published_at.getTime() >= Date.parse(FIXED_CORPUS.to) ||
          (filter.publishedAfter && row.published_at < filter.publishedAfter) ||
          (filter.publishedBefore && row.published_at >= filter.publishedBefore)
        ) {
          throw new Error('release_resume_eligibility_violation');
        }
        return {
          chunkId,
          documentRevisionId: row.revision_id,
          documentId: row.document_id,
          content: '',
          title: '',
          headingPath: [],
          score: 0,
          publishedAt: row.published_at,
        };
      });
      const recomputed = scoreRetrieval(item, hits, score.latencyMs);
      for (const key of ['recallAt10', 'ndcgAt10', 'repeatedChunkRatio'] as const) {
        if (score[key] !== recomputed[key]) throw new Error('release_resume_score_mismatch');
      }
    }
  }
}

function itemInput(item: LiveEvaluationItem) {
  return {
    question: item.question,
    timezone: 'UTC',
    ...(item.publishedAfter || item.publishedBeforeExclusive
      ? {
          timeRange: {
            from: item.publishedAfter ?? FIXED_CORPUS.from,
            to: item.publishedBeforeExclusive ?? FIXED_CORPUS.to,
          },
        }
      : {}),
  };
}
function itemFilter(item: LiveEvaluationItem): SearchFilter {
  const parsed = parseQuery({ ...itemInput(item), now: () => new Date(FIXED_CORPUS.to) });
  return {
    status: 'searchable',
    requireApprovedRights: true,
    ...(parsed.entities.length ? { topicSlugs: parsed.entities.map((entity) => entity.id) } : {}),
    ...(parsed.timeRangeSource !== 'unbounded'
      ? {
          publishedAfter: new Date(parsed.timeRange.from),
          publishedBefore: new Date(parsed.timeRange.to),
        }
      : {}),
  };
}
function summarizeRetrieval(rows: readonly RetrievalScore[], items: readonly LiveEvaluationItem[]) {
  const subset = (semantic: boolean) =>
    rows.filter(
      (row) =>
        (items.find((item) => item.id === row.id)?.category === 'target_window') === semantic,
    );
  const recall = (input: readonly RetrievalScore[]) =>
    mean(input.map((row) => row.recallAt10 ?? 0));
  return {
    sampleCount: rows.length,
    recallAt10: recall(rows),
    ndcgAt10: mean(rows.map((row) => row.ndcgAt10 ?? 0)),
    entityRecallAt10: recall(subset(false)),
    semanticRecallAt10: recall(subset(true)),
    duplicateRedundancyAt10: mean(rows.map((row) => row.duplicateRedundancyAt10)),
    warmDbP95Ms: percentile(
      rows.map((row) => row.latencyMs),
      0.95,
    ),
  };
}
function atLeast(value: number | null, threshold: number): boolean {
  return value !== null && Number.isFinite(value) && value >= threshold;
}
function atMost(value: number | null, threshold: number): boolean {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= threshold;
}
async function codeIdentity() {
  const manifest: { path: string; sha256: string }[] = [];
  async function visit(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(ts|json)$/u.test(entry.name)) {
        manifest.push({
          path: relative(root, path).replaceAll('\\', '/'),
          sha256: sha256(await readFile(path, 'utf8')),
        });
      }
    }
  }
  for (const path of [
    'apps/api/src',
    'packages/rag/src',
    'packages/domain/src',
    'packages/database/src',
    'packages/contracts/src',
    'packages/collectors/src',
    'packages/observability/src',
  ])
    await visit(join(root, path));
  return {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty:
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
        .length > 0,
    sourceManifestSha256: sha256(JSON.stringify(manifest)),
    manifest,
  };
}

export async function runReleaseEvaluation(
  mode: Mode,
  onReviewMaterial?: (material: EphemeralReviewMaterial) => void | Promise<void>,
  resumeOptions?: ResumeLiveOptions,
) {
  const labelText = await readFile(
    join(root, 'docs/experiments/cov-009/live-eval-set.proposed.json'),
    'utf8',
  );
  const labelsSha256 = sha256(labelText);
  const labels = validateLiveEvaluationSet(JSON.parse(labelText));
  const history = validateReleaseHistory(
    JSON.parse(await readFile(join(outputRoot, 'prior-usage.json'), 'utf8')),
  );
  const allowance = validateReleaseAllowance(
    JSON.parse(await readFile(join(outputRoot, 'dec-014-allowance.json'), 'utf8')),
    history,
  );
  const coverage = answerSubsetCoverage(labels);
  if (!coverage.countsMatchExpected) throw new Error('answer_subset_counts_mismatch');
  const runId = `eval002-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${mode}`;
  const directory = join(outputRoot, runId);
  await mkdir(directory, { recursive: true });
  const identity = await codeIdentity();
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    task: 'EVAL-002',
    runId,
    mode,
    executedAt: new Date().toISOString(),
    dataset: FIXED_CORPUS,
    labels: { sha256: labelsSha256, status: labels.status, reviewedSha256: null },
    code: { ...identity, manifest: undefined },
    configuration: {
      candidatesPerRetriever: 20,
      fusionLimit: 10,
      rrfK: 60,
      concurrency: 1,
      retries: 0,
      fallback: 0,
      acquisition: false,
      liveSearch: false,
      corpusReembedding: false,
      frozenNow: FIXED_CORPUS.to,
      percentileMethod: 'nearest-rank',
      warmMethod:
        'one untimed FTS/vector pass per question, then sequential timed DB passes; embedding excluded',
      rankingUnit: 'actual first ten chunks; a revision gains relevance only once',
      scoreVersion: RETRIEVAL_SCORE_VERSION,
      historicalComparison:
        'EXP-002 deduplicated revision ranks before cutoff; scores are not directly comparable',
      redundancyUnit: 'repeated document/duplicate-cluster among actual first ten chunks',
      priceBasis: 'token-derived conservative micro-USD ceiling, not a provider invoice',
    },
    answerSubset: coverage,
    baseline: {
      ...baselineApplicability(),
      blockingForMvp: false,
      purpose: 'historical-regression-diagnostic',
    },
    budgetCaps: allowance.caps,
    additionalAllowance: allowance,
    historicalUsage: history,
    retrieval: null,
    answers: null,
    providerCallsThisRun: 0,
    humanReview: {
      liveLabels: 'pending',
      semanticCitationPrecision: null,
      semanticCitationCoverage: null,
      unsupportedClaimRate: null,
      reviewer: null,
      instruction:
        'No semantic judgment can be inferred from citation identity. Review must be tied to answer/evidence hashes.',
    },
    hardInvariants: { security: null, time: null, rights: null, profile: null, provenance: null },
    releaseGatePassed: false,
    blockers: [
      'live_label_review_pending',
      'semantic_answer_review_pending',
      'mvp_live_evaluation_pending',
    ],
  };
  await writeFile(
    join(directory, 'source-manifest.json'),
    JSON.stringify(identity.manifest, null, 2) + '\n',
    { flag: 'wx' },
  );
  let client: ReturnType<typeof createDatabaseClient> | undefined;
  let journal: Awaited<ReturnType<typeof openReleaseJournal>> | undefined;
  let resumeSource: ResumeSourceReport | undefined;
  let settledCallsAtStart = 0;
  try {
    const historicalBudget = createReleaseBudget(history, [], async () => {}).snapshot();
    report['historicalBudget'] = historicalBudget;
    report['allowanceBudget'] = createReleaseBudget(
      history,
      [],
      async () => {},
      allowance,
    ).snapshot();
    if (resumeOptions) {
      if (mode !== 'live') throw new Error('release_resume_mode_invalid');
      resumeSource = await loadResumeSource(
        resumeOptions.reportPath,
        labelsSha256,
        labels,
        resumeOptions.retryAnswerIds,
        identity.manifest,
      );
      const reusedAnswerIds = MVP_LIVE_ANSWER_IDS.filter(
        (id) => !resumeOptions.retryAnswerIds.includes(id),
      );
      report['resume'] = {
        sourceRunId: resumeSource.runId,
        sourceReportSha256: resumeSource.reportSha256,
        sourceManifestSha256: resumeSource.sourceManifestSha256,
        corpusFingerprint: resumeSource.corpusFingerprint,
        reusedRetrievalIds: MVP_LIVE_RETRIEVAL_IDS,
        reusedAnswerIds,
        retriedAnswerIds: [...resumeOptions.retryAnswerIds],
        reusedRetrievalSha256: sha256(JSON.stringify(resumeSource.retrieval)),
        reusedAnswerRowsSha256: sha256(
          JSON.stringify(
            resumeSource.answerRows.filter((row) => reusedAnswerIds.some((id) => id === row.id)),
          ),
        ),
        providerCallUpperBound: {
          embeddingCalls: resumeOptions.retryAnswerIds.length,
          chatCalls: resumeOptions.retryAnswerIds.length,
        },
      };
    }
    if (mode === 'plan') return report;
    // DEC-014 is a separately tracked tranche. Historical counters remain visible but do not
    // consume this explicitly approved additional allowance.
    if (mode === 'live') createReleaseBudget(history, [], async () => {}, allowance).assertReady();
    const config = loadApiConfig();
    const bindings = createApprovedApiModelBindings(config);
    if (!bindings?.embedding) throw new Error('release_approved_models_unavailable');
    report['models'] = {
      chat: { profile: bindings.chat.profile, caps: bindings.chat.caps },
      embedding: { profile: bindings.embedding.profile, caps: bindings.embedding.caps },
    };
    if (resumeSource && !isDeepStrictEqual(resumeSource.models, report['models'])) {
      throw new Error('release_resume_models_mismatch');
    }
    client = createDatabaseClient({
      databaseUrl: config.databaseUrl,
      maxConnections: 1,
      connectionTimeoutMillis: 10_000,
    });
    const verified = await verifyReleaseCorpus(client, bindings, labels);
    if (resumeSource) validateResumeCorpus(resumeSource, verified, labels);
    report['preflight'] = verified.summary;
    report['answerSubset'] = verified.answerSubset;
    const scopedCoverage = [];
    for (const [target, topics] of Object.entries(verified.targetTopics).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const coverageRepository = createCoverageRepository(client.db, {
        embeddingProfile: bindings.embedding.profile,
        scopeKeys: [FIXED_CORPUS.runKey, `${FIXED_CORPUS.runKey}-incremental`],
        targetIdentities: [target],
      });
      scopedCoverage.push({
        target,
        topicIds: topics,
        report: await coverageRepository.getCoverage(
          { from: new Date(FIXED_CORPUS.from), to: new Date(FIXED_CORPUS.to) },
          [],
          new Date(),
        ),
      });
    }
    report['coverageScope'] =
      'canonical target identity; persisted topic assignments may be empty and are not fabricated';
    report['scopedCoverage'] = scopedCoverage;
    if (mode === 'preflight') return report;
    const search = createSearchService(client.db, { revisionIds: verified.revisionIds });
    const logger = createStructuredLogger({ service: 'release-evaluation', sink: () => {} });
    const negatives = labels.items.filter((item) => item.category === 'coverage_negative');
    if (mode === 'negative-diagnostic') {
      let forbiddenChatCalls = 0;
      const service = createAnswerService({
        searchService: search,
        chatPort: {
          async complete() {
            forbiddenChatCalls += 1;
            throw new Error('diagnostic_chat_forbidden');
          },
        },
        allowLexicalFallback: false,
        allowEmbeddingFallback: false,
        maxValidationRetries: 0,
        enableLiveSearch: false,
        now: () => new Date(FIXED_CORPUS.to),
        logger,
      });
      const rows = [];
      for (const item of negatives) {
        const started = performance.now();
        const answer = await service.generateAnswer({
          ...itemInput(item),
          requestId: `${runId}-${item.id}`,
        });
        rows.push({
          id: item.id,
          expectedStatus: item.expectedStatus,
          status: answer.status,
          citationCount: answer.citations.length,
          latencyMs: performance.now() - started,
          limitationCount: answer.coverage.limitations.length,
          limitationSha256: sha256(JSON.stringify(answer.coverage.limitations)),
        });
      }
      report['negativeDiagnostic'] = {
        rows,
        forbiddenChatCalls,
        providerCalls: 0,
        scope: 'real fixed DB lexical path only; NOT the hybrid/provider release gate',
        passed:
          forbiddenChatCalls === 0 &&
          rows.length === 6 &&
          rows.every(
            (row) =>
              row.status === row.expectedStatus &&
              row.citationCount === 0 &&
              row.limitationCount > 0,
          ),
      };
      return report;
    }
    journal = await openReleaseJournal(
      join(outputRoot, 'dec-014-ledger.jsonl'),
      history,
      allowance,
    );
    const initialUsage = journal.budget.snapshot().usage;
    report['budgetAtStart'] = journal.budget.snapshot();
    settledCallsAtStart = initialUsage.chatCalls + initialUsage.embeddingCalls;
    journal.budget.assertReady();
    if (resumeOptions) {
      const budget = journal.budget.snapshot();
      const retries = resumeOptions.retryAnswerIds.length;
      if (
        budget.usage.embeddingCalls + retries > budget.caps.embeddingCalls ||
        budget.usage.chatCalls + retries > budget.caps.chatCalls
      ) {
        throw new Error('release_resume_budget_insufficient');
      }
    }
    const runtime = createBudgetedApiModels(client.db, bindings, { reserveFullInputCap: true });
    if (!runtime.embeddingPort) throw new Error('release_embedding_binding_required');
    const budgetedPorts = wrapReleasePorts(
      { chatPort: runtime.chatPort, embeddingPort: runtime.embeddingPort },
      bindings,
      journal.budget,
    );
    const ports = resumeSource ? boundResumePorts(budgetedPorts) : budgetedPorts;
    const retrievalItems = MVP_LIVE_RETRIEVAL_IDS.map((id) =>
      labels.items.find((item) => item.id === id)!,
    );
    const variants: Record<'fts' | 'vector' | 'hybrid', RetrievalScore[]> = resumeSource
      ? resumeSource.retrieval.variants
      : { fts: [], vector: [], hybrid: [] };
    const inspectHits = (item: LiveEvaluationItem, hits: readonly SearchHit[]) => {
      const filter = itemFilter(item);
      for (const hit of hits) {
        const persisted = verified.byChunk.get(hit.chunkId);
        if (
          !persisted ||
          persisted.revision_id !== hit.documentRevisionId ||
          persisted.document_id !== hit.documentId ||
          hit.sourceKey !== persisted.source_key
        )
          throw new Error('release_provenance_violation');
        if (
          !hit.publishedAt ||
          (filter.publishedAfter && hit.publishedAt < filter.publishedAfter) ||
          (filter.publishedBefore && hit.publishedAt >= filter.publishedBefore)
        )
          throw new Error('release_time_violation');
      }
    };
    report['retrieval'] = { variants };
    if (!resumeSource) {
      for (const item of retrievalItems) {
        const embedding = await ports.embeddingPort.embed({ input: item.question });
        const ftsRequest = { query: item.question, filter: itemFilter(item), limit: 20 };
        const vectorRequest = {
          vector: embedding.vector,
          dimensions: bindings.embedding.profile.dimensions,
          provider: bindings.embedding.profile.provider,
          model: bindings.embedding.profile.model,
          profileHash: collectionHash(bindings.embedding.profile),
          filter: itemFilter(item),
          limit: 20,
        };
        // Warmup is DB-only; the single query embedding is reused for all variants.
        await search.searchFts(ftsRequest);
        await search.searchExactVector(vectorRequest);
        const ftsStart = performance.now();
        const fts = await search.searchFts(ftsRequest);
        const ftsMs = performance.now() - ftsStart;
        const vectorStart = performance.now();
        const vector = await search.searchExactVector(vectorRequest);
        const vectorMs = performance.now() - vectorStart;
        const hybrid = fuseRetrievalCandidates([fts, vector], {
          limit: 10,
          now: new Date(FIXED_CORPUS.to),
        });
        inspectHits(item, fts);
        inspectHits(item, vector);
        inspectHits(item, hybrid);
        variants.fts.push(scoreRetrieval(item, fts, ftsMs));
        variants.vector.push(scoreRetrieval(item, vector, vectorMs));
        variants.hybrid.push(scoreRetrieval(item, hybrid, ftsMs + vectorMs));
      }
    }
    const summaries = resumeSource
      ? resumeSource.retrieval.summaries
      : {
          fts: summarizeRetrieval(variants.fts, retrievalItems),
          vector: summarizeRetrieval(variants.vector, retrievalItems),
          hybrid: summarizeRetrieval(variants.hybrid, retrievalItems),
        };
    const hybrid = summaries.hybrid;
    const retrievalAutomatedGatePassed =
      hybrid.sampleCount === MVP_LIVE_RETRIEVAL_IDS.length &&
      atLeast(hybrid.recallAt10, 0.8) &&
      atMost(hybrid.warmDbP95Ms, 500);
    report['retrieval'] = {
      variants,
      summaries,
      automatedGatesPassed: retrievalAutomatedGatePassed,
    };
    const answerRows: AnswerRow[] = [];
    report['answers'] = { rows: answerRows };
    const answerItems = MVP_LIVE_ANSWER_IDS.map((id) =>
      labels.items.find((item) => item.id === id)!,
    );
    for (const item of answerItems) {
      const reusable = resumeSource?.answerRows.find((row) => row.id === item.id);
      if (reusable && !resumeOptions?.retryAnswerIds.includes(item.id)) {
        answerRows.push(reusable);
        continue;
      }
      let chatCalls = 0;
      let structured = false;
      let responseSha256: string | null = null;
      const service = createAnswerService({
        searchService: {
          async searchFts(params) {
            const hits = await search.searchFts(params);
            inspectHits(item, hits);
            return hits;
          },
          async searchExactVector(params) {
            const hits = await search.searchExactVector(params);
            inspectHits(item, hits);
            return hits;
          },
        },
        chatPort: {
          async complete(request) {
            chatCalls += 1;
            const result = await ports.chatPort.complete(request);
            structured = isStrictAnswerObject(result.content);
            responseSha256 = sha256(result.content);
            return result;
          },
        },
        embeddingPort: ports.embeddingPort,
        embeddingProvider: bindings.embedding.profile.provider,
        embeddingProfileHash: collectionHash(bindings.embedding.profile),
        allowEmbeddingFallback: false,
        allowLexicalFallback: false,
        maxValidationRetries: 0,
        enableLiveSearch: false,
        defaultTimeoutMs: 15_000,
        now: () => new Date(FIXED_CORPUS.to),
        logger,
      });
      const started = performance.now();
      const answer = await service.generateAnswer({
        ...itemInput(item),
        requestId: `${runId}-${item.id}`,
      });
      const latencyMs = performance.now() - started;
      if (item.expectedStatus === 'answered' && onReviewMaterial) {
        await onReviewMaterial({
          id: item.id,
          question: item.question,
          answer: answer.answer ?? '',
          questionSha256: sha256(item.question),
          answerSha256: sha256(answer.answer ?? ''),
          citations: answer.citations.map((citation) => ({
            id: citation.id,
            documentRevisionId: citation.documentRevisionId,
            title: citation.title,
            source: citation.source,
            url: citation.url,
            publishedAt: citation.publishedAt,
            excerpt: citation.excerpt ?? null,
            excerptIsVerbatim: citation.excerptIsVerbatim,
          })),
        });
      }
      const cited = answer.citations.map((citation) => ({
        id: citation.id,
        documentRevisionId: citation.documentRevisionId,
        excerptSha256: sha256(citation.excerpt ?? ''),
      }));
      answerRows.push({
        id: item.id,
        expectedStatus: item.expectedStatus,
        status: answer.status,
        questionSha256: sha256(item.question),
        responseSha256,
        answerSha256: sha256(answer.answer ?? ''),
        chatCalls,
        structured: chatCalls === 0 ? null : structured,
        citations: cited,
        relevantCitationCount: cited.filter((citation) =>
          item.relevantRevisionIds.includes(citation.documentRevisionId),
        ).length,
        latencyMs,
        limitationSha256: sha256(JSON.stringify(answer.coverage.limitations)),
        semanticReview: {
          reviewer: null,
          claimCount: null,
          unsupportedClaims: null,
          supportedCitations: null,
          coveredClaims: null,
        },
      });
    }
    const generated = answerRows.filter((row) => row.chatCalls > 0);
    const negativeRows = answerRows.filter((row) => row.expectedStatus === 'insufficient_evidence');
    const statusGatePassed =
      answerRows.length === MVP_LIVE_ANSWER_IDS.length &&
      answerRows.every((row) => row.status === row.expectedStatus);
    const answeredRows = answerRows.filter((row) => row.expectedStatus === 'answered');
    const citationPresenceGatePassed =
      answeredRows.length === MVP_LIVE_RETRIEVAL_IDS.length &&
      answeredRows.every((row) => row.status === 'answered' && row.relevantCitationCount > 0);
    const structuredOutputRate = mean(generated.map((row) => (row.structured ? 1 : 0)));
    const abstentionRate = mean(
      negativeRows.map((row) => (row.status === 'insufficient_evidence' ? 1 : 0)),
    );
    const p95LatencyMs = percentile(
      answerRows.map((row) => row.latencyMs),
      0.95,
    );
    const answerAutomatedGatePassed =
      statusGatePassed &&
      citationPresenceGatePassed &&
      structuredOutputRate === 1 &&
      abstentionRate === 1 &&
      atMost(p95LatencyMs, 15_000);
    report['answers'] = {
      rows: answerRows,
      sampleCount: answerRows.length,
      structuredOutputRate,
      abstentionRate,
      p95LatencyMs,
      statusGatePassed,
      citationPresenceGatePassed,
      automatedGatesPassed: answerAutomatedGatePassed,
      semanticMetrics: null,
      semanticGatePassed: false,
    };
    journal.budget.assertReady();
    const postflight = await verifyReleaseCorpus(client, bindings, labels);
    if (postflight.summary.fingerprint !== verified.summary.fingerprint)
      throw new Error('fixed_corpus_changed_during_run');
    report['postflight'] = postflight.summary;
    report['hardInvariants'] = {
      security: null,
      time: 0,
      rights: 0,
      profile: 0,
      provenance: 0,
      scope: 'fixed MVP live subset; security remains covered by deterministic SEC-003/RAG tests',
    };
    const automatedMvpGatePassed = retrievalAutomatedGatePassed && answerAutomatedGatePassed;
    report['automatedMvpGatePassed'] = automatedMvpGatePassed;
    if (automatedMvpGatePassed) {
      report['blockers'] = (report['blockers'] as string[]).filter(
        (blocker) => blocker !== 'mvp_live_evaluation_pending',
      );
    }
    report['releaseGatePassed'] =
      automatedMvpGatePassed &&
      (report['blockers'] as string[]).length === 0 &&
      report['answers'] !== null &&
      (report['answers'] as { semanticGatePassed?: boolean }).semanticGatePassed === true;
    return report;
  } catch (error) {
    // Known local codes only. Never serialize arbitrary provider/DB error strings, causes or stacks.
    const message = error instanceof Error ? error.message : '';
    report['executionFailure'] = /^(release|fixed_corpus|live_labels)_[a-z0-9_]+$/u.test(message)
      ? message
      : 'release_execution_failed';
    report['releaseGatePassed'] = false;
    return report;
  } finally {
    if (journal) {
      report['budget'] = journal.budget.snapshot();
      const totals = journal.budget.snapshot().usage;
      report['providerCallsThisRun'] =
        totals.embeddingCalls + totals.chatCalls - settledCallsAtStart;
      report['callCountBasis'] =
        'successfully settled calls this run; unknown calls remain separately reserved in budget.outstanding';
    }
    try {
      await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
        flag: 'wx',
      });
    } finally {
      await journal?.close();
      await client?.close();
    }
    console.log(
      JSON.stringify({
        runId,
        report: relative(root, join(directory, 'report.json')).replaceAll('\\', '/'),
        mode,
        providerCallsThisRun: report['providerCallsThisRun'],
        releaseGatePassed: report['releaseGatePassed'],
        failure: report['executionFailure'] ?? null,
      }),
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv.slice(2);
  const modeArguments = argument.filter((value) => value.startsWith('--mode='));
  const resumeArguments = argument.filter((value) => value.startsWith('--resume-report='));
  const retryArguments = argument.filter((value) => value.startsWith('--retry-answer='));
  const showReview = argument.includes('--show-review');
  const mode = modeArguments[0]?.replace(/^--mode=/u, '') ?? 'plan';
  const resumeReport = resumeArguments[0]?.replace(/^--resume-report=/u, '') ?? null;
  const retryAnswerIds = retryArguments.map((value) => value.replace(/^--retry-answer=/u, ''));
  const resumeRequested = resumeReport !== null || retryAnswerIds.length > 0;
  if (
    modeArguments.length > 1 ||
    resumeArguments.length > 1 ||
    argument.some(
      (value) =>
        !value.startsWith('--mode=') &&
        !value.startsWith('--resume-report=') &&
        !value.startsWith('--retry-answer=') &&
        value !== '--show-review',
    ) ||
    !modes.includes(mode as Mode) ||
    (showReview && mode !== 'live') ||
    (resumeRequested &&
      (mode !== 'live' ||
        !resumeReport?.trim() ||
        retryAnswerIds.length === 0 ||
        retryAnswerIds.some((id) => !id.trim())))
  ) {
    console.error(
      'usage: release-evaluation-cli.ts --mode=plan|preflight|negative-diagnostic|live [--show-review] [--resume-report=PATH --retry-answer=ID ...]',
    );
    process.exitCode = 1;
  } else {
    runReleaseEvaluation(
      mode as Mode,
      showReview
        ? (material) => {
            process.stderr.write(`EPHEMERAL_REVIEW ${JSON.stringify(material)}\n`);
          }
        : undefined,
      resumeReport ? { reportPath: resumeReport, retryAnswerIds } : undefined,
    )
      .then((report) => {
        if (report['executionFailure'] || (mode === 'live' && !report['releaseGatePassed'])) {
          process.exitCode = 2;
        }
      })
      .catch(() => {
        console.error('release_initialization_failed');
        process.exitCode = 1;
      });
  }
}
