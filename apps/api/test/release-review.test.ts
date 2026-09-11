import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  FIXED_CORPUS,
  MVP_LIVE_ANSWER_IDS,
  MVP_LIVE_RETRIEVAL_IDS,
  sha256,
} from '../src/release-evaluation.js';
import { finalizeReleaseReview, ReleaseReviewError } from '../src/release-review.js';
import { runReleaseReviewCli } from '../src/release-review-cli.js';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

// Synthetic evidence only. These counts and attestations are never live acceptance records.
function fixture(citationCounts = [5, 5, 5, 5]) {
  const report = {
    schemaVersion: 1,
    task: 'EVAL-002',
    mode: 'live',
    dataset: { ...FIXED_CORPUS },
    labels: { sha256: sha256('synthetic labels'), reviewedSha256: null },
    automatedMvpGatePassed: true,
    releaseGatePassed: false,
    blockers: ['live_label_review_pending', 'semantic_answer_review_pending'],
    answers: {
      rows: MVP_LIVE_ANSWER_IDS.map((id, index) => ({
        id,
        expectedStatus: index < 4 ? 'answered' : 'insufficient_evidence',
        status: index < 4 ? 'answered' : 'insufficient_evidence',
        questionSha256: sha256(`synthetic question ${id}`),
        answerSha256: sha256(index < 4 ? `synthetic answer ${id}` : ''),
        citations: Array.from({ length: citationCounts[index] ?? 0 }, (_, citation) => ({
          id: `C${citation + 1}`,
          documentRevisionId: '00000000-0000-4000-8000-000000000001',
          excerptSha256: sha256(`synthetic excerpt ${id} ${citation}`),
        })),
      })),
    },
  };
  const review = {
    schemaVersion: 1,
    sourceReportSha256: sha256(json(report)),
    labelsSha256: report.labels.sha256,
    reviewer: 'Test reviewer',
    reviewedAt: '2026-09-11T01:40:00.000Z',
    attestation: true,
    labels: MVP_LIVE_ANSWER_IDS.map((id) => ({ id, reviewed: true, approved: true })),
    answers: report.answers.rows.slice(0, 4).map((row) => ({
      id: row.id,
      questionSha256: row.questionSha256,
      answerSha256: row.answerSha256,
      claimCount: 20,
      totalCitations: row.citations.length,
      supportedCitations: row.citations.length,
      coveredClaims: 20,
      unsupportedClaims: 0,
    })),
  };
  return { report, review };
}

function finalize(input: ReturnType<typeof fixture>) {
  const source = json(input.report);
  return finalizeReleaseReview(
    source,
    json({ ...input.review, sourceReportSha256: sha256(source) }),
  );
}

