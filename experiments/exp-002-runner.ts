import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createApprovedApiModelBindings } from '../apps/api/src/approved-models.js';
import { loadApiConfig } from '../apps/api/src/config.js';
import { createDatabaseClient } from '@techpulse/database';
import { collectionHash, extractSearchKeywords, type ModelProfile } from '@techpulse/domain';
import { sql } from 'drizzle-orm';

const RUN_KEY = 'cov009-20260910-live-v1';
const DATASET_PATH = 'docs/experiments/cov-009/live-eval-set.proposed.json';
const OUTPUT_PATH = 'docs/experiments/exp-002/live-measurement.json';
const MAX_CALLS = 100;
const MAX_INPUT_TOKENS = 100_000;
const MAX_MICRO_USD = 250_000;
const RRF_K = 60;

interface EvaluationItem {
  readonly id: string;
  readonly category: 'target_latest' | 'release_exact' | 'target_window' | 'coverage_negative';
  readonly question: string;
  readonly expectedStatus: 'answered' | 'insufficient_evidence';
  readonly relevantRevisionIds: readonly string[];
  readonly publishedAfter: string | null;
  readonly publishedBeforeExclusive: string | null;
}

interface EvaluationSet {
  readonly schemaVersion: 1;
  readonly status: string;
  readonly dataset: {
    readonly runKey: string;
    readonly sha256: string;
    readonly revisions: number;
    readonly chunks: number;
  };
  readonly items: readonly EvaluationItem[];
}

interface RankedRow {
  readonly chunk_id: string;
  readonly document_id: string;
  readonly revision_id: string;
  readonly published_at: string | null;
  readonly source_key: string | null;
  readonly license_id: string | null;
  readonly canonical_url: string | null;
  readonly score: number;
}

