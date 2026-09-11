import type { ResolvedTimeRange } from '@techpulse/contracts';
import { TOPIC_TAXONOMY, classifyTopics, type TopicClassification } from '@techpulse/domain';

export const QUERY_INTENTS = [
  'trend_summary',
  'recent_updates',
  'compare_interest',
  'emerging_topics',
] as const;

export type QueryIntent = (typeof QUERY_INTENTS)[number];

export interface QueryEntity {
  readonly id: string;
  readonly displayName: string;
  readonly originalText: string;
  readonly confidence: number;
}

export interface QueryAmbiguity {
  readonly kind: 'ambiguous_entity';
  readonly originalText: string;
  readonly candidateEntityIds: readonly string[];
}

export interface ParsedQuery {
  readonly intent: QueryIntent;
  readonly latestOnly: boolean;
  readonly repositoryTarget: string | null;
  readonly entities: readonly QueryEntity[];
  readonly timeRange: ResolvedTimeRange;
  readonly timeRangeSource: 'explicit' | 'natural_language' | 'unbounded';
  readonly language: 'ko' | 'en';
  readonly ambiguities: readonly QueryAmbiguity[];
}

export class InvalidTimeRangeError extends Error {
  readonly code = 'INVALID_TIME_RANGE' as const;
  readonly path = 'timeRange.to' as const;
  constructor(message = 'timeRange.to must be after timeRange.from') {
    super(message);
    this.name = 'InvalidTimeRangeError';
  }
}

export const UNBOUNDED_START = '1970-01-01T00:00:00.000Z';

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    throw new InvalidTimeRangeError(`timezone is not a valid IANA timezone: ${timezone}`);
  }
}

export function detectIntent(question: string): QueryIntent {
  const lower = question.normalize('NFKC').toLocaleLowerCase('en-US');
  if (
    lower.includes('비교') ||
    lower.includes('compare') ||
    /\bvs\.?\b/u.test(lower) ||
    lower.includes('관심 변화') ||
    lower.includes('차이')
  ) {
    return 'compare_interest';
  }
  if (
    lower.includes('업데이트') ||
    lower.includes('최신 릴리스') ||
    /\breleases?\b/u.test(lower) ||
    lower.includes('changelog') ||
    lower.includes('변경점')
  ) {
    return 'recent_updates';
  }
  if (
    lower.includes('부상') ||
    lower.includes('emerging') ||
    lower.includes('주목') ||
    lower.includes('트렌딩') ||
    lower.includes('인기 급상승')
  ) {
    return 'emerging_topics';
  }
  return 'trend_summary';
}

export function asksForLatestRelease(question: string): boolean {
  const lower = question.normalize('NFKC').toLocaleLowerCase('en-US');
  return (
    /최신\s*(?:릴리스|버전|업데이트)/u.test(lower) ||
    /\b(?:latest|newest)\s+(?:stable\s+)?(?:release|version|update)\b/u.test(lower)
  );
}

export function extractRepositoryTarget(question: string): string | null {
  return (
    /(?:^|[^a-z0-9_./-])([a-z0-9_.-]+\/[a-z0-9_.-]+)(?![a-z0-9_./-])/iu
      .exec(question.normalize('NFKC'))?.[1]
      ?.toLocaleLowerCase('en-US') ?? null
  );
}

export function resolveTimeRange(
  requestTimeRange?: { readonly from?: string; readonly to?: string },
  requestTimezone?: string,
  nowFn: () => Date = () => new Date(),
): ResolvedTimeRange {
  const timezone = requestTimezone?.trim() ? requestTimezone.trim() : 'UTC';
  assertTimezone(timezone);

  if (requestTimeRange && (!requestTimeRange.from || !requestTimeRange.to)) {
    throw new InvalidTimeRangeError('timeRange.from and timeRange.to must be provided together');
  }

  if (requestTimeRange?.from && requestTimeRange?.to) {
    const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
    if (!rfc3339.test(requestTimeRange.from) || !rfc3339.test(requestTimeRange.to)) {
      throw new InvalidTimeRangeError('timeRange contains malformed RFC 3339 timestamps');
    }
    const fromDate = new Date(requestTimeRange.from);
    const toDate = new Date(requestTimeRange.to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new InvalidTimeRangeError('timeRange contains malformed RFC 3339 timestamps');
    }
    if (toDate.getTime() <= fromDate.getTime()) {
      throw new InvalidTimeRangeError('timeRange.to must be after timeRange.from');
    }
    return { from: fromDate.toISOString(), to: toDate.toISOString(), timezone };
  }

  const to = nowFn();
  return { from: UNBOUNDED_START, to: to.toISOString(), timezone };
}

