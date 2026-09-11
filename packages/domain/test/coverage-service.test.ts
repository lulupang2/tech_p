import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  diagnoseCoverageReasons,
  validateCoverageWindow,
  evaluateCohortComparison,
  type MemberCoverageEvaluation,
} from '../src/coverage-service.js';
import type { ObservationCohort } from '../src/coverage.js';

describe('COV-006 Coverage Service & Diagnosis (Domain)', () => {
  describe('diagnoseCoverageReasons', () => {
    it('distinguishes absent raw from known retrieval miss', () => {
      // 1. Absent raw: targets/partitions exist, but 0 raw items collected
      const rawShortageReasons = diagnoseCoverageReasons({
        rawDocuments: 0,
        lexicalDocuments: 0,
        vectorDocuments: 0,
        partitionsChecked: 2,
        partitionsCompleted: 2,
        partitionsPartial: 0,
        targetCount: 1,
      });
      assert.deepEqual(rawShortageReasons, ['raw_shortage']);

      // 2. Known relevant miss: ready documents exist, but candidate retrieval missed known document
      const retrievalMissReasons = diagnoseCoverageReasons({
        rawDocuments: 10,
        lexicalDocuments: 10,
        vectorDocuments: 10,
        partitionsChecked: 2,
        partitionsCompleted: 2,
        partitionsPartial: 0,
        targetCount: 1,
        hasKnownMiss: true,
      });
      assert.deepEqual(retrievalMissReasons, ['retrieval_miss']);
    });

    it('identifies processing_pending when raw items are unindexed or missing vector stage', () => {
      const processingPendingReasons = diagnoseCoverageReasons({
        rawDocuments: 10,
        lexicalDocuments: 5,
        vectorDocuments: 0,
        partitionsChecked: 2,
        partitionsCompleted: 2,
        partitionsPartial: 0,
        targetCount: 1,
      });
      assert.deepEqual(processingPendingReasons, ['processing_pending']);
    });

    it('identifies period_gap when partitions are partial or missing', () => {
      const periodGapReasons = diagnoseCoverageReasons({
        rawDocuments: 10,
        lexicalDocuments: 10,
        vectorDocuments: 10,
        partitionsChecked: 4,
        partitionsCompleted: 2,
        partitionsPartial: 2,
        targetCount: 2,
      });
      assert.deepEqual(periodGapReasons, ['period_gap']);
    });

    it('returns evidence-free unknown when no targets, partitions, or counts exist', () => {
      const unknownReasons = diagnoseCoverageReasons({
        rawDocuments: 0,
        lexicalDocuments: 0,
        vectorDocuments: 0,
        partitionsChecked: 0,
        partitionsCompleted: 0,
        partitionsPartial: 0,
        targetCount: 0,
      });
      assert.deepEqual(unknownReasons, ['unknown']);
    });

    it('returns empty reasons array when all stages and partitions are 100% complete', () => {
      const completeReasons = diagnoseCoverageReasons({
        rawDocuments: 20,
        lexicalDocuments: 20,
        vectorDocuments: 20,
        partitionsChecked: 3,
        partitionsCompleted: 3,
        partitionsPartial: 0,
        targetCount: 3,
      });
      assert.deepEqual(completeReasons, []);
    });

    it('combines multiple valid reasons when multiple shortages are evidenced', () => {
      const multipleReasons = diagnoseCoverageReasons({
        rawDocuments: 5,
        lexicalDocuments: 2,
        vectorDocuments: 1,
        partitionsChecked: 5,
        partitionsCompleted: 3,
        partitionsPartial: 2,
        targetCount: 2,
        hasKnownMiss: true,
      });
      assert.deepEqual(multipleReasons, ['processing_pending', 'period_gap', 'retrieval_miss']);
    });
  });

  describe('validateCoverageWindow', () => {
    it('accepts valid UTC windows', () => {
      assert.doesNotThrow(() =>
        validateCoverageWindow({
          from: new Date('2026-06-01T00:00:00Z'),
          to: new Date('2026-09-01T00:00:00Z'),
        }),
      );
    });

    it('rejects inverted or non-finite windows', () => {
      assert.throws(
        () =>
          validateCoverageWindow({
            from: new Date('2026-09-01T00:00:00Z'),
            to: new Date('2026-06-01T00:00:00Z'),
          }),
        /invalid_window/u,
      );
      assert.throws(
        () =>
          validateCoverageWindow({
            from: new Date('invalid'),
            to: new Date('2026-06-01T00:00:00Z'),
          }),
        /invalid_window/u,
      );
    });
  });

  describe('evaluateCohortComparison', () => {
    const cohort: ObservationCohort = {
      id: '00000000-0000-0000-0000-000000000001',
      version: 'v1.0.0',
      effectiveAt: new Date('2026-01-01T00:00:00Z'),
      members: [
        {
          targetRevisionId: 'tr-1',
          metric: 'release_activity',
          unit: 'releases',
          querySignature: 'sig-1',
          cadenceMs: 60000,
        },
        {
          targetRevisionId: 'tr-2',
          metric: 'release_activity',
          unit: 'releases',
          querySignature: 'sig-2',
          cadenceMs: 60000,
        },
        {
          targetRevisionId: 'tr-3',
          metric: 'release_activity',
          unit: 'releases',
          querySignature: 'sig-3',
          cadenceMs: 60000,
        },
      ],
    };

    it('compares only common covered target revisions in both windows', () => {
      const evaluations: MemberCoverageEvaluation[] = [
        {
          targetRevisionId: 'tr-1',
          baselineCovered: true,
          currentCovered: true,
          baselineValue: 10,
          currentValue: 15,
        },
        {
          targetRevisionId: 'tr-2',
          baselineCovered: true,
          currentCovered: true,
          baselineValue: 5,
          currentValue: 8,
        },
        {
          targetRevisionId: 'tr-3',
          baselineCovered: true,
          currentCovered: false, // Incomplete in current window -> excluded from common denominator
          baselineValue: 20,
          currentValue: null,
        },
      ];

      const result = evaluateCohortComparison(cohort, 'release_activity', 'releases', evaluations);
      assert.equal(result.denominator, 2);
      assert.equal(result.excludedTargets, 1);
      assert.equal(result.baseline, 15); // 10 + 5 (tr-3 is excluded!)
      assert.equal(result.current, 23); // 15 + 8 (tr-3 is excluded!)
      assert.equal(result.partial, true); // Since 1 target was excluded
    });

    it('reports missing denominator when no common covered targets exist', () => {
      const evaluations: MemberCoverageEvaluation[] = [
        {
          targetRevisionId: 'tr-1',
          baselineCovered: true,
          currentCovered: false,
          baselineValue: 10,
          currentValue: null,
        },
        {
          targetRevisionId: 'tr-2',
          baselineCovered: false,
          currentCovered: true,
          baselineValue: null,
          currentValue: 8,
        },
        {
          targetRevisionId: 'tr-3',
          baselineCovered: false,
          currentCovered: false,
          baselineValue: null,
          currentValue: null,
        },
      ];

      const result = evaluateCohortComparison(cohort, 'release_activity', 'releases', evaluations);
      assert.equal(result.denominator, 0);
      assert.equal(result.excludedTargets, 3);
      assert.equal(result.baseline, null);
      assert.equal(result.current, null);
      assert.equal(result.partial, true);
    });

    it('is completely deterministic and unchanged when on-demand additions are present', () => {
      const regularEvaluations: MemberCoverageEvaluation[] = [
        {
          targetRevisionId: 'tr-1',
          baselineCovered: true,
          currentCovered: true,
          baselineValue: 12,
          currentValue: 18,
        },
        {
          targetRevisionId: 'tr-2',
          baselineCovered: true,
          currentCovered: true,
          baselineValue: 6,
          currentValue: 9,
        },
        {
          targetRevisionId: 'tr-3',
          baselineCovered: true,
          currentCovered: true,
          baselineValue: 3,
          currentValue: 4,
        },
      ];

      const res1 = evaluateCohortComparison(
        cohort,
        'release_activity',
        'releases',
        regularEvaluations,
      );
      const res2 = evaluateCohortComparison(
        cohort,
        'release_activity',
        'releases',
        regularEvaluations,
      );

      assert.deepEqual(res1, res2);
      assert.equal(res1.denominator, 3);
      assert.equal(res1.excludedTargets, 0);
      assert.equal(res1.baseline, 21);
      assert.equal(res1.current, 31);
      assert.equal(res1.partial, false);
    });
  });
});
