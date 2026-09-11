export interface SearchHit {
  readonly canonicalUrl?: string;
  readonly sourceKey?: string;
  readonly license?: {
    readonly id: string;
    readonly name: string;
    readonly url: string;
    readonly attribution: string;
  };
  readonly chunkId: string;
  readonly documentId: string;
  readonly duplicateClusterId?: string | null;
  readonly documentRevisionId: string;
  readonly title: string;
  readonly content: string;
  readonly headingPath: string[];
  readonly ordinal?: number;
  readonly tokenCount?: number;
  readonly score: number;
  readonly publishedAt: Date | null;
}

export interface SearchFilter {
  readonly status?: string;
  readonly publishedAfter?: Date;
  readonly publishedBefore?: Date;
  readonly topicSlugs?: readonly string[];
  /** RAG/model-input paths must opt into fail-closed source and revision rights checks. */
  readonly requireApprovedRights?: boolean;
}

export interface FtsQueryParams {
  readonly query: string;
  readonly filter?: SearchFilter;
  readonly limit?: number;
}

export interface ExactVectorQueryParams {
  readonly vector: readonly number[];
  readonly dimensions: number;
  readonly provider: string;
  readonly model: string;
  readonly profileHash?: string;
  readonly filter?: SearchFilter;
  readonly limit?: number;
}

export interface SearchServicePort {
  readonly searchFts: (params: FtsQueryParams) => Promise<readonly SearchHit[]>;
  readonly searchExactVector: (params: ExactVectorQueryParams) => Promise<readonly SearchHit[]>;
}

const KOREAN_CONVERSATIONAL_VERBS: Record<string, true> = {
  알려줘: true,
  알려줘요: true,
  알려주세요: true,
  알려줄래: true,
  알려주실래요: true,
  알려드립니다: true,
  설명해줘: true,
  설명해줘요: true,
  설명해주세요: true,
  요약해줘: true,
  요약해줘요: true,
  요약해주세요: true,
  정리해줘: true,
  정리해줘요: true,
  정리해주세요: true,
  말해줘: true,
  말해줘요: true,
  말해주세요: true,
  소개해줘: true,
  소개해줘요: true,
  소개해주세요: true,
  비교해줘: true,
  비교해줘요: true,
  비교해주세요: true,
  추천해줘: true,
  추천해줘요: true,
  추천해주세요: true,
  찾아줘: true,
  찾아주세요: true,
  어떤가요: true,
  무엇인가요: true,
  어떤지: true,
  무엇인지: true,
  어때: true,
  어때요: true,
  어떨까: true,
  어떨까요: true,
  있나요: true,
  있어: true,
  있을까: true,
  있을까요: true,
  있습니까: true,
  부탁해: true,
  부탁해요: true,
  부탁드립니다: true,
  궁금해: true,
  궁금해요: true,
  알고싶어: true,
  알고싶어요: true,
};

const CONVERSATIONAL_STOPWORDS: Record<string, true> = {
  // Korean modifiers / filler
  최근: true,
  최신의: true,
  최신: true,
  요즘: true,
  오늘: true,
  현재: true,
  주요: true,
  관련: true,
  관련된: true,
  관련해: true,
  대해: true,
  대해서: true,
  대한: true,
  어떤: true,
  어떻게: true,
  왜: true,
  무엇: true,
  혹시: true,
  진짜: true,
  정말: true,
  모두: true,
  다: true,
  및: true,
  // English stopwords
  what: true,
  is: true,
  are: true,
  the: true,
  a: true,
  an: true,
  in: true,
  of: true,
  to: true,
  for: true,
  and: true,
  or: true,
  tell: true,
  me: true,
  about: true,
  show: true,
  recent: true,
  latest: true,
  how: true,
  why: true,
  please: true,
  explain: true,
};

const KOREAN_PARTICLES = [
  '에서는',
  '에게는',
  '으로는',
  '에서',
  '에게',
  '으로',
  '까지',
  '부터',
  '처럼',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에',
  '로',
  '와',
  '과',
  '도',
  '만',
];

function stripParticle(word: string): string {
  const mixedMatch = /^([A-Za-z0-9_.-]+)([\uAC00-\uD7A3]+)$/.exec(word);
  if (mixedMatch) {
    const [, prefix, suffix] = mixedMatch;
    if (prefix && suffix && KOREAN_PARTICLES.includes(suffix)) {
      return prefix;
    }
  }
  if (/^[\uAC00-\uD7A3]+$/.test(word)) {
    for (const particle of KOREAN_PARTICLES) {
      if (word.endsWith(particle) && word.length - particle.length >= 2) {
        return word.slice(0, word.length - particle.length);
      }
    }
  }
  return word;
}

export function extractSearchKeywords(rawQuery: string): string[] {
  if (!rawQuery || typeof rawQuery !== 'string') return [];

  const cleaned = rawQuery
    .replace(/[?!~^;:"'“”‘’[\](){}<>\\/`*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return [];

  const rawTokens = cleaned.split(' ');
  const result: string[] = [];
  const seen = new Set<string>();

  for (let token of rawTokens) {
    token = token.replace(/[.,]+$/, '');
    if (!token) continue;

    const lower = token.toLowerCase();
    if (KOREAN_CONVERSATIONAL_VERBS[token] === true || CONVERSATIONAL_STOPWORDS[lower] === true) {
      continue;
    }

    const stemmed = stripParticle(token);
    const stemmedLower = stemmed.toLowerCase();

    if (
      KOREAN_CONVERSATIONAL_VERBS[stemmed] === true ||
      CONVERSATIONAL_STOPWORDS[stemmedLower] === true
    ) {
      continue;
    }

    if (stemmed.length >= 2 || /^[A-Za-z0-9]/.test(stemmed)) {
      const key = stemmedLower;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(stemmed);
      }
    }
  }

  return result;
}

const LOW_SIGNAL_SEARCH_TERMS = new Set([
  'summarize',
  'summary',
  'release',
  'releases',
  'version',
  'current',
  'lts',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

/** Orders fallback terms by retrieval specificity instead of natural-language position. */
export function prioritizeSearchKeywords(keywords: readonly string[]): string[] {
  const priority = (value: string): number => {
    const lower = value.toLowerCase();
    if (/^v?\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.-]+)?$/iu.test(value)) return 0;
    if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return 1;
    if (/\d/u.test(value) && /[._-]/u.test(value)) return 2;
    if (LOW_SIGNAL_SEARCH_TERMS.has(lower) || /^\d{1,2}(?:st|nd|rd|th)$/iu.test(value)) return 9;
    if (/^[A-Za-z][A-Za-z0-9@._/-]*$/u.test(value)) return 4;
    return 6;
  };
  return keywords
    .map((value, index) => ({ value, index, priority: priority(value) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .filter((item) => item.priority < 9)
    .map((item) => item.value);
}
