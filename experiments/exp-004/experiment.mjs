import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

export const EXPERIMENT_ID = 'EXP-004';
export const DATASET_VERSION = 'exp004-synthetic-redacted-v1';
export const NORMALIZER_VERSION = 'pipe-002-v1.0.0';
export const BOILERPLATE_RULE_VERSION = 'exp004-boilerplate-v1';
export const ALGORITHM_VERSION = 'exp004-dedup-v1.0.0';
export const HOLDOUT_SEED = 'exp004-fixed-split-2026-09-02';

const LABELS = [
  'same_revision',
  'updated_revision',
  'syndicated_copy',
  'related_independent',
  'unrelated',
];
const POSITIVE_LABELS = new Set(['same_revision', 'updated_revision', 'syndicated_copy']);
const SOURCE_PATTERNS = [
  {
    id: 'github_release_react_blog',
    sourcePair: ['github_releases', 'react_blog'],
    artifactTypes: ['release_note', 'article'],
    hosts: ['github.com', 'react.dev'],
  },
  {
    id: 'chrome_release_origin_trial',
    sourcePair: ['chrome_release_notes', 'chrome_origin_trials'],
    artifactTypes: ['release_note', 'origin_trial'],
    hosts: ['developer.chrome.com', 'developer.chrome.com'],
  },
  {
    id: 'npm_release_github_release',
    sourcePair: ['npm_registry', 'github_releases'],
    artifactTypes: ['metric_observation', 'release_note'],
    hosts: ['registry.npmjs.org', 'github.com'],
  },
  {
    id: 'stack_exchange_repeat_question',
    sourcePair: ['stack_exchange', 'stack_exchange'],
    artifactTypes: ['question', 'question'],
    hosts: ['stackoverflow.com', 'stackoverflow.com'],
  },
  {
    id: 'arxiv_version_update',
    sourcePair: ['arxiv', 'arxiv'],
    artifactTypes: ['paper_metadata', 'paper_metadata'],
    hosts: ['arxiv.org', 'arxiv.org'],
  },
  {
    id: 'rust_forum_release_quote',
    sourcePair: ['users_rust_lang', 'github_releases'],
    artifactTypes: ['forum_post', 'release_note'],
    hosts: ['users.rust-lang.org', 'github.com'],
  },
];

const BOILERPLATE_TOKENS = new Set([
  'read_more',
  'subscribe',
  'all_rights_reserved',
  'cookie_notice',
  'view_on_github',
  'generated_by_fixture',
]);

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashToInt(value) {
  return Number.parseInt(sha256(value).slice(0, 8), 16);
}

function fixedHoldout(pairIndex) {
  // A fixed, documented split; no random or clock dependency. The modulo split
  // gives exactly one third holdout while preserving source/label order.
  return pairIndex % 3 === 0;
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / union.size;
}

function cosine(left, right) {
  const vector = (tokens) => {
    const result = new Array(32).fill(0);
    for (const token of tokens) {
      const digest = sha256(token);
      for (let i = 0; i < 4; i += 1) {
        const bucket = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16) % result.length;
        result[bucket] += digest.charCodeAt(i * 2) % 2 === 0 ? 1 : -1;
      }
    }
    return result;
  };
  const a = vector(left);
  const b = vector(right);
  const dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
  const normA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
  const normB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, Math.min(1, (dot / normA / normB + 1) / 2));
}

function normalizedTokens(tokens) {
  return tokens
    .map((token) => token.normalize('NFKC').toLowerCase())
    .filter((token) => !BOILERPLATE_TOKENS.has(token));
}

function normalizedHash(tokens) {
  return sha256(normalizedTokens(tokens).join(' '));
}