interface VariantObservation {
  readonly id: string;
  readonly rankedRevisionIds: readonly string[];
  readonly recallAt10: number;
  readonly ndcgAt10: number;
  readonly reciprocalRank: number;
  readonly latencyMs: number;
  readonly timeViolations: number;
  readonly provenanceViolations: number;
  readonly duplicateRedundancyAt10: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rankedRevisions(rows: readonly RankedRow[], limit = 10): RankedRow[] {
  const seen = new Set<string>();
  const revisions: RankedRow[] = [];
  for (const row of rows) {
    if (seen.has(row.revision_id)) continue;
    seen.add(row.revision_id);
    revisions.push(row);
    if (revisions.length >= limit) break;
  }
  return revisions;
}

function scoreObservation(
  item: EvaluationItem,
  rows: readonly RankedRow[],
  latencyMs: number,
): VariantObservation {
  const ranked = rankedRevisions(rows);
  const relevant = new Set(item.relevantRevisionIds);
  const relevantRanks = ranked
    .map((row, index) => (relevant.has(row.revision_id) ? index + 1 : null))
    .filter((rank): rank is number => rank !== null);
  const recallAt10 = relevant.size === 0 ? 1 : relevantRanks.length / relevant.size;
  const dcg = relevantRanks.reduce((sum, rank) => sum + 1 / Math.log2(rank + 1), 0);
  const idealCount = Math.min(10, relevant.size);
  let idealDcg = 0;
  for (let rank = 1; rank <= idealCount; rank += 1) idealDcg += 1 / Math.log2(rank + 1);
  const publishedAfter = item.publishedAfter ? Date.parse(item.publishedAfter) : null;
  const publishedBefore = item.publishedBeforeExclusive
    ? Date.parse(item.publishedBeforeExclusive)
    : null;
  const timeViolations = ranked.filter((row) => {
    if (publishedAfter === null && publishedBefore === null) return false;
    if (!row.published_at) return true;
    const value = Date.parse(row.published_at);
    return (
      (publishedAfter !== null && value < publishedAfter) ||
      (publishedBefore !== null && value >= publishedBefore)
    );
  }).length;
  const provenanceViolations = ranked.filter(
    (row) =>
      row.source_key !== 'github_releases' ||
      !row.license_id ||
      !row.canonical_url?.startsWith('https://github.com/'),
  ).length;
  const uniqueDocuments = new Set(ranked.map((row) => row.document_id)).size;

  return {
    id: item.id,
    rankedRevisionIds: ranked.map((row) => row.revision_id),
    recallAt10,
    ndcgAt10: idealDcg === 0 ? 1 : dcg / idealDcg,
    reciprocalRank: relevantRanks[0] ? 1 / relevantRanks[0] : 0,
    latencyMs,
    timeViolations,
    provenanceViolations,
    duplicateRedundancyAt10: ranked.length === 0 ? 0 : 1 - uniqueDocuments / ranked.length,
  };
}

function rrfMerge(left: readonly RankedRow[], right: readonly RankedRow[]): RankedRow[] {
  const scores = new Map<string, { row: RankedRow; score: number }>();
  for (const rows of [left, right]) {
    rows.forEach((row, index) => {
      const existing = scores.get(row.chunk_id);
      scores.set(row.chunk_id, {
        row,
        score: (existing?.score ?? 0) + 1 / (RRF_K + index + 1),
      });
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.row.chunk_id.localeCompare(b.row.chunk_id))
    .map(({ row, score }) => ({ ...row, score }));
}

async function searchFts(
  db: ReturnType<typeof createDatabaseClient>['db'],
  item: EvaluationItem,
): Promise<RankedRow[]> {
  const keywords = extractSearchKeywords(item.question);
  const technical = keywords.filter((value) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value));
  const candidates = [
    item.question,
    keywords.join(' '),
    technical.join(' '),
    ...technical,
  ].filter((value, index, values) => value.trim().length > 0 && values.indexOf(value) === index);
  for (const query of candidates) {
    const result = await db.execute<RankedRow>(sql`
      SELECT c.id::text AS chunk_id, dr.document_id::text AS document_id,
             dr.id::text AS revision_id, dr.published_at::text AS published_at,
             s.key AS source_key, dr.license_id, raw.canonical_url,
             ts_rank(to_tsvector('simple', dr.title || ' ' || c.content), plainto_tsquery('simple', ${query}))::float AS score
      FROM chunks c
      JOIN document_revisions dr ON dr.id = c.document_revision_id
      JOIN raw_items raw ON raw.id = dr.raw_item_id
      JOIN sources s ON s.id = raw.source_id
      WHERE dr.status = 'searchable'
        AND dr.lexical_ready_at IS NOT NULL
        AND s.enabled = true AND s.policy_reviewed_at IS NOT NULL
        AND raw.rights_metadata ->> 'approved' = 'true'
        AND raw.rights_metadata ->> 'store' = 'true'
        AND raw.rights_metadata ->> 'modelInput' = 'true'
        AND raw.rights_metadata ->> 'displayExcerpt' = 'true'
        AND EXISTS (
          SELECT 1 FROM acquisition_memberships a
          JOIN collection_partitions p ON p.id = a.partition_id
          WHERE a.revision_id = dr.id AND p.scope_key = ${RUN_KEY} AND p.mode = 'backfill'
        )
        ${item.publishedAfter ? sql`AND dr.published_at >= ${new Date(item.publishedAfter)}` : sql``}
        ${item.publishedBeforeExclusive ? sql`AND dr.published_at < ${new Date(item.publishedBeforeExclusive)}` : sql``}
        AND to_tsvector('simple', dr.title || ' ' || c.content) @@ plainto_tsquery('simple', ${query})
      ORDER BY score DESC, dr.published_at DESC NULLS LAST, c.ordinal
      LIMIT 50`);
    if (result.rows.length > 0) return result.rows;
  }
  return [];
}

async function searchVector(
  db: ReturnType<typeof createDatabaseClient>['db'],
  item: EvaluationItem,
  vector: readonly number[],
  profile: ModelProfile,
): Promise<RankedRow[]> {
  const vectorLiteral = `[${vector.join(',')}]`;
  const profileHash = collectionHash(profile);
  const result = await db.execute<RankedRow>(sql`
    SELECT c.id::text AS chunk_id, dr.document_id::text AS document_id,
           dr.id::text AS revision_id, dr.published_at::text AS published_at,
           s.key AS source_key, dr.license_id, raw.canonical_url,
           (1 - (e.embedding <=> ${vectorLiteral}::vector))::float AS score
    FROM embeddings e
    JOIN chunks c ON c.id = e.chunk_id
    JOIN document_revisions dr ON dr.id = c.document_revision_id
    JOIN raw_items raw ON raw.id = dr.raw_item_id
    JOIN sources s ON s.id = raw.source_id
    WHERE dr.status = 'searchable'
      AND s.enabled = true AND s.policy_reviewed_at IS NOT NULL
      AND raw.rights_metadata ->> 'approved' = 'true'
      AND raw.rights_metadata ->> 'store' = 'true'
      AND raw.rights_metadata ->> 'modelInput' = 'true'
      AND raw.rights_metadata ->> 'embed' = 'true'
      AND raw.rights_metadata ->> 'displayExcerpt' = 'true'
      AND e.provider = ${profile.provider} AND e.model = ${profile.model}
      AND e.dimensions = ${profile.dimensions} AND e.profile_hash = ${profileHash}
      AND e.input_hash = c.content_hash
      AND EXISTS (
        SELECT 1 FROM acquisition_memberships a
        JOIN collection_partitions p ON p.id = a.partition_id
        WHERE a.revision_id = dr.id AND p.scope_key = ${RUN_KEY} AND p.mode = 'backfill'
      )
      ${item.publishedAfter ? sql`AND dr.published_at >= ${new Date(item.publishedAfter)}` : sql``}
      ${item.publishedBeforeExclusive ? sql`AND dr.published_at < ${new Date(item.publishedBeforeExclusive)}` : sql``}
    ORDER BY e.embedding <=> ${vectorLiteral}::vector, dr.published_at DESC NULLS LAST, c.ordinal
    LIMIT 50`);
  return result.rows;
}

function summarize(observations: readonly VariantObservation[]) {
  return {
    recallAt10: mean(observations.map((item) => item.recallAt10)),
    ndcgAt10: mean(observations.map((item) => item.ndcgAt10)),
    mrr: mean(observations.map((item) => item.reciprocalRank)),
    p50DbLatencyMs: percentile(
      observations.map((item) => item.latencyMs),
      0.5,
    ),
    p95DbLatencyMs: percentile(
      observations.map((item) => item.latencyMs),
      0.95,
    ),
    timeViolations: observations.reduce((sum, item) => sum + item.timeViolations, 0),
    provenanceViolations: observations.reduce(
      (sum, item) => sum + item.provenanceViolations,
      0,
    ),
    duplicateRedundancyAt10: mean(observations.map((item) => item.duplicateRedundancyAt10)),
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_DIRECT?.trim() || required('DATABASE_URL');
  const evaluationSet = JSON.parse(await readFile(DATASET_PATH, 'utf8')) as EvaluationSet;
  assert.equal(evaluationSet.schemaVersion, 1);
  assert.equal(evaluationSet.dataset.runKey, RUN_KEY);
  const items = evaluationSet.items.filter((item) => item.expectedStatus === 'answered');
  assert(items.length > 0 && items.length <= MAX_CALLS);
  assert(items.every((item) => item.relevantRevisionIds.length >= 1));
  assert(items.every((item) => item.relevantRevisionIds.length <= 5));

  const bindings = createApprovedApiModelBindings(loadApiConfig(process.env));
  assert(bindings?.embedding, 'approved embedding binding is required');
  const embedding = bindings.embedding;
  const estimatedTokens = items.reduce((sum, item) => sum + Math.ceil(item.question.length / 4), 0);
  assert(estimatedTokens <= MAX_INPUT_TOKENS, 'query embedding token preflight exceeded');

  const client = createDatabaseClient(databaseUrl);
  await client.connect();
  try {
    assert.equal((await client.checkVector()).installed, true);
    const hashRows = await client.db.execute<{ payload_hash: string }>(sql`
      SELECT DISTINCT raw.payload_hash
      FROM raw_items raw
      JOIN acquisition_memberships a ON a.raw_item_id = raw.id
      JOIN collection_partitions p ON p.id = a.partition_id
      WHERE p.scope_key IN (${RUN_KEY}, ${`${RUN_KEY}-incremental`})
      ORDER BY raw.payload_hash`);
    const datasetHash = createHash('sha256')
      .update(hashRows.rows.map((row) => row.payload_hash).join('\n'))
      .digest('hex');
    assert.equal(datasetHash, evaluationSet.dataset.sha256, 'dataset hash drifted');

    const fts: VariantObservation[] = [];
    const vector: VariantObservation[] = [];
    const hybrid: VariantObservation[] = [];
    const embeddingLatencies: number[] = [];
    let calls = 0;
    let actualTokens = 0;
    let actualMicroUsd = 0;

    for (const item of items) {
      if (calls + 1 > MAX_CALLS || actualTokens >= MAX_INPUT_TOKENS) {
        throw new Error('DEC-013 query embedding cap reached');
      }
      const embedStarted = performance.now();
      const embedded = await embedding.port.embed({
        input: item.question,
        model: embedding.profile.model,
        timeoutMs: Math.min(embedding.caps.timeoutMs, 10_000),
      });
      embeddingLatencies.push(performance.now() - embedStarted);
      calls += 1;
      actualTokens += embedded.metadata.usage.totalTokens;
      actualMicroUsd = Math.ceil(
        (actualTokens * embedding.priceRate.unitsPerThousandTokens) / 1000,
      );
      if (actualTokens > MAX_INPUT_TOKENS || actualMicroUsd > MAX_MICRO_USD) {
        throw new Error('DEC-013 query embedding token or spend cap exceeded');
      }

      const ftsStarted = performance.now();
      const ftsRows = await searchFts(client.db, item);
      const ftsLatency = performance.now() - ftsStarted;
      const vectorStarted = performance.now();
      const vectorRows = await searchVector(client.db, item, embedded.vector, embedding.profile);
      const vectorLatency = performance.now() - vectorStarted;
      const hybridStarted = performance.now();
      const hybridRows = rrfMerge(ftsRows, vectorRows);
      const hybridLatency = ftsLatency + vectorLatency + (performance.now() - hybridStarted);
      fts.push(scoreObservation(item, ftsRows, ftsLatency));
      vector.push(scoreObservation(item, vectorRows, vectorLatency));
      hybrid.push(scoreObservation(item, hybridRows, hybridLatency));
    }

    const variants = {
      ftsOnly: { metrics: summarize(fts), observations: fts },
      vectorExact: { metrics: summarize(vector), observations: vector },
      hybridExactRrf: { metrics: summarize(hybrid), observations: hybrid },
    };
    const hybridMetrics = variants.hybridExactRrf.metrics;
    const entityItems = new Set(
      items
        .filter((item) => item.category !== 'target_window')
        .map((item) => item.id),
    );
    const semanticItems = new Set(
      items.filter((item) => item.category === 'target_window').map((item) => item.id),
    );
    const entityRecall = mean(
      hybrid.filter((item) => entityItems.has(item.id)).map((item) => item.recallAt10),
    );
    const semanticRecall = mean(
      hybrid.filter((item) => semanticItems.has(item.id)).map((item) => item.recallAt10),
    );
    const checks = {
      recallAt10: hybridMetrics.recallAt10 >= 0.8,
      ndcgAt10: hybridMetrics.ndcgAt10 >= 0.75,
      entityRecallAt10: entityRecall >= 0.75,
      semanticRecallAt10: semanticRecall >= 0.75,
      timeViolations: hybridMetrics.timeViolations === 0,
      provenanceViolations: hybridMetrics.provenanceViolations === 0,
      duplicateRedundancyAt10: hybridMetrics.duplicateRedundancyAt10 <= 0.2,
      warmDbP95: hybridMetrics.p95DbLatencyMs <= 500,
      queryCalls: calls <= MAX_CALLS,
      queryTokens: actualTokens <= MAX_INPUT_TOKENS,
      spend: actualMicroUsd <= MAX_MICRO_USD,
    };
    const report = {
      schemaVersion: 1,
      task: 'EXP-002',
      executedAt: new Date().toISOString(),
      dataset: evaluationSet.dataset,
      configuration: {
        rrfK: RRF_K,
        resultLimit: 50,
        evaluationCutoff: 10,
        vectorIndex: 'exact',
        concurrency: 1,
        retry: 0,
        profile: embedding.profile,
        profileHash: collectionHash(embedding.profile),
      },
      queryEmbeddingUsage: {
        calls,
        actualTokens,
        actualMicroUsd,
        actualUsd: actualMicroUsd / 1_000_000,
        p50LatencyMs: percentile(embeddingLatencies, 0.5),
        p95LatencyMs: percentile(embeddingLatencies, 0.95),
      },
      subsets: { entityRecallAt10: entityRecall, semanticRecallAt10: semanticRecall },
      variants,
      checks,
      gatePassed: Object.values(checks).every(Boolean),
      failedChecks: Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name),
      notes: [
        'Only immutable COV-009 revisions were searched.',
        'Ranked artifacts contain IDs and scores, not source bodies or vectors.',
        'Coverage-negative and answer-generation items are reserved for COV-010/EVAL-002.',
      ],
    };
    await mkdir('docs/experiments/exp-002', { recursive: true });
    await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `${JSON.stringify({ gatePassed: report.gatePassed, failedChecks: report.failedChecks, usage: report.queryEmbeddingUsage, variants: { ftsOnly: variants.ftsOnly.metrics, vectorExact: variants.vectorExact.metrics, hybridExactRrf: variants.hybridExactRrf.metrics } })}\n`,
    );
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
