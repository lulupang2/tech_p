import { describe, expect, test } from 'vitest';
import { evaluateEvidenceRequirement } from '../src/index.js';

describe('evidence requirement gate', () => {
  test('does not substitute GitHub releases for npm download metrics', () => {
    const result = evaluateEvidenceRequirement('Bun의 최근 npm 다운로드 수는?', [
      { sourceKey: 'github_releases' },
    ]);
    expect(result.satisfied).toBe(false);
    expect(result.requiredSourceKeys).toEqual(['npm_downloads']);
    expect(result.limitation).toContain('npm_downloads');
  });

  test('accepts the matching metric source', () => {
    expect(
      evaluateEvidenceRequirement('Bun npm 다운로드 추이를 알려줘', [
        { sourceKey: 'npm_downloads' },
      ]).satisfied,
    ).toBe(true);
  });

  test('requires paper/community evidence and prohibits composite popularity scores', () => {
    expect(
      evaluateEvidenceRequirement('RAG 관련 최근 논문은?', [{ sourceKey: 'github_releases' }])
        .satisfied,
    ).toBe(false);
    expect(
      evaluateEvidenceRequirement('React 커뮤니티 언급량 변화는?', [
        { sourceKey: 'github_releases' },
      ]).satisfied,
    ).toBe(false);
    expect(
      evaluateEvidenceRequirement('Playwright와 Node.js 종합 인기 점수를 계산해줘', [
        { sourceKey: 'github_search' },
      ]).satisfied,
    ).toBe(false);
  });
});