const directories: string[] = [];
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('offline network guard');
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Only unique temporary directories created by this test file are removed.
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('offline EVAL-002 human review', () => {
  test('uses aggregate counts, accepts inclusive thresholds, and preserves both inputs', () => {
    const input = fixture([1, 1, 1, 17]);
    const claims = [10, 10, 10, 70];
    input.review.answers.forEach((row, index) => {
      row.claimCount = claims[index]!;
      row.coveredClaims = index === 0 ? 0 : claims[index]!;
      row.supportedCitations = index === 0 ? 0 : row.totalCitations;
      row.unsupportedClaims = index === 0 ? 5 : 0;
    });
    const source = json(input.report);
    const review = json(input.review);
    const result = finalizeReleaseReview(source, review);
    expect(result.semanticMetrics).toEqual({
      citationPrecision: 0.95,
      citationCoverage: 0.9,
      unsupportedClaimRate: 0.05,
    });
    expect(result.totals).toEqual({
      claimCount: 100,
      totalCitations: 20,
      supportedCitations: 19,
      coveredClaims: 90,
      unsupportedClaims: 5,
    });
    expect(result.releaseGatePassed).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.sourceReportSha256).toBe(sha256(source));
    expect(result.reviewSha256).toBe(sha256(review));
    expect(result.labelsSha256).toBe(input.report.labels.sha256);
    expect(json(input.report)).toBe(source);
    expect(json(input.review)).toBe(review);
  });

  test.each(['citationPrecision', 'citationCoverage', 'unsupportedClaimRate'] as const)(
    'fails the semantic gate independently for %s',
    (metric) => {
      const input = fixture();
      const first = input.review.answers[0]!;
      if (metric === 'citationPrecision') first.supportedCitations = 3;
      if (metric === 'citationCoverage') first.coveredClaims = 11;
      if (metric === 'unsupportedClaimRate') first.unsupportedClaims = 5;
      const result = finalize(input);
      expect(result.releaseGatePassed).toBe(false);
      expect(result.semanticGatePassed).toBe(false);
      expect(result.blockers).toEqual([metric]);
    },
  );

  test('canonicalizes row order without altering review or copying arbitrary source fields', () => {
    const input = fixture();
    input.report.answers.rows.reverse();
    input.review.labels.reverse();
    input.review.answers.reverse();
    input.review.reviewedAt = '2026-09-11T10:40:00+09:00';
    Object.assign(input.report, { rawPrompt: 'DO_NOT_COPY_SOURCE_BODY' });
    const before = json(input);
    const result = finalize(input);
    expect(result.labels.map((row) => row.id)).toEqual(MVP_LIVE_ANSWER_IDS);
    expect(result.answers.map((row) => row.id)).toEqual(MVP_LIVE_RETRIEVAL_IDS);
    expect(json(result)).not.toContain('DO_NOT_COPY_SOURCE_BODY');
    expect(json(input)).toBe(before);
  });

  test.each([false, undefined, null, 1, 'true'])('rejects non-true automated gate %s', (value) => {
    const input = fixture();
    Object.assign(input.report, { automatedMvpGatePassed: value });
    expect(() => finalize(input)).toThrow('release_review_automated_gate');
  });

  test('rejects execution failures, remaining non-review blockers and wrong corpus', () => {
    const input = fixture();
    input.report.blockers.push('mvp_live_evaluation_pending');
    expect(() => finalize(input)).toThrow('release_review_automated_gate');
    input.report.blockers.pop();
    Object.assign(input.report, { executionFailure: 'release_failed' });
    expect(() => finalize(input)).toThrow('release_review_automated_gate');
    Object.assign(input.report, { executionFailure: null });
    Object.assign(input.report.dataset, { sha256: sha256('other corpus') });
    expect(() => finalize(input)).toThrow('release_review_dataset');
  });

  test('binds exact report bytes, labels digest, and each question and answer hash', () => {
    const input = fixture();
    const source = json(input.report);
    expect(() => finalizeReleaseReview(source + ' ', json(input.review))).toThrow('binding');
    input.review.labelsSha256 = sha256('other labels');
    expect(() => finalize(input)).toThrow('binding');
    input.review.labelsSha256 = input.report.labels.sha256;
    for (const key of ['questionSha256', 'answerSha256'] as const) {
      const original = input.review.answers[0]![key];
      input.review.answers[0]![key] = sha256('other answer or question');
      expect(() => finalize(input)).toThrow('answer_binding');
      input.review.answers[0]![key] = 'not-a-hash';
      expect(() => finalize(input)).toThrow('release_review_hash');
      input.review.answers[0]![key] = original;
    }
  });

  test.each(['labels', 'answers', 'source'] as const)(
    'requires exact unique IDs for %s',
    (kind) => {
      for (const change of ['missing', 'extra', 'duplicate', 'foreign']) {
        const input = fixture();
        const rows = kind === 'source' ? input.report.answers.rows : input.review[kind];
        if (change === 'missing') rows.pop();
        if (change === 'extra') rows.push({ ...rows[0]! } as never);
        if (change === 'duplicate') rows[0]!.id = rows[1]!.id;
        if (change === 'foreign') Object.assign(rows[0]!, { id: 'L-999' });
        expect(() => finalize(input)).toThrow('release_review_ids');
      }
    },
  );

  test('requires every label to be both reviewed and approved', () => {
    for (const field of ['reviewed', 'approved']) {
      for (const value of [false, null, 'true', 1]) {
        const input = fixture();
        Object.assign(input.review.labels[7]!, { [field]: value });
        expect(() => finalize(input)).toThrow('release_review_label_approval');
      }
    }
  });

  test('rejects all unknown review fields, including nested raw material', () => {
    for (const location of ['root', 'label', 'answer']) {
      const input = fixture();
      const target =
        location === 'root'
          ? input.review
          : location === 'label'
            ? input.review.labels[0]!
            : input.review.answers[0]!;
      Object.assign(target, { rawAnswer: 'DO_NOT_ACCEPT_RAW_MATERIAL' });
      expect(() => finalize(input)).toThrow('release_review_fields');
    }
  });

  test.each([
    'claimCount',
    'totalCitations',
    'supportedCitations',
    'coveredClaims',
    'unsupportedClaims',
  ])('rejects invalid numeric %s', (key) => {
    for (const value of [-1, 0.5, '1', false, null, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const input = fixture();
      Object.assign(input.review.answers[0]!, { [key]: value });
      expect(() => finalize(input)).toThrow('release_review_counts');
    }
  });

  test('rejects zero denominators, excess counts, citation-count mismatch and aggregate overflow', () => {
    for (const invalid of [
      { claimCount: 0 },
      { totalCitations: 0 },
      { totalCitations: 6 },
      { supportedCitations: 6 },
      { coveredClaims: 21 },
      { unsupportedClaims: 21 },
    ]) {
      const input = fixture();
      Object.assign(input.review.answers[0]!, invalid);
      expect(() => finalize(input)).toThrow('release_review_counts');
    }
    const input = fixture();
    input.review.answers.forEach((row) => {
      row.claimCount = Number.MAX_SAFE_INTEGER;
    });
    expect(() => finalize(input)).toThrow('release_review_counts');
  });

  test('rejects wrong source statuses and invalid or duplicated source citations', () => {
    const input = fixture();
    input.report.answers.rows[4]!.status = 'answered';
    expect(() => finalize(input)).toThrow('source_status');
    input.report.answers.rows[4]!.status = 'insufficient_evidence';
    input.report.answers.rows[0]!.citations[1]!.id = 'C1';
    expect(() => finalize(input)).toThrow('source_citations');
    input.report.answers.rows[0]!.citations = [];
    expect(() => finalize(input)).toThrow('source_citations');
  });

  test('requires bounded reviewer identity, explicit human attestation, and valid zoned timestamp', () => {
    for (const reviewer of ['', '   ', 'a\nb', 'x'.repeat(161), null, 7]) {
      const input = fixture();
      Object.assign(input.review, { reviewer });
      expect(() => finalize(input)).toThrow('attestation');
    }
    for (const attestation of [false, 'true', 1, null]) {
      const input = fixture();
      Object.assign(input.review, { attestation });
      expect(() => finalize(input)).toThrow('attestation');
    }
    for (const reviewedAt of [
      '',
      'tomorrow',
      '2026-09-11',
      '2026-09-11T01:00:00',
      '2026-02-30T01:00:00Z',
      '2026-09-11T24:00:00Z',
      null,
    ]) {
      const input = fixture();
      Object.assign(input.review, { reviewedAt });
      expect(() => finalize(input)).toThrow('reviewed_at');
    }
  });

  test('invalid JSON and shapes fail without echoing input', () => {
    const input = fixture();
    for (const text of ['null', '[]', 'true', '42', '{"PRIVATE_INPUT":']) {
      expect(() => finalizeReleaseReview(json(input.report), text)).toThrow(ReleaseReviewError);
      expect(() => finalizeReleaseReview(text, json(input.review))).toThrow(ReleaseReviewError);
    }
    expect(() => finalizeReleaseReview(json(input.report), '{"PRIVATE_INPUT":')).toThrow(
      'release_review_json',
    );
  });
});

