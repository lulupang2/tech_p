import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createDatabaseClient } from '@techpulse/database';
import { sql } from 'drizzle-orm';

const RUN_KEY = 'cov009-20260910-live-v1';
const MEASUREMENT_PATH = 'docs/experiments/cov-009/live-measurement.json';
const OUTPUT_PATH = 'docs/experiments/cov-009/live-eval-set.proposed.json';
const EXPECTED_TARGETS = [
  'github_releases:facebook/react',
  'github_releases:microsoft/playwright',
  'github_releases:microsoft/typescript',
  'github_releases:nodejs/node',
  'github_releases:pgvector/pgvector',
] as const;

interface Measurement {
  readonly dataset: { readonly sha256: string };
  readonly final: { readonly revisions: number; readonly chunks: number };
}

interface RevisionRow {
  readonly canonical_identity: string;
  readonly revision_id: string;
  readonly title: string;
  readonly published_at: string;
  readonly canonical_url: string;
  readonly chunk_ids: string[];
}

interface EvaluationItem {
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

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function nextUtcDay(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString();
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_DIRECT?.trim() || required('DATABASE_URL');
  const measurement = JSON.parse(await readFile(MEASUREMENT_PATH, 'utf8')) as Measurement;
  assert.match(measurement.dataset.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(measurement.final.revisions, 28);
  assert.equal(measurement.final.chunks, 500);

  const client = createDatabaseClient(databaseUrl);
  await client.connect();
  try {
    const result = await client.db.execute<RevisionRow>(sql`
      SELECT ct.canonical_identity,
             dr.id::text AS revision_id,
             dr.title,
             dr.published_at::text AS published_at,
             raw.canonical_url,
             array_agg(c.id::text ORDER BY c.ordinal) AS chunk_ids
      FROM collection_partitions p
      JOIN collection_target_revisions ctr ON ctr.id = p.target_revision_id
      JOIN collection_targets ct ON ct.id = ctr.target_id
      JOIN acquisition_memberships a ON a.partition_id = p.id
      JOIN document_revisions dr ON dr.id = a.revision_id
      JOIN raw_items raw ON raw.id = dr.raw_item_id
      JOIN chunks c ON c.document_revision_id = dr.id
      WHERE p.scope_key = ${RUN_KEY}
        AND p.mode = 'backfill'
        AND p.state = 'completed'
        AND dr.status = 'searchable'
      GROUP BY ct.canonical_identity, dr.id, dr.title, dr.published_at, raw.canonical_url
      ORDER BY ct.canonical_identity, dr.published_at DESC NULLS LAST, dr.id`);

    assert.equal(result.rows.length, measurement.final.revisions, 'revision count drifted');
    assert.equal(
      unique(result.rows.flatMap((row) => row.chunk_ids)).length,
      measurement.final.chunks,
      'chunk count drifted',
    );

    const byTarget = new Map<string, RevisionRow[]>();
    for (const row of result.rows) {
      const rows = byTarget.get(row.canonical_identity) ?? [];
      rows.push(row);
      byTarget.set(row.canonical_identity, rows);
    }
    assert.deepEqual(
      [...byTarget.keys()].sort(),
      EXPECTED_TARGETS.filter((target) => target !== 'github_releases:pgvector/pgvector'),
      'evidence-bearing target set drifted',
    );

    const items: EvaluationItem[] = [];
    let sequence = 1;
    for (const [target, rows] of [...byTarget.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const repository = target.replace('github_releases:', '');
      const latest = rows[0];
      assert(latest, `${target} has no revisions`);

      items.push({
        id: `L-${String(sequence++).padStart(3, '0')}`,
        category: 'target_latest',
        language: 'ko',
        question: `${repository}의 최신 릴리스에서 바뀐 내용을 알려줘.`,
        expectedStatus: 'answered',
        expectedTarget: target,
        relevantRevisionIds: [latest.revision_id],
        relevantChunkIds: latest.chunk_ids,
        expectedLimitation: null,
        publishedAfter: null,
        publishedBeforeExclusive: null,
      });
      for (const revision of rows) {
        items.push({
          id: `L-${String(sequence++).padStart(3, '0')}`,
          category: 'release_exact',
          language: 'en',
          question: `Summarize ${repository} release "${revision.title}".`,
          expectedStatus: 'answered',
          expectedTarget: target,
          relevantRevisionIds: [revision.revision_id],
          relevantChunkIds: revision.chunk_ids,
          expectedLimitation: null,
          publishedAfter: null,
          publishedBeforeExclusive: null,
        });
      }
      for (let offset = 0; offset < rows.length; offset += 5) {
        const group = rows.slice(offset, offset + 5);
        const oldest = group.at(-1)?.published_at.slice(0, 10);
        const newest = group[0]?.published_at.slice(0, 10);
        assert(oldest && newest, `${target} has invalid publication dates`);
        items.push({
          id: `L-${String(sequence++).padStart(3, '0')}`,
          category: 'target_window',
          language: 'ko',
          question: `${oldest}부터 ${newest}까지 ${repository} 릴리스의 주요 변화를 찾아줘.`,
          expectedStatus: 'answered',
          expectedTarget: target,
          relevantRevisionIds: unique(group.map((row) => row.revision_id)),
          relevantChunkIds: unique(group.flatMap((row) => row.chunk_ids)),
          expectedLimitation: null,
          publishedAfter: `${oldest}T00:00:00.000Z`,
          publishedBeforeExclusive: nextUtcDay(newest),
        });
      }
    }

    const negativeQuestions = [
      [
        '최근 90일 pgvector 릴리스의 주요 변경점을 알려줘.',
        'No pgvector/pgvector release was retained in the COV-009 90-day window.',
        'github_releases:pgvector/pgvector',
      ],
      [
        '최근 Bun npm 다운로드 증가율을 알려줘.',
        'package_downloads source is outside COV-009.',
        null,
      ],
      ['최근 RAG 논문에서 많이 언급된 기술을 알려줘.', 'arXiv source is outside COV-009.', null],
      ['Rust 커뮤니티의 최근 논쟁을 요약해줘.', 'Discourse source is outside COV-009.', null],
      [
        'React의 최근 커뮤니티 언급량 변화를 알려줘.',
        'Community metric sources are outside COV-009.',
        null,
      ],
      [
        'Playwright와 Node.js의 인기도를 종합 점수로 비교해줘.',
        'A combined popularity score is prohibited.',
        null,
      ],
    ] as const;
    for (const [question, limitation, expectedTarget] of negativeQuestions) {
      items.push({
        id: `L-${String(sequence++).padStart(3, '0')}`,
        category: 'coverage_negative',
        language: 'ko',
        question,
        expectedStatus: 'insufficient_evidence',
        expectedTarget,
        relevantRevisionIds: [],
        relevantChunkIds: [],
        expectedLimitation: limitation,
        publishedAfter: null,
        publishedBeforeExclusive: null,
      });
    }

    const artifact = {
      schemaVersion: 1,
      status: 'proposed-human-review-required',
      decision: 'DEC-013',
      dataset: {
        runKey: RUN_KEY,
        sha256: measurement.dataset.sha256,
        revisions: measurement.final.revisions,
        chunks: measurement.final.chunks,
      },
      counts: {
        total: items.length,
        retrievalAnswered: items.filter((item) => item.expectedStatus === 'answered').length,
        coverageNegative: items.filter((item) => item.expectedStatus === 'insufficient_evidence')
          .length,
      },
      labelingRules: [
        'Relevant IDs are immutable revisions/chunks from the fixed COV-009 backfill only.',
        'Latest is the greatest published_at within each target.',
        'Window groups contain at most five relevant revisions and use an exclusive UTC next-day upper bound.',
        'Coverage-negative items must abstain and state the expected limitation.',
        'Approval does not change the existing 43-item golden-set labels.',
      ],
      items,
    };
    await writeFile(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `${JSON.stringify({ output: OUTPUT_PATH, counts: artifact.counts, targets: EXPECTED_TARGETS.length })}\n`,
    );
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
