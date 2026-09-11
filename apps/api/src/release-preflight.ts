import { collectionHash } from '@techpulse/domain';
import type { DatabaseClient } from '@techpulse/database';
import type { ApiModelBindings } from './runtime-models.js';
import {
  FIXED_CORPUS,
  sha256,
  answerSubsetCoverage,
  type LiveEvaluationSet,
} from './release-evaluation.js';

interface CorpusRow {
  raw_id: string;
  payload_hash: string;
  revision_id: string;
  chunk_id: string;
  content_hash: string;
  document_id: string;
  source_key: string;
  target_identity: string;
  published_at: Date | null;
  status: string;
  lexical_ready: boolean;
  rights_eligible: boolean;
  embedding_id: string | null;
}

/** Both supported pool drivers implement this parameterized SELECT surface. */
interface SelectPool {
  query<Row>(text: string, values: unknown[]): Promise<{ rows: Row[] }>;
}

/** SELECT-only preflight. Never migrates, collects, updates budget scopes, or re-embeds. */
export async function verifyReleaseCorpus(
  client: DatabaseClient,
  bindings: ApiModelBindings,
  labels: LiveEvaluationSet,
) {
  const embedding = bindings.embedding;
  if (!embedding) throw new Error('release_embedding_binding_required');
  const profileHash = collectionHash(embedding.profile);
  const pool = client.pool as unknown as SelectPool;
  const scopes = [FIXED_CORPUS.runKey, `${FIXED_CORPUS.runKey}-incremental`];
  const result = await pool.query<CorpusRow>(
    `
    SELECT DISTINCT raw.id AS raw_id, raw.payload_hash, dr.id AS revision_id,
      dr.document_id, c.id AS chunk_id, c.content_hash, src.key AS source_key,
      ct.canonical_identity AS target_identity, dr.published_at, dr.status,
      dr.lexical_ready_at IS NOT NULL AS lexical_ready,
      (src.enabled AND src.policy_reviewed_at IS NOT NULL AND ct.enabled
        AND tr.policy ->> 'approved' = 'true'
        AND tr.policy ->> 'store' = 'true' AND tr.policy ->> 'modelInput' = 'true'
        AND tr.policy ->> 'embed' = 'true' AND tr.policy ->> 'displayExcerpt' = 'true'
        AND raw.rights_metadata ->> 'approved' = 'true'
        AND raw.rights_metadata ->> 'store' = 'true' AND raw.rights_metadata ->> 'modelInput' = 'true'
        AND raw.rights_metadata ->> 'embed' = 'true' AND raw.rights_metadata ->> 'displayExcerpt' = 'true'
      ) IS TRUE AS rights_eligible,
      e.id AS embedding_id
    FROM collection_partitions cp
    JOIN collection_target_revisions tr ON tr.id = cp.target_revision_id
    JOIN collection_targets ct ON ct.id = tr.target_id
    JOIN acquisition_memberships am ON am.partition_id = cp.id
    JOIN raw_items raw ON raw.id = am.raw_item_id
    JOIN sources src ON src.id = raw.source_id AND src.id = ct.source_id
    LEFT JOIN document_revisions dr ON dr.id = am.revision_id AND dr.raw_item_id = raw.id
    LEFT JOIN chunks c ON c.document_revision_id = dr.id
    LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.provider = $2 AND e.model = $3
      AND e.dimensions = $4 AND e.profile_hash = $5 AND e.input_hash = c.content_hash
    WHERE cp.scope_key = ANY($1::text[]) AND cp.mode <> 'on_demand'
    ORDER BY c.id, raw.id`,
    [
      scopes,
      embedding.profile.provider,
      embedding.profile.model,
      embedding.profile.dimensions,
      profileHash,
    ],
  );
  const rows = result.rows;
  const distinct = (key: keyof CorpusRow) => new Set(rows.map((row) => row[key]).filter(Boolean));
  const hashes = [...new Set(rows.map((row) => row.payload_hash))].sort();
  const actual = {
    sha256: sha256(hashes.join('\n')),
    rawItems: distinct('raw_id').size,
    revisions: distinct('revision_id').size,
    chunks: distinct('chunk_id').size,
    embeddings: distinct('embedding_id').size,
  };
  if (
    actual.sha256 !== FIXED_CORPUS.sha256 ||
    actual.rawItems !== 28 ||
    actual.revisions !== 28 ||
    actual.chunks !== 500 ||
    actual.embeddings !== 500
  )
    throw new Error('fixed_corpus_integrity_mismatch');
  if (
    rows.some(
      (row) =>
        row.source_key !== 'github_releases' ||
        !row.rights_eligible ||
        row.status !== 'searchable' ||
        !row.lexical_ready ||
        !row.embedding_id ||
        !row.published_at ||
        new Date(row.published_at).getTime() < Date.parse(FIXED_CORPUS.from) ||
        new Date(row.published_at).getTime() >= Date.parse(FIXED_CORPUS.to),
    )
  ) {
    throw new Error('fixed_corpus_eligibility_violation');
  }
  const revisionIds = [...distinct('revision_id')] as string[];
  const byChunk = new Map(rows.map((row) => [row.chunk_id, row]));
  const answerSubset = answerSubsetCoverage(
    labels,
    [...byChunk.values()].map((row) => ({
      chunkId: row.chunk_id,
      revisionId: row.revision_id,
      target: row.target_identity,
      publishedAt: new Date(row.published_at!).toISOString(),
    })),
  );
  if (!answerSubset.complete) throw new Error('live_labels_incomplete_corpus_coverage');
  const partitions = await pool.query<{
    partitions: number;
    completed: number;
    targets: string[];
    source_keys: string[];
    target_topics: Record<string, string[]>;
  }>(
    `SELECT count(DISTINCT cp.id)::int AS partitions,
      count(DISTINCT cp.id) FILTER (WHERE cp.state = 'completed')::int AS completed,
      array_agg(DISTINCT ct.canonical_identity) AS targets, array_agg(DISTINCT src.key) AS source_keys,
      jsonb_object_agg(ct.canonical_identity, tr.topic_ids) AS target_topics
    FROM collection_partitions cp
    JOIN collection_target_revisions tr ON tr.id = cp.target_revision_id
    JOIN collection_targets ct ON ct.id = tr.target_id
    JOIN sources src ON src.id = ct.source_id
    WHERE cp.scope_key = ANY($1::text[])`,
    [scopes],
  );
  const partition = partitions.rows[0];
  const expectedTargets = [
    'facebook/react',
    'microsoft/typescript',
    'microsoft/playwright',
    'nodejs/node',
    'pgvector/pgvector',
  ];
  // Registrations use a source-key prefix; keep it explicit rather than accepting arbitrary suffix matches.
  const targets = partition?.targets
    .map((target) => target.replace(/^github_releases:/u, ''))
    .sort();
  if (
    !partition ||
    partition.partitions !== 10 ||
    partition.completed !== 10 ||
    JSON.stringify(targets) !== JSON.stringify(expectedTargets.sort()) ||
    JSON.stringify(partition.source_keys) !== JSON.stringify(['github_releases'])
  ) {
    throw new Error('fixed_corpus_partition_mismatch');
  }
  const approval = await pool.query<{
    approved: boolean;
    blocked: boolean;
    approved_model_profiles: string[];
  }>(
    `SELECT approved, blocked, approved_model_profiles FROM provider_budget_scopes WHERE id = $1`,
    [bindings.chat.scopeId],
  );
  const scope = approval.rows[0];
  if (
    embedding.scopeId !== bindings.chat.scopeId ||
    !scope?.approved ||
    scope.blocked ||
    !scope.approved_model_profiles.includes(collectionHash(bindings.chat.profile)) ||
    !scope.approved_model_profiles.includes(profileHash)
  )
    throw new Error('release_runtime_approval_missing');
  const fingerprint = sha256(
    JSON.stringify(
      rows.map((row) => ({
        chunkId: row.chunk_id,
        revisionId: row.revision_id,
        contentHash: row.content_hash,
        publishedAt: row.published_at,
        sourceKey: row.source_key,
        target: row.target_identity,
      })),
    ),
  );
  return {
    summary: {
      ...actual,
      partitions: 10,
      completed: 10,
      targets,
      profileHash,
      fingerprint,
      providerCalls: 0,
      databaseWrites: 0,
    },
    revisionIds,
    byChunk,
    targetTopics: partition.target_topics,
    answerSubset,
  };
}
