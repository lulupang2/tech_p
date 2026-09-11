import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import type { SearchHit } from '@techpulse/domain';
import { GOLDEN_SET_ITEMS } from '@techpulse/rag';
import {
  validateLiveEvaluationSet,
  answerSubsetCoverage,
  baselineApplicability,
  scoreRetrieval,
  isStrictAnswerObject,
  percentile,
  FIXED_CORPUS,
  MVP_LIVE_RETRIEVAL_IDS,
  MVP_LIVE_NEGATIVE_IDS,
  MVP_LIVE_ANSWER_IDS,
  validateLiveLabelMembership,
  sha256,
  type CorpusMembership,
} from '../src/release-evaluation.js';
import {
  validateResumeSourceReportJson,
  validateResumeManifest,
  validateResumeCorpus,
  boundResumePorts,
} from '../src/release-evaluation-cli.js';

const labels = validateLiveEvaluationSet(
  JSON.parse(
    readFileSync(
      new URL('../../../docs/experiments/cov-009/live-eval-set.proposed.json', import.meta.url),
      'utf8',
    ),
  ),
);
const labelsText = readFileSync(
  new URL('../../../docs/experiments/cov-009/live-eval-set.proposed.json', import.meta.url),
  'utf8',
);
const resumeSourceText = readFileSync(
  new URL(
    '../../../docs/experiments/eval-002/eval002-2026-09-11T02-31-29-990Z-live/report.json',
    import.meta.url,
  ),
  'utf8',
);

function changedSource(path: readonly (string | number)[], value: unknown): string {
  const changed = JSON.parse(resumeSourceText) as Record<string, unknown>;
  let parent = changed;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[path[path.length - 1]!] = value;
  return JSON.stringify(changed);
}