async function files(input = fixture()) {
  const directory = await mkdtemp(join(tmpdir(), 'techpulse-release-review-'));
  directories.push(directory);
  const report = join(directory, 'report.json');
  const review = join(directory, 'review.json');
  const output = join(directory, 'acceptance.json');
  const labels = join(directory, 'labels.json');
  const ledger = join(directory, 'ledger.jsonl');
  const originals = new Map([
    [report, json(input.report)],
    [review, json(input.review)],
    [labels, 'unchanged labels\n'],
    [ledger, 'unchanged ledger\n'],
  ]);
  await Promise.all([...originals].map(([path, text]) => writeFile(path, text)));
  return {
    report,
    review,
    output,
    originals,
    args: [`--report=${report}`, `--review=${review}`, `--output=${output}`],
  };
}

describe('offline review CLI', () => {
  test('writes sanitized acceptance without modifying input, label or ledger files; never overwrites', async () => {
    const paths = await files();
    expect(await runReleaseReviewCli(paths.args)).toBe(0);
    const resultText = await readFile(paths.output, 'utf8');
    expect(JSON.parse(resultText).releaseGatePassed).toBe(true);
    expect(console.log).toHaveBeenCalledTimes(1);
    for (const [path, text] of paths.originals) {
      expect(
        await runReleaseReviewCli([
          `--report=${paths.report}`,
          `--review=${paths.review}`,
          `--output=${path}`,
        ]),
      ).toBe(1);
      expect(await readFile(path, 'utf8')).toBe(text);
    }
    expect(await runReleaseReviewCli(paths.args)).toBe(1);
    expect(await readFile(paths.output, 'utf8')).toBe(resultText);
  });

  test('writes a failed semantic decision and returns exit code 2', async () => {
    const input = fixture();
    input.review.answers[0]!.unsupportedClaims = 5;
    const paths = await files(input);
    expect(await runReleaseReviewCli(paths.args)).toBe(2);
    expect(JSON.parse(await readFile(paths.output, 'utf8'))).toMatchObject({
      releaseGatePassed: false,
      blockers: ['unsupportedClaimRate'],
    });
  });

  test('invalid review, duplicate arguments and I/O failures return 1 without leaking data or writing output', async () => {
    const paths = await files();
    expect(await runReleaseReviewCli([...paths.args, paths.args[0]!])).toBe(1);
    expect(await runReleaseReviewCli(['--live'])).toBe(1);
    await writeFile(paths.review, '{"PRIVATE_INPUT":');
    expect(await runReleaseReviewCli(paths.args)).toBe(1);
    await rm(paths.review);
    expect(await runReleaseReviewCli(paths.args)).toBe(1);
    await expect(readFile(paths.output)).rejects.toMatchObject({ code: 'ENOENT' });
    const errors = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(errors).not.toContain('PRIVATE_INPUT');
    expect(errors).not.toContain(paths.review);
    expect(errors).toContain('release_review_json');
    expect(errors).toContain('release_review_io_failed');
  });
});