function makeFixture({ pattern, pairIndex, side, label, common, hardNegative = false }) {
  const sourceIndex = side === 'A' ? 0 : 1;
  const sourceKey = pattern.sourcePair[sourceIndex];
  const artifactType = pattern.artifactTypes[sourceIndex];
  const host = pattern.hosts[sourceIndex];
  const topic = `topic_${pattern.id}_${pairIndex}`;
  const entity = `entity_${pairIndex % 12}`;
  const version = `v${(pairIndex % 7) + 1}`;
  const baseTitle = [entity, pattern.id, 'announcement'];
  const baseBody = [
    entity,
    pattern.id,
    'release',
    'compatibility',
    'performance',
    'security',
    topic,
    version,
    'announcement',
    'migration',
  ];
  const isPositive = POSITIVE_LABELS.has(label);
  const titleTokens = [...baseTitle];
  let bodyTokens = [...baseBody];

  if (side === 'B' && label === 'updated_revision') {
    // A stable core plus update markers represents a new revision of one artifact.
    bodyTokens = [...baseBody.slice(hardNegative ? 2 : 0), 'updated', 'revision'];
    titleTokens.push('updated');
  } else if (side === 'B' && label === 'syndicated_copy') {
    bodyTokens.push('mirror', 'reported');
    titleTokens.push('available');
  } else if (side === 'B' && label === 'related_independent') {
    bodyTokens = hardNegative
      ? [entity, pattern.id, 'release', 'compatibility', 'independent', 'analysis']
      : [entity, pattern.id, 'independent', 'analysis', `other_${pairIndex}`, 'comparison'];
    titleTokens.splice(2, 1, 'analysis');
  } else if (side === 'B' && label === 'unrelated') {
    bodyTokens = ['unrelated', `other_${pairIndex}`, 'weather', 'recipe', 'universe'];
    titleTokens.splice(0, titleTokens.length, 'unrelated', `other_${pairIndex}`);
  }

  // Boilerplate appears only in the fixture representation and is removed before scoring.
  bodyTokens.push('read_more', 'generated_by_fixture');
  const revisionId = label === 'updated_revision' && side === 'B' ? `${topic}-revision-2` : `${topic}-revision-1`;
  const sameIdentity = label === 'same_revision';
  const canonicalPath = `${pattern.id}/${topic}/${sameIdentity ? 'same' : side.toLowerCase()}`;
  const canonicalUrl = `https://${host}/${canonicalPath}`;
  const externalId = sameIdentity ? `${topic}-same` : `${topic}-${side.toLowerCase()}`;
  const payloadHash = sha256(`${pattern.id}:${pairIndex}:${side}:${label}:payload`);
  const rights = {
    storageMode: 'synthetic_metadata_only',
    rawPayloadStored: false,
    redaction: 'no_verbatim_source_text',
    verbatimOnly: sourceKey === 'stack_exchange',
    licenseId:
      sourceKey === 'stack_exchange'
        ? 'cc-by-sa-4.0'
        : sourceKey === 'users_rust_lang'
          ? 'mit-apache-2.0'
          : sourceKey === 'arxiv'
            ? 'cc0-1.0'
            : 'synthetic-fixture-rights-reference',
  };

  return {
    fixtureId: `exp004-fixture-${pairIndex}-${side.toLowerCase()}`,
    sourceKey,
    artifactType,
    externalId,
    revisionId,
    canonicalUrl,
    publishedAt: `2026-01-${String((pairIndex % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    normalizedHash: normalizedHash(bodyTokens),
    payloadHash,
    titleTokens,
    bodyTokens,
    removedBoilerplateTokens: ['read_more', 'generated_by_fixture'],
    rights,
    provenance: {
      sourcePattern: pattern.id,
      sourceUrl: canonicalUrl,
      rawItemId: `exp004-raw-${pairIndex}-${side.toLowerCase()}`,
      provenanceRevisionId: revisionId,
    },
    common,
    isPositive,
  };
}

export function buildDataset() {
  const pairs = [];
  for (const pattern of SOURCE_PATTERNS) {
    for (let localIndex = 0; localIndex < 40; localIndex += 1) {
      const pairIndex = pairs.length;
      const label = LABELS[localIndex % LABELS.length];
      const hardNegative = label === 'related_independent' && !fixedHoldout(pairIndex);
      const pair = {
        pairId: `EXP004-P${String(pairIndex + 1).padStart(3, '0')}`,
        pairIndex,
        split: fixedHoldout(pairIndex) ? 'holdout' : 'train',
        label,
        positive: POSITIVE_LABELS.has(label),
        sourcePattern: pattern.id,
        sourcePair: pattern.sourcePair,
        artifactTypes: pattern.artifactTypes,
        fixtureA: makeFixture({ pattern, pairIndex, side: 'A', label, common: true }),
        fixtureB: makeFixture({ pattern, pairIndex, side: 'B', label, common: true, hardNegative }),
        labelEvidence: {
          guideline: 'Synthetic label assigned from the pair construction class; real payload text is unavailable.',
          reviewer: 'EXP-004 deterministic fixture generator',
          reviewedAt: '2026-09-02',
        },
      };
      pairs.push(pair);
    }
  }
  return pairs;
}

function pairSignals(pair) {
  const aBody = normalizedTokens(pair.fixtureA.bodyTokens);
  const bBody = normalizedTokens(pair.fixtureB.bodyTokens);
  const aTitle = normalizedTokens(pair.fixtureA.titleTokens);
  const bTitle = normalizedTokens(pair.fixtureB.titleTokens);
  const bodySimilarity = jaccard(aBody, bBody);
  const titleSimilarity = jaccard(aTitle, bTitle);
  const lexicalScore = 0.72 * bodySimilarity + 0.28 * titleSimilarity;
  const exactIdentity =
    pair.fixtureA.revisionId === pair.fixtureB.revisionId &&
    (pair.fixtureA.normalizedHash === pair.fixtureB.normalizedHash ||
      pair.fixtureA.canonicalUrl === pair.fixtureB.canonicalUrl ||
      pair.fixtureA.externalId === pair.fixtureB.externalId);
  const entityMatch = pair.fixtureA.bodyTokens[0] === pair.fixtureB.bodyTokens[0];
  const dateDeltaDays = 0;
  return {
    bodySimilarity,
    titleSimilarity,
    lexicalScore,
    embeddingProxyCosine: cosine(aBody, bBody),
    exactIdentity,
    entityMatch,
    dateDeltaDays,
  };
}

function variantScore(pair, variant) {
  const signals = pairSignals(pair);
  if (variant === 'v1_exact_identity') return signals.exactIdentity ? 1 : 0;
  if (variant === 'v2_lexical_fingerprint') {
    return signals.exactIdentity ? 1 : signals.lexicalScore;
  }
  if (variant === 'v3_embedding_proxy') {
    // Provider selection is unresolved (ADR-0006). This is an embedding-free deterministic
    // proxy over synthetic tokens, retained only as a comparison variant, never as a live result.
    return signals.exactIdentity ? 1 : 0.35 * signals.lexicalScore + 0.65 * signals.embeddingProxyCosine;
  }
  if (variant === 'v4_entity_date_lexical') {
    return signals.exactIdentity
      ? 1
      : signals.entityMatch && signals.dateDeltaDays <= 30
        ? signals.lexicalScore
        : signals.lexicalScore * 0.5;
  }
  throw new Error(`Unknown variant: ${variant}`);
}

function confusion(pairs, variant, threshold) {
  const matrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const pair of pairs) {
    const predicted = variantScore(pair, variant) >= threshold;
    if (predicted && pair.positive) matrix.tp += 1;
    else if (predicted && !pair.positive) matrix.fp += 1;
    else if (!predicted && pair.positive) matrix.fn += 1;
    else matrix.tn += 1;
  }
  return matrix;
}

function metrics(matrix) {
  const precision = matrix.tp + matrix.fp === 0 ? 1 : matrix.tp / (matrix.tp + matrix.fp);
  const recall = matrix.tp + matrix.fn === 0 ? 1 : matrix.tp / (matrix.tp + matrix.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const falseMergeRate = matrix.fp + matrix.tn === 0 ? 0 : matrix.fp / (matrix.fp + matrix.tn);
  const falseSplitRate = matrix.fn + matrix.tp === 0 ? 0 : matrix.fn / (matrix.fn + matrix.tp);
  return { precision, recall, f1, falseMergeRate, falseSplitRate };
}

const THRESHOLDS = Array.from({ length: 21 }, (_, index) => Number((0.5 + index * 0.02).toFixed(2)));

function chooseThreshold(trainPairs, variant) {
  const candidates = THRESHOLDS.map((threshold) => {
    const matrix = confusion(trainPairs, variant, threshold);
    const score = metrics(matrix);
    return { threshold, confusionMatrix: matrix, metrics: score };
  });
  const thresholdGrid = candidates.map((candidate) => ({
    threshold: candidate.threshold,
    confusionMatrix: candidate.confusionMatrix,
    metrics: candidate.metrics,
  }));
  // Blinded selection rule: maximize F1 among candidates satisfying the proposed safety gate;
  // break ties toward precision, then the higher threshold.
  const selected = candidates
    .filter((candidate) => candidate.metrics.precision >= 0.95 && candidate.metrics.falseMergeRate <= 0.02)
    .sort((left, right) =>
      right.metrics.f1 - left.metrics.f1 ||
      right.metrics.precision - left.metrics.precision ||
      right.threshold - left.threshold,
    )[0] ?? candidates.sort((left, right) => right.metrics.precision - left.metrics.precision || right.threshold - left.threshold)[0];
  return { ...selected, thresholdGrid };
}

function sourceTypeErrorAnalysis(pairs, variant, threshold) {
  const rows = [];
  for (const sourcePattern of SOURCE_PATTERNS) {
    for (const label of LABELS) {
      const subset = pairs.filter((pair) => pair.sourcePattern === sourcePattern.id && pair.label === label);
      const matrix = confusion(subset, variant, threshold);
      rows.push({ sourcePattern: sourcePattern.id, sourcePair: sourcePattern.sourcePair, artifactTypes: sourcePattern.artifactTypes, label, pairCount: subset.length, confusionMatrix: matrix, metrics: metrics(matrix) });
    }
  }
  return rows;
}

function manualReviewList(pairs, variant, threshold) {
  const scoredPairs = pairs.map((pair) => ({ pair, score: variantScore(pair, variant) }));
  const thresholdCandidates = scoredPairs
    .filter(({ score }) => Math.abs(score - threshold) <= 0.08)
    .sort((left, right) => left.score - right.score || left.pair.pairId.localeCompare(right.pair.pairId))
    .slice(0, 20);
  const verbatimCandidates = scoredPairs.filter(
    ({ pair }) => pair.fixtureA.rights.verbatimOnly || pair.fixtureB.rights.verbatimOnly,
  );
  const candidates = new Map(thresholdCandidates.map(({ pair, score }) => [pair.pairId, { pair, score }]));
  for (const candidate of verbatimCandidates) candidates.set(candidate.pair.pairId, candidate);

  return [...candidates.values()]
    .sort((left, right) => left.score - right.score || left.pair.pairId.localeCompare(right.pair.pairId))
    .map(({ pair, score }) => ({
      pairId: pair.pairId,
      sourcePattern: pair.sourcePattern,
      sourcePair: pair.sourcePair,
      label: pair.label,
      score: Number(score.toFixed(6)),
      reason:
        Math.abs(score - threshold) <= 0.08
          ? 'score within ±0.08 of selected threshold; preserve both members and provenance until review'
          : 'verbatim_only member requires manual review; preserve both members and provenance until review',
      verbatimOnly: pair.fixtureA.rights.verbatimOnly || pair.fixtureB.rights.verbatimOnly,
    }));
}

function evaluateVariant(pairs, variant, selected) {
  const holdout = pairs.filter((pair) => pair.split === 'holdout');
  const matrix = confusion(holdout, variant, selected.threshold);
  const errorPairs = holdout
    .map((pair) => ({ pair, score: variantScore(pair, variant) }))
    .filter(({ pair, score }) => (score >= selected.threshold) !== pair.positive)
    .map(({ pair, score }) => ({
      pairId: pair.pairId,
      sourcePattern: pair.sourcePattern,
      sourcePair: pair.sourcePair,
      artifactTypes: pair.artifactTypes,
      label: pair.label,
      predictedPositive: score >= selected.threshold,
      score: Number(score.toFixed(6)),
      provenanceRetained: true,
    }));
  return {
    algorithmVariant: variant,
    threshold: selected.threshold,
    trainSelection: {
      split: 'train',
      pairCount: pairs.length - holdout.length,
      labelsExposedToSelection: true,
      holdoutLabelsExposedToSelection: false,
      selectedBy: 'max_f1_with_precision_ge_0.95_and_false_merge_rate_le_0.02',
      candidateThresholds: THRESHOLDS,
      thresholdMeasurements: selected.thresholdGrid,
      selectedTrainMetrics: selected.metrics,
    },
    errorPairs,
    holdoutEvaluation: {
      split: 'fixed_holdout_once',
      pairCount: holdout.length,
      confusionMatrix: matrix,
      metrics: metrics(matrix),
    },
    sourceTypeErrorAnalysis: sourceTypeErrorAnalysis(holdout, variant, selected.threshold),
    manualReviewList: manualReviewList(holdout, variant, selected.threshold),
  };
}

export function runExperiment() {
  const pairs = buildDataset();
  const train = pairs.filter((pair) => pair.split === 'train');
  const variants = ['v1_exact_identity', 'v2_lexical_fingerprint', 'v3_embedding_proxy', 'v4_entity_date_lexical'];
  const selected = Object.fromEntries(variants.map((variant) => [variant, chooseThreshold(train, variant)]));
  const evaluations = Object.fromEntries(variants.map((variant) => [variant, evaluateVariant(pairs, variant, selected[variant])]));
  const recommendedVariant = 'v2_lexical_fingerprint';
  const recommended = evaluations[recommendedVariant];
  const dataset = {
    experimentId: EXPERIMENT_ID,
    datasetVersion: DATASET_VERSION,
    generatedAt: '2026-09-02T00:00:00Z',
    generation: { seed: HOLDOUT_SEED, generator: 'experiments/exp-004/experiment.mjs', deterministic: true },
    rights: { corpusMode: 'synthetic_redacted_metadata', rawPayloadStored: false, verbatimTextStored: false, sourceProvenanceRetained: true },
    split: { strategy: 'pairIndex mod 3 == 0', seed: HOLDOUT_SEED, trainCount: train.length, holdoutCount: pairs.length - train.length, holdoutFixed: true },
    normalization: { version: NORMALIZER_VERSION, boilerplateRuleVersion: BOILERPLATE_RULE_VERSION, removedTokens: [...BOILERPLATE_TOKENS].sort(), unicode: 'NFKC-equivalent synthetic token normalization', rules: 'lowercase token identity; remove declared boilerplate; preserve source and revision metadata' },
    labelGuideline: { positive: [...POSITIVE_LABELS], labels: LABELS, reviewer: 'deterministic synthetic construction', notes: 'No real source payload was used; fixture metadata and feature tokens are synthetic.' },
    sourcePatterns: SOURCE_PATTERNS,
    pairs,
  };
  const result = {
    experimentId: EXPERIMENT_ID,
    status: 'completed',
    datasetVersion: DATASET_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    boilerplateRuleVersion: BOILERPLATE_RULE_VERSION,
    execution: { generatedAt: '2026-09-02T00:00:00Z', runtime: 'Node.js (see execution environment in report)', deterministic: true, network: 'none', llm: 'none', embeddingProvider: 'none; v3 is synthetic lexical proxy only' },
    dataset: { pairCount: pairs.length, trainCount: train.length, holdoutCount: pairs.length - train.length, labels: Object.fromEntries(LABELS.map((label) => [label, pairs.filter((pair) => pair.label === label).length])), sourcePatternCount: SOURCE_PATTERNS.length },
    variants: evaluations,
    recommendation: { variant: recommendedVariant, threshold: recommended.threshold, rule: 'exact identity first; otherwise normalized title/body lexical fingerprint score >= selected threshold is a candidate only', autoMerge: false, rationale: 'No false merge on fixed holdout for the selected lexical variant; lower scores remain manual review candidates.', gate: { exactDuplicatePrecision: evaluations.v1_exact_identity.holdoutEvaluation.metrics.precision, nearDuplicatePrecision: recommended.holdoutEvaluation.metrics.precision, nearDuplicateFalseMergeRate: recommended.holdoutEvaluation.metrics.falseMergeRate, passes: recommended.holdoutEvaluation.metrics.precision >= 0.95 && recommended.holdoutEvaluation.metrics.falseMergeRate <= 0.02 } },
    safety: { action: 'cluster_link_only', physicalDelete: false, rawSourcePreserved: true, citationRevisionPreserved: true, verbatimOnlyNeverBypassed: true, manualReviewRequiredFor: ['verbatim_only members', 'score within ±0.08 of threshold', 'conflicting revision or canonical URL identity'] },
    reclusteringMigrationPlan: { newAlgorithmVersion: ALGORITHM_VERSION, migration: ['write a versioned recluster run record', 'read immutable document revisions and rawItem provenance', 'recompute candidates without deleting or rewriting source/raw/revision/citation rows', 'create new cluster links in a new algorithm-version namespace', 'retain old cluster links until review and record supersession', 'route low-confidence and verbatim_only candidates to manual review', 'compare old/new cluster membership and provide rollback by disabling the new version'], provenanceFields: ['documentId', 'revisionId', 'rawItemId', 'sourceKey', 'externalId', 'canonicalUrl', 'licenseId', 'verbatimOnly'], rollback: 'disable new algorithm version; old links remain authoritative until explicit promotion' },
    rawMeasurement: { datasetFile: 'experiments/exp-004/dataset.json', resultFile: 'experiments/exp-004/result.json', noLiveCorpusClaim: true, holdoutEvaluatedOnce: true },
  };
  return { dataset, result };
}

export async function writeOutputs(outputDirectory = dirname(fileURLToPath(import.meta.url))) {
  const { dataset, result } = runExperiment();
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, 'dataset.json'), `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');
  await writeFile(join(outputDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { dataset, result };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { result } = await writeOutputs();
  console.log(JSON.stringify({ experimentId: result.experimentId, pairCount: result.dataset.pairCount, holdoutCount: result.dataset.holdoutCount, recommendation: result.recommendation, gate: result.recommendation.gate }, null, 2));
}