describe('EVAL-002 fail-closed resume', () => {
  test.each([
    [['dataset', 'sha256'], '0'.repeat(64)],
    [['dataset', 'chunks'], 499],
    [['labels', 'sha256'], '0'.repeat(64)],
    [['labels', 'reviewedSha256'], '0'.repeat(64)],
    [['retrieval', 'automatedGatesPassed'], false],
    [['retrieval', 'summaries', 'hybrid', 'recallAt10'], 0.1],
    [['retrieval', 'variants', 'hybrid', 0, 'id'], 'L-007'],
    [['retrieval', 'variants', 'hybrid', 0, 'chunkIds'], ['private body']],
    [['retrieval', 'variants', 'hybrid', 0, 'latencyMs'], -1],
    [['preflight', 'fingerprint'], '0'.repeat(64)],
    [['postflight', 'profileHash'], '0'.repeat(64)],
    ...['time', 'rights', 'profile', 'provenance'].map((key) => [['hardInvariants', key], 1]),
    [['configuration', 'acquisition'], true],
    [['configuration', 'retries'], 1],
    [['budget', 'caps', 'embeddingCalls'], 101],
    [['budget', 'usage', 'embeddingCalls'], 101],
    [['budget', 'usage', 'microUsd'], 250001],
    [['budget', 'usage', 'chatInputTokens'], -1],
    [['budget', 'outstanding', 'chatOutputTokens'], 1],
    [['budget', 'unknownReservations'], 1],
    [['answers', 'rows', 1, 'id'], 'L-014'],
    [['answers', 'rows', 1, 'status'], 'insufficient_evidence'],
    [['answers', 'rows', 1, 'questionSha256'], '0'.repeat(64)],
    [['answers', 'rows', 1, 'answerSha256'], sha256('')],
    [['answers', 'rows', 1, 'responseSha256'], null],
    [['answers', 'rows', 1, 'structured'], false],
    [['answers', 'rows', 1, 'citations', 1, 'id'], 'C1'],
    [['answers', 'rows', 1, 'citations', 1, 'documentRevisionId'], 'foreign'],
    [['answers', 'rows', 1, 'citations', 1, 'excerpt'], 'private body'],
    [['answers', 'rows', 1, 'relevantCitationCount'], 99],
    [['answers', 'rows', 1, 'latencyMs'], 15001],
    [['answers', 'rows', 1, 'semanticReview', 'reviewer'], 'invented approval'],
    [['answers', 'rows', 4, 'answerSha256'], '0'.repeat(64)],
    [['answers', 'rows', 4, 'limitationSha256'], sha256('[]')],
    [['answers', 'rows', 4, 'chatCalls'], 1],
  ] as [readonly (string | number)[], unknown][])(
    'rejects changed source field %j',
    (path, value) => {
      expect(() =>
        validateResumeSourceReportJson(changedSource(path, value), sha256(labelsText), labels, [
          'L-001',
        ]),
      ).toThrow('release_resume_report_invalid');
    },
  );

  test.each([[], ['L-001', 'L-001'], ['L-001', 'L-007'], ['L-040']])(
    'rejects retry selection %j',
    (...ids) => {
      expect(() =>
        validateResumeSourceReportJson(resumeSourceText, sha256(labelsText), labels, ids),
      ).toThrow('release_resume_report_invalid');
    },
  );

  test('keeps the recorded retrieval and seven reused rows unchanged', () => {
    const original = JSON.parse(resumeSourceText) as {
      retrieval: unknown;
      answers: { rows: { id: string }[] };
    };
    const source = validateResumeSourceReportJson(resumeSourceText, sha256(labelsText), labels, [
      'L-001',
    ]);
    expect(source.reportSha256).toBe(sha256(resumeSourceText));
    expect(source.retrieval).toEqual(original.retrieval);
    expect(source.answerRows.filter((row) => row.id !== 'L-001')).toEqual(
      original.answers.rows.filter((row) => row.id !== 'L-001'),
    );
  });

  test('binds the source manifest and rejects unrelated code changes', () => {
    const old = [
      { path: 'packages/rag/src/context-assembly.ts', sha256: 'a'.repeat(64) },
      { path: 'packages/database/src/search.ts', sha256: 'b'.repeat(64) },
    ];
    const current = structuredClone(old);
    current[0]!.sha256 = 'c'.repeat(64);
    const hash = sha256(JSON.stringify(old));
    expect(() => validateResumeManifest(old, hash, current)).not.toThrow();
    expect(() => validateResumeManifest(old, '0'.repeat(64), current)).toThrow();
    current[1]!.sha256 = 'c'.repeat(64);
    expect(() => validateResumeManifest(old, hash, current)).toThrow(
      'release_resume_source_changed',
    );
  });

  test('rechecks chunk membership, time/rights/profile and recorded ranks before dispatch', () => {
    const source = validateResumeSourceReportJson(resumeSourceText, sha256(labelsText), labels, [
      'L-001',
    ]);
    type Verified = Parameters<typeof validateResumeCorpus>[1];
    const verified: Verified = {
      summary: (JSON.parse(resumeSourceText) as { preflight: Verified['summary'] }).preflight,
      byChunk: new Map(),
    };
    // Synthetic eligible DB rows for an OFFLINE validation test, never live evidence.
    for (const scores of Object.values(source.retrieval.variants)) {
      for (const score of scores) {
        score.chunkIds.forEach((chunkId, index) =>
          verified.byChunk.set(chunkId, {
            raw_id: chunkId,
            payload_hash: 'a'.repeat(64),
            revision_id: score.revisionIds[index]!,
            chunk_id: chunkId,
            content_hash: 'b'.repeat(64),
            document_id: score.revisionIds[index]!,
            source_key: 'github_releases',
            target_identity: 'fixture',
            published_at: new Date('2026-09-09T00:00:00Z'),
            status: 'searchable',
            lexical_ready: true,
            rights_eligible: true,
            embedding_id: chunkId,
          }),
        );
      }
    }
    expect(() => validateResumeCorpus(source, verified, labels)).not.toThrow();
    const first = source.retrieval.variants.hybrid[0]!;
    first.recallAt10 = 0;
    expect(() => validateResumeCorpus(source, verified, labels)).toThrow(
      'release_resume_score_mismatch',
    );
    first.recallAt10 = 1;
    const row = verified.byChunk.get(first.chunkIds[0]!)!;
    row.rights_eligible = false;
    expect(() => validateResumeCorpus(source, verified, labels)).toThrow(
      'release_resume_eligibility_violation',
    );
    row.rights_eligible = true;
    row.published_at = new Date('2000-01-01T00:00:00Z');
    expect(() => validateResumeCorpus(source, verified, labels)).toThrow(
      'release_resume_eligibility_violation',
    );
    row.published_at = new Date('2026-09-09T00:00:00Z');
    verified.byChunk.delete(first.chunkIds[0]!);
    expect(() => validateResumeCorpus(source, verified, labels)).toThrow(
      'release_resume_provenance_violation',
    );
    verified.summary.profileHash = '0'.repeat(64);
    expect(() => validateResumeCorpus(source, verified, labels)).toThrow(
      'release_resume_corpus_fingerprint_mismatch',
    );
  });

  test('permits at most one dispatch per provider, without refunding a failed attempt', async () => {
    const embed = vi.fn(async () => {
      throw new Error('fixture_failure');
    });
    const complete = vi.fn(async () => {
      throw new Error('fixture_failure');
    });
    const ports = boundResumePorts({
      embeddingPort: { embed, embedMany: embed },
      chatPort: { complete },
    });
    await expect(ports.embeddingPort.embed({ input: 'fixture' })).rejects.toThrow(
      'fixture_failure',
    );
    await expect(ports.embeddingPort.embed({ input: 'fixture' })).rejects.toThrow(
      'release_resume_call_limit',
    );
    await expect(ports.chatPort.complete({ messages: [] })).rejects.toThrow('fixture_failure');
    await expect(ports.chatPort.complete({ messages: [] })).rejects.toThrow(
      'release_resume_call_limit',
    );
    expect(embed).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('EVAL-002 scorecard integrity', () => {
  test('accepts only the canonical L-001 resume source and fails closed on tampering', () => {
    const validated = validateResumeSourceReportJson(resumeSourceText, sha256(labelsText), labels, [
      'L-001',
    ]);
    expect(validated.runId).toBe('eval002-2026-09-11T02-31-29-990Z-live');
    expect(validated.answerRows).toHaveLength(8);
    expect(validated.retrieval.automatedGatesPassed).toBe(true);
    expect(() =>
      validateResumeSourceReportJson(resumeSourceText, sha256(labelsText), labels, ['L-007']),
    ).toThrow('release_resume_report_invalid');

    const tampered = JSON.parse(resumeSourceText) as {
      budget: { unknownReservations: number };
      postflight: { fingerprint: string };
    };
    tampered.budget.unknownReservations = 1;
    expect(() =>
      validateResumeSourceReportJson(JSON.stringify(tampered), sha256(labelsText), labels, [
        'L-001',
      ]),
    ).toThrow('release_resume_report_invalid');

    tampered.budget.unknownReservations = 0;
    tampered.postflight.fingerprint = '0'.repeat(64);
    expect(() =>
      validateResumeSourceReportJson(JSON.stringify(tampered), sha256(labelsText), labels, [
        'L-001',
      ]),
    ).toThrow('release_resume_report_invalid');
  });

  test('uses an eight-item MVP live gate while preserving the larger datasets for diagnostics', () => {
    expect(MVP_LIVE_RETRIEVAL_IDS).toEqual(['L-001', 'L-007', 'L-014', 'L-017']);
    expect(MVP_LIVE_NEGATIVE_IDS).toEqual(['L-040', 'L-041', 'L-044', 'L-045']);
    expect(MVP_LIVE_ANSWER_IDS).toHaveLength(8);
    expect(new Set(MVP_LIVE_ANSWER_IDS).size).toBe(8);
    expect(
      MVP_LIVE_RETRIEVAL_IDS.every(
        (id) => labels.items.find((item) => item.id === id)?.expectedStatus === 'answered',
      ),
    ).toBe(true);
    expect(
      MVP_LIVE_NEGATIVE_IDS.every(
        (id) =>
          labels.items.find((item) => item.id === id)?.expectedStatus === 'insufficient_evidence',
      ),
    ).toBe(true);
  });
  test('label counts alone never claim verified fixed-corpus completeness', () => {
    expect(answerSubsetCoverage(labels)).toMatchObject({
      questions: 12,
      relevantRevisions: 28,
      relevantChunks: 500,
      countsMatchExpected: true,
      membershipVerification: 'pending',
      complete: null,
    });
    expect(labels.status).toBe('proposed-human-review-required');
    expect(labels.items.filter((item) => item.expectedStatus === 'answered')).toHaveLength(39);
  });
  test('rejects missing/duplicated labels, changed dataset and incorrect negative expectation', () => {
    expect(() => validateLiveEvaluationSet({ ...labels, items: labels.items.slice(1) })).toThrow();
    expect(() =>
      validateLiveEvaluationSet({ ...labels, dataset: { ...labels.dataset, sha256: 'wrong' } }),
    ).toThrow();
    expect(() =>
      validateLiveEvaluationSet({
        ...labels,
        items: labels.items.map((item, i) =>
          i === 44 ? { ...item, expectedStatus: 'answered' } : item,
        ),
      }),
    ).toThrow();
  });
  test('rejects empty chunk labels, invalid evidence IDs and answered negative-category rows', () => {
    for (const fields of [
      { relevantChunkIds: [] },
      { relevantRevisionIds: ['foreign'] },
      { category: 'coverage_negative' },
      { expectedTarget: null },
    ]) {
      expect(() =>
        validateLiveEvaluationSet({
          ...labels,
          items: labels.items.map((item, i) => (i === 0 ? { ...item, ...fields } : item)),
        }),
      ).toThrow('invalid_live_label_row');
    }
  });
  test('checks exact membership against a separate manifest, not equal-size foreign ID sets', () => {
    // Synthetic unit-test manifest only; these derived dates are NOT actual corpus evidence.
    const corpus: CorpusMembership[] = labels.items
      .filter((item) => item.category === 'release_exact')
      .flatMap((item) => {
        const revisionId = item.relevantRevisionIds[0]!;
        const bounds = labels.items
          .filter((row) => row.relevantRevisionIds.includes(revisionId))
          .map((row) => Date.parse(row.publishedAfter ?? FIXED_CORPUS.from));
        return item.relevantChunkIds.map((chunkId) => ({
          chunkId,
          revisionId,
          target: item.expectedTarget!,
          publishedAt: new Date(Math.max(...bounds)).toISOString(),
        }));
      });
    expect(answerSubsetCoverage(labels, corpus).complete).toBe(true);
    const firstRevision = labels.items[0]!.relevantRevisionIds[0]!;
    const foreign = {
      ...labels,
      items: labels.items.map((item) => ({
        ...item,
        relevantRevisionIds: item.relevantRevisionIds.map((id) =>
          id === firstRevision ? 'ffffffff-ffff-ffff-ffff-ffffffffffff' : id,
        ),
      })),
    };
    expect(answerSubsetCoverage(foreign).countsMatchExpected).toBe(true);
    expect(answerSubsetCoverage(foreign).complete).toBeNull();
    expect(() => answerSubsetCoverage(foreign, corpus)).toThrow('live_labels_outside_fixed_corpus');
  });
  test('rejects wrong target, period and revision/chunk pairing in the manifest', () => {
    const item = labels.items[0]!;
    const corpus = item.relevantChunkIds.map((chunkId) => ({
      chunkId,
      revisionId: item.relevantRevisionIds[0]!,
      target: item.expectedTarget!,
      publishedAt: '2026-09-09T00:00:00.000Z',
    }));
    expect(() => validateLiveLabelMembership([item], corpus)).not.toThrow();
    expect(() =>
      validateLiveLabelMembership(
        [{ ...item, expectedTarget: 'github_releases:nodejs/node' }],
        corpus,
      ),
    ).toThrow('live_labels_outside_fixed_corpus');
    expect(() =>
      validateLiveLabelMembership(
        [{ ...item, publishedBeforeExclusive: '2026-09-08T00:00:00.000Z' }],
        corpus,
      ),
    ).toThrow('live_labels_outside_fixed_corpus');
    expect(() =>
      validateLiveLabelMembership(
        [item],
        corpus.map((row) => ({ ...row, revisionId: 'other' })),
      ),
    ).toThrow('live_labels_outside_fixed_corpus');
  });
  test('retains all 43 immutable expected statuses and never waives the five injection cases', () => {
    const before = JSON.stringify(GOLDEN_SET_ITEMS);
    const report = baselineApplicability();
    expect(JSON.stringify(GOLDEN_SET_ITEMS)).toBe(before);
    expect(report.rows.map((row) => [row.id, row.originalExpectedStatus])).toEqual(
      GOLDEN_SET_ITEMS.map((item) => [item.id, item.expectedStatus]),
    );
    expect(
      report.denominator.liveApplicable +
        report.denominator.coverageNotApplicable +
        report.denominator.controlledFixtureRequired,
    ).toBe(43);
    expect(report.rows.filter((row) => row.isSecurityInjection)).toHaveLength(5);
    for (const row of report.rows.filter((item) => item.isSecurityInjection)) {
      expect(row.applicability).toBe('controlled_fixture_required');
      expect(row.mandatoryHardInvariants).toBe(true);
    }
    expect(report.gatePassed).toBe(false);
    expect(report.denominator.executed).toBe(0);
  });
  test('top-ten cutoff cannot be laundered by deduplicating before scoring', () => {
    const hit = (index: number, revision: string): SearchHit => ({
      chunkId: `chunk-${index}`,
      documentId: revision,
      documentRevisionId: revision,
      content: 'fixture',
      headingPath: [],
      title: 'fixture',
      score: 1,
      publishedAt: null,
    });
    const ranked = [
      ...Array.from({ length: 10 }, (_, i) => hit(i, 'irrelevant')),
      hit(10, 'relevant'),
    ];
    const item = { ...labels.items[0]!, relevantRevisionIds: ['relevant'] };
    const result = scoreRetrieval(item, ranked, 10);
    expect(result.recallAt10).toBe(0);
    expect(result.ndcgAt10).toBe(0);
    expect(result.duplicateRedundancyAt10).toBe(0.9);
    expect(result.repeatedChunkRatio).toBe(0);
  });
  test('strict structured output is not inferred from citation presence or permissive transport parsing', () => {
    expect(isStrictAnswerObject('{"answer":"ok [C1]"}')).toBe(true);
    for (const invalid of [
      'answer [C1]',
      '{"answer":""}',
      '{"answer":"ok","citations":[]}',
      '[]',
      '{broken [C1]',
    ]) {
      expect(isStrictAnswerObject(invalid)).toBe(false);
    }
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([30, 10, 20], 0.95)).toBe(30);
  });
});
