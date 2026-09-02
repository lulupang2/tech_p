import { describe, expect, test } from 'vitest';
import {
  GOLDEN_SET,
  GOLDEN_SET_ITEMS,
  GOLDEN_SET_METADATA,
  GoldenSetValidationError,
  getGoldenSetInjections,
  getGoldenSetItemById,
  getGoldenSetItemsByCategory,
  getGoldenSetItemsByStatus,
  getGoldenSetQuestions,
  safeParseGoldenSetCollection,
  validateGoldenSetCollection,
  validateGoldenSetItem,
  type GoldenSetItem,
} from '../src/index.js';

describe('Golden Set Schema and Completeness (EVAL-001)', () => {
  test('metadata matches EVAL-001 contract', () => {
    expect(GOLDEN_SET_METADATA.reviewer).toBe('Signal Archive Evaluation Team');
    expect(GOLDEN_SET_METADATA.reviewedAt).toBe('2026-09-02');
    expect(GOLDEN_SET_METADATA.totalItems).toBe(43);
    expect(GOLDEN_SET_METADATA.questionCount).toBe(38);
    expect(GOLDEN_SET_METADATA.securityInjectionCount).toBe(5);
  });

  test('validates complete collection against schema', () => {
    expect(() => validateGoldenSetCollection(GOLDEN_SET)).not.toThrow();

    const parseResult = safeParseGoldenSetCollection(GOLDEN_SET);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.data.items).toHaveLength(43);
    }
  });

  test('contains exactly 43 unique items with continuous IDs G-001 through G-043', () => {
    expect(GOLDEN_SET_ITEMS).toHaveLength(43);

    const ids = GOLDEN_SET_ITEMS.map((item) => item.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(43);

    for (let i = 1; i <= 43; i += 1) {
      const expectedId = `G-${String(i).padStart(3, '0')}`;
      expect(ids).toContain(expectedId);
    }
  });

  test('contains exactly 38 questions and 5 security injections', () => {
    const questions = getGoldenSetQuestions();
    const injections = getGoldenSetInjections();

    expect(questions).toHaveLength(38);
    expect(injections).toHaveLength(5);

    const injectionIds = injections.map((item) => item.id);
    expect(injectionIds).toEqual(['G-034', 'G-035', 'G-036', 'G-037', 'G-038']);

    for (const injection of injections) {
      expect(injection.isSecurityInjection).toBe(true);
      expect(injection.injectionContent).toBeDefined();
      expect(injection.injectionContent?.length).toBeGreaterThan(0);
    }

    for (const q of questions) {
      expect(q.isSecurityInjection).toBe(false);
    }
  });

  test('satisfies minimum 6 items with insufficient_evidence or unsupported_intent', () => {
    const insufficientItems = getGoldenSetItemsByStatus('insufficient_evidence');
    const unsupportedItems = getGoldenSetItemsByStatus('unsupported_intent');
    const combinedCount = insufficientItems.length + unsupportedItems.length;

    expect(combinedCount).toBeGreaterThanOrEqual(6);
    expect(insufficientItems.length).toBeGreaterThanOrEqual(5);
    expect(unsupportedItems.length).toBeGreaterThanOrEqual(2);

    // Verify key boundary cases
    const insufficientIds = insufficientItems.map((i) => i.id);
    expect(insufficientIds).toContain('G-013'); // Future time range
    expect(insufficientIds).toContain('G-014'); // npm pre-2015 bound
    expect(insufficientIds).toContain('G-015'); // repo_attention backfill limitation
    expect(insufficientIds).toContain('G-017'); // 24h no data
    expect(insufficientIds).toContain('G-018'); // Non-existent entity
    expect(insufficientIds).toContain('G-024'); // <50 daily download noise
    expect(insufficientIds).toContain('G-043'); // 3d short window no data

    const unsupportedIds = unsupportedItems.map((i) => i.id);
    expect(unsupportedIds).toContain('G-022'); // Unsubstantiated future forecasting
    expect(unsupportedIds).toContain('G-023'); // Subjective tech decision
  });

  test('every item has required structured evaluation fields', () => {
    for (const item of GOLDEN_SET_ITEMS) {
      expect(item.id).toMatch(/^G-\d{3}$/);
      expect(item.question.length).toBeGreaterThan(0);
      expect(item.notes.length).toBeGreaterThan(0);
      expect(item.allowedClaims.length).toBeGreaterThanOrEqual(1);
      expect(item.forbiddenClaims.length).toBeGreaterThanOrEqual(1);
      expect(['answered', 'insufficient_evidence', 'unsupported_intent']).toContain(
        item.expectedStatus,
      );
      expect(item.expectedTimeRange).toBeDefined();
      expect(Array.isArray(item.expectedMetrics)).toBe(true);
      expect(Array.isArray(item.expectedLimitations)).toBe(true);
      expect(() => validateGoldenSetItem(item)).not.toThrow();
    }
  });

  test('category distribution covers all defined categories', () => {
    const userExamples = getGoldenSetItemsByCategory('user_example');
    const languageAliases = getGoldenSetItemsByCategory('language_alias');
    const timeBoundaries = getGoldenSetItemsByCategory('time_boundary');
    const evidenceConflicts = getGoldenSetItemsByCategory('evidence_and_conflict');
    const metricCalculations = getGoldenSetItemsByCategory('metric_calculation');
    const licenseCitations = getGoldenSetItemsByCategory('license_and_citation');
    const securityInjections = getGoldenSetItemsByCategory('security_injection');
    const deduplications = getGoldenSetItemsByCategory('deduplication');
    const additionalEnglish = getGoldenSetItemsByCategory('additional_english');

    expect(userExamples).toHaveLength(4);
    expect(languageAliases).toHaveLength(6);
    expect(timeBoundaries).toHaveLength(6);
    expect(evidenceConflicts).toHaveLength(7);
    expect(metricCalculations).toHaveLength(6);
    expect(licenseCitations).toHaveLength(4);
    expect(securityInjections).toHaveLength(5);
    expect(deduplications).toHaveLength(2);
    expect(additionalEnglish).toHaveLength(3);
  });

  test('lookup by ID returns the correct item', () => {
    const itemG001 = getGoldenSetItemById('G-001');
    expect(itemG001).toBeDefined();
    expect(itemG001?.question).toBe('최근 7일간 TypeScript 백엔드 분야의 주요 트렌드는?');
    expect(itemG001?.intent).toBe('trend_summary');

    const nonExistent = getGoldenSetItemById('G-999');
    expect(nonExistent).toBeUndefined();
  });

  test('validator rejects malformed golden set items', () => {
    const invalidItem = {
      id: 'INVALID-ID',
      question: '',
      category: 'user_example',
      intent: 'invalid_intent',
      isSecurityInjection: false,
      relevanceCriteria: [],
      allowedClaims: [],
      forbiddenClaims: [],
      expectedStatus: 'invalid_status',
      expectedTimeRange: { from: null, to: null },
      expectedMetrics: [],
      expectedLimitations: [],
      notes: '',
    };

    expect(() => validateGoldenSetItem(invalidItem)).toThrow(GoldenSetValidationError);

    const parseResult = safeParseGoldenSetCollection({
      metadata: GOLDEN_SET_METADATA,
      items: [invalidItem as unknown as GoldenSetItem],
    });
    expect(parseResult.success).toBe(false);
    if (!parseResult.success) {
      expect(parseResult.error.issues.length).toBeGreaterThan(0);
    }
  });
});
