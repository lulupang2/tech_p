import { describe, expect, test } from 'vitest';
import { extractSearchKeywords, prioritizeSearchKeywords } from '../src/index.js';

describe('extractSearchKeywords (Query Normalization)', () => {
  test("extracts meaningful keywords from '최근 Playwright 릴리스의 주요 변경점을 알려줘.'", () => {
    const keywords = extractSearchKeywords('최근 Playwright 릴리스의 주요 변경점을 알려줘.');
    expect(keywords).toContain('Playwright');
    expect(keywords).toContain('릴리스');
    expect(keywords).toContain('변경점');
    expect(keywords).not.toContain('최근');
    expect(keywords).not.toContain('주요');
    expect(keywords).not.toContain('알려줘');
  });

  test("strips mixed English+Korean particles like 'Bun과' and 'Node.js는'", () => {
    const keywords = extractSearchKeywords('Bun과 Node.js 성능 비교해줘');
    expect(keywords).toEqual(['Bun', 'Node.js', '성능']);
  });

  test('extracts technical terms from English natural questions', () => {
    const keywords = extractSearchKeywords('What are the latest updates in Playwright v1.62.1?');
    expect(keywords).toContain('Playwright');
    expect(keywords).toContain('v1.62.1');
    expect(keywords).not.toContain('what');
    expect(keywords).not.toContain('latest');
  });

  test("extracts meaningful tokens from unrelated query '오늘 서울 날씨 어때?'", () => {
    const keywords = extractSearchKeywords('오늘 서울 날씨 어때?');
    expect(keywords).toEqual(['서울', '날씨']);
  });

  test('returns empty array when query consists only of conversational filler', () => {
    expect(extractSearchKeywords('알려주세요')).toEqual([]);
    expect(extractSearchKeywords('어떤가요?')).toEqual([]);
    expect(extractSearchKeywords('   ')).toEqual([]);
    expect(extractSearchKeywords('')).toEqual([]);
  });
});

describe('prioritizeSearchKeywords', () => {
  test('puts exact release identifiers ahead of generic natural-language terms', () => {
    const keywords = extractSearchKeywords(
      'Summarize nodejs/node release "2026-09-08, Version 24.21.0 Krypton (LTS)".',
    );
    const prioritized = prioritizeSearchKeywords(keywords);
    expect(prioritized.slice(0, 2)).toEqual(['24.21.0', '2026-09-08']);
    expect(prioritized).not.toContain('Summarize');
    expect(prioritized).not.toContain('release');
    expect(prioritized).not.toContain('Version');
  });
});
