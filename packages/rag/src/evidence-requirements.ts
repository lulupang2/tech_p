import type { SearchHit } from '@techpulse/domain';

export interface EvidenceRequirementResult {
  readonly satisfied: boolean;
  readonly limitation: string | null;
  readonly requiredSourceKeys: readonly string[];
}

interface EvidenceRequirement {
  readonly sourceKeys?: readonly string[];
  readonly limitation: string;
  readonly prohibited?: boolean;
}

function detectRequirement(question: string): EvidenceRequirement | null {
  const text = question.normalize('NFKC').toLocaleLowerCase('en-US');

  if (
    /종합\s*(?:인기|관심)?\s*점수/u.test(text) ||
    /(?:combined|composite)\s+(?:popularity|interest)?\s*score/u.test(text)
  ) {
    return {
      prohibited: true,
      limitation:
        '서로 다른 출처·단위의 신호를 하나의 종합 인기 점수로 합산하는 것은 지원하지 않습니다.',
    };
  }

  if (/(?:npm[^\n]{0,24}(?:download|다운로드)|(?:download|다운로드)[^\n]{0,24}npm)/u.test(text)) {
    return {
      sourceKeys: ['npm_downloads'],
      limitation:
        '요청한 npm 다운로드 지표를 뒷받침하는 npm_downloads 근거가 현재 검색 범위에 없습니다.',
    };
  }

  if (/\barxiv\b/u.test(text) || /(?:논문|papers?)/u.test(text)) {
    return {
      sourceKeys: ['arxiv'],
      limitation: '요청한 논문 동향을 뒷받침하는 arXiv 근거가 현재 검색 범위에 없습니다.',
    };
  }

  if (
    /커뮤니티[^\n]{0,24}(?:언급|관심|반응|논쟁|토론)/u.test(text) ||
    /community[^\n]{0,24}(?:mention|attention|reaction|debate|discussion)/u.test(text)
  ) {
    return {
      sourceKeys: ['github_search', 'stack_exchange', 'users_rust_lang', 'reddit'],
      limitation:
        '요청한 커뮤니티 신호를 뒷받침하는 커뮤니티·검색 지표 근거가 현재 검색 범위에 없습니다.',
    };
  }

  return null;
}

/**
 * Rejects evidence-type substitutions (for example release notes standing in for
 * download/community metrics) before a model can turn them into an unsupported claim.
 */
export function evaluateEvidenceRequirement(
  question: string,
  hits: readonly Pick<SearchHit, 'sourceKey'>[],
): EvidenceRequirementResult {
  const requirement = detectRequirement(question);
  if (!requirement) return { satisfied: true, limitation: null, requiredSourceKeys: [] };
  if (requirement.prohibited) {
    return { satisfied: false, limitation: requirement.limitation, requiredSourceKeys: [] };
  }

  const requiredSourceKeys = requirement.sourceKeys ?? [];
  const available = new Set(
    hits.map((hit) => hit.sourceKey).filter((value): value is string => Boolean(value)),
  );
  const satisfied = requiredSourceKeys.some((key) => available.has(key));
  return {
    satisfied,
    limitation: satisfied ? null : requirement.limitation,
    requiredSourceKeys,
  };
}
