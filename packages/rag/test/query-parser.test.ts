import { describe, expect, test } from 'vitest';
import {
  InvalidTimeRangeError,
  UNBOUNDED_START,
  parseQuery,
  resolveTimeRange,
} from '../src/index.js';

describe('provider-neutral query parser (RAG-001)', () => {
  const fixedNow = new Date('2026-09-01T12:00:00.000Z');
  const now = () => fixedNow;

  test('parses all four supported intents deterministically', () => {
    expect(parseQuery({ question: 'TypeScript 트렌드 요약', now }).intent).toBe('trend_summary');
    expect(parseQuery({ question: 'Playwright 최신 업데이트', now }).intent).toBe('recent_updates');
    expect(parseQuery({ question: 'Bun과 Node.js 비교', now }).intent).toBe('compare_interest');
    expect(parseQuery({ question: '최근 부상 기술', now }).intent).toBe('emerging_topics');
  });

  test('extracts repository targets before Korean particles', () => {
    expect(parseQuery({ question: 'microsoft/typescript의 최신 릴리스', now })).toMatchObject({
      latestOnly: true,
      repositoryTarget: 'microsoft/typescript',
    });
    expect(parseQuery({ question: 'nodejs/node에서 바뀐 내용', now }).repositoryTarget).toBe(
      'nodejs/node',
    );
  });

  test('extracts canonical entities and preserves their original expressions', () => {
    const parsed = parseQuery({
      question: '타입스크립트와 Playwright 최근 업데이트',
      now,
    });
    expect(parsed.entities).toEqual([
      expect.objectContaining({ id: 'typescript', originalText: '타입스크립트' }),
      expect.objectContaining({ id: 'playwright', originalText: 'Playwright' }),
    ]);
    expect(parsed.language).toBe('ko');
  });

  test('does not promote an ambiguous standalone alias to an entity', () => {
    const parsed = parseQuery({ question: 'next 최근 트렌드', now });
    expect(parsed.entities).toEqual([]);
    expect(parsed.ambiguities).toEqual([
      {
        kind: 'ambiguous_entity',
        originalText: 'next',
        candidateEntityIds: ['nextjs'],
      },
    ]);

    const contextual = parseQuery({ question: 'Next.js router 최근 업데이트', now });
    expect(contextual.entities.map(({ id }) => id)).toContain('nextjs');
    expect(contextual.ambiguities).toEqual([]);
  });

  test('resolves recent days as a rolling duration and records the IANA timezone', () => {
    const parsed = parseQuery({
      question: '최근 7일 TypeScript 트렌드',
      timezone: 'Asia/Seoul',
      now,
    });
    expect(parsed.timeRangeSource).toBe('natural_language');
    expect(parsed.timeRange).toEqual({
      from: '2026-08-25T12:00:00.000Z',
      to: '2026-09-01T12:00:00.000Z',
      timezone: 'Asia/Seoul',
    });
  });

  test('explicit API bounds override a natural-language duration', () => {
    const parsed = parseQuery({
      question: '최근 7일 TypeScript 트렌드',
      timeRange: {
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
      },
      timezone: 'UTC',
      now,
    });
    expect(parsed.timeRangeSource).toBe('explicit');
    expect(parsed.timeRange.from).toBe('2026-07-01T00:00:00.000Z');
  });

  test('keeps omitted periods unbounded and rejects invalid timezone names', () => {
    expect(parseQuery({ question: 'TypeScript 트렌드', now }).timeRange.from).toBe(UNBOUNDED_START);
    expect(() => resolveTimeRange(undefined, 'Mars/Olympus', now)).toThrow(InvalidTimeRangeError);
  });

  test('rejects partial ranges and timestamps without RFC 3339 time/offset', () => {
    expect(() => resolveTimeRange({ from: '2026-08-01T00:00:00Z' }, 'UTC', now)).toThrow(
      InvalidTimeRangeError,
    );
    expect(() => resolveTimeRange({ from: '2026-08-01', to: '2026-08-02' }, 'UTC', now)).toThrow(
      InvalidTimeRangeError,
    );
  });
});