function naturalLanguageDurationMs(question: string): number | undefined {
  const normalized = question.normalize('NFKC').toLocaleLowerCase('en-US');
  const numeric =
    normalized.match(/(?:최근|지난)\s*(\d{1,3})\s*(시간|일|주|개월|달)/u) ??
    normalized.match(/(?:last|past|recent)\s+(\d{1,3})\s*(hours?|days?|weeks?|months?)/u);
  if (numeric) {
    const amount = Number(numeric[1]);
    if (amount < 1 || amount > 365) return undefined;
    const unit = numeric[2] ?? '';
    if (/시간|hour/u.test(unit)) return amount * 60 * 60 * 1000;
    if (/주|week/u.test(unit)) return amount * 7 * 24 * 60 * 60 * 1000;
    if (/개월|달|month/u.test(unit)) return amount * 30 * 24 * 60 * 60 * 1000;
    return amount * 24 * 60 * 60 * 1000;
  }
  if (/(?:최근|지난)\s*(?:한|1)\s*(?:달|개월)|\blast month\b/u.test(normalized)) {
    return 30 * 24 * 60 * 60 * 1000;
  }
  if (/(?:최근|지난)\s*(?:한|1)\s*주|\blast week\b/u.test(normalized)) {
    return 7 * 24 * 60 * 60 * 1000;
  }
  return undefined;
}

function originalAlias(question: string, classification: TopicClassification): string {
  const matched = classification.matchedAliases[0] ?? classification.displayName;
  const index = question.toLocaleLowerCase('en-US').indexOf(matched.toLocaleLowerCase('en-US'));
  return index >= 0 ? question.slice(index, index + matched.length) : matched;
}

function containsAlias(text: string, alias: string): boolean {
  const normalizedText = text.normalize('NFKC').toLocaleLowerCase('en-US');
  const normalizedAlias = alias.normalize('NFKC').toLocaleLowerCase('en-US');
  const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(
    normalizedText,
  );
}

function findAmbiguities(
  question: string,
  classifiedEntityIds: ReadonlySet<string>,
): readonly QueryAmbiguity[] {
  const byAlias = new Map<string, Set<string>>();
  for (const entry of TOPIC_TAXONOMY) {
    if (classifiedEntityIds.has(entry.slug)) continue;
    for (const alias of entry.ambiguousAliases) {
      if (!containsAlias(question, alias)) continue;
      const candidates = byAlias.get(alias) ?? new Set<string>();
      candidates.add(entry.slug);
      byAlias.set(alias, candidates);
    }
  }
  return [...byAlias.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([originalText, candidates]) => ({
      kind: 'ambiguous_entity' as const,
      originalText,
      candidateEntityIds: [...candidates].sort(),
    }));
}

export function parseQuery(input: {
  readonly question: string;
  readonly timeRange?: { readonly from?: string; readonly to?: string };
  readonly timezone?: string;
  readonly language?: 'ko' | 'en';
  readonly now?: () => Date;
}): ParsedQuery {
  const nowFn = input.now ?? (() => new Date());
  const baseRange = resolveTimeRange(input.timeRange, input.timezone, nowFn);
  const durationMs = input.timeRange ? undefined : naturalLanguageDurationMs(input.question);
  const timeRange = durationMs
    ? {
        from: new Date(new Date(baseRange.to).getTime() - durationMs).toISOString(),
        to: baseRange.to,
        timezone: baseRange.timezone,
      }
    : baseRange;
  const classifications = classifyTopics({ text: input.question });
  const entityIds = new Set(classifications.map(({ slug }) => slug));

  return {
    intent: detectIntent(input.question),
    latestOnly: asksForLatestRelease(input.question),
    repositoryTarget: extractRepositoryTarget(input.question),
    entities: classifications.map((classification) => ({
      id: classification.slug,
      displayName: classification.displayName,
      originalText: originalAlias(input.question, classification),
      confidence: classification.confidence,
    })),
    timeRange,
    timeRangeSource: input.timeRange ? 'explicit' : durationMs ? 'natural_language' : 'unbounded',
    language: input.language ?? (/\p{Script=Hangul}/u.test(input.question) ? 'ko' : 'en'),
    ambiguities: findAmbiguities(input.question, entityIds),
  };
}
