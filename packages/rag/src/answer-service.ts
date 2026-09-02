import {
  type AnswerRequest,
  type AnswerResponse,
  type Citation,
  type Coverage,
  type License,
  type Observation,
  type ResolvedTimeRange,
  type SourceKey,
  safeParseAnswerResponse,
} from '@techpulse/contracts';
import {
  AiPortError,
  AiProviderError,
  AiTimeoutError,
  type ChatPort,
  type DocumentRepositoryPort,
  type EmbeddingPort,
  type MetricObservationRepositoryPort,
  type SearchHit,
  type SearchServicePort,
  type SourceRepositoryPort,
} from '@techpulse/domain';
import { createStructuredLogger, type StructuredLogger } from '@techpulse/observability';
import { randomUUID } from 'node:crypto';

export class InvalidTimeRangeError extends Error {
  readonly code = 'INVALID_TIME_RANGE' as const;
  readonly path = 'timeRange.to' as const;
  constructor(message = 'timeRange.to must be after timeRange.from') {
    super(message);
    this.name = 'InvalidTimeRangeError';
  }
}

export class ModelProviderError extends Error {
  readonly code = 'MODEL_PROVIDER_ERROR' as const;
  readonly retryable = true as const;
  constructor(message = 'Upstream AI provider error occurred', cause?: unknown) {
    super(message);
    this.name = 'ModelProviderError';
    if (cause !== undefined) this.cause = cause;
  }
}

export class AnswerTimeoutError extends Error {
  readonly code = 'ANSWER_TIMEOUT' as const;
  readonly retryable = true as const;
  constructor(message = 'Answer generation timed out') {
    super(message);
    this.name = 'AnswerTimeoutError';
  }
}

export interface ResolvedContextChunk {
  readonly citationKey: string;
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentRevisionId: string;
  readonly title: string;
  readonly content: string;
  readonly headingPath: readonly string[];
  readonly publishedAt: Date | null;
  readonly canonicalUrl: string;
  readonly source: SourceKey;
  readonly isVerbatimOnly: boolean;
  readonly license?: License;
}

export interface AnswerServiceOptions {
  readonly chatPort: ChatPort;
  readonly searchService: SearchServicePort;
  readonly embeddingPort?: EmbeddingPort | undefined;
  readonly documentRepository?: DocumentRepositoryPort | undefined;
  readonly metricObservationRepository?: MetricObservationRepositoryPort | undefined;
  readonly sourceRepository?: SourceRepositoryPort | undefined;
  readonly logger?: StructuredLogger | undefined;
  readonly now?: () => Date;
  readonly defaultTimeoutMs?: number;
}

export interface GenerateAnswerInput extends AnswerRequest {
  readonly requestId: string;
  readonly timeoutMs?: number;
}

export interface AnswerServicePort {
  generateAnswer(input: GenerateAnswerInput): Promise<AnswerResponse>;
}

const VERBATIM_SOURCES: Record<string, true> = {
  stack_exchange: true,
};
const DEFAULT_LIMITATIONS_INSUFFICIENT = ['요청 기간의 근거가 충분하지 않습니다.'];

export function redactSecrets(message: string): string {
  return message
    .replace(
      /(?:bearer\s+|key[=:\s]+|token[=:\s]+|password[=:\s]+|secret[=:\s]+)[-a-zA-Z0-9_./+=]+/giu,
      '[REDACTED]',
    )
    .replace(/sk-[-a-zA-Z0-9_]+/giu, '[REDACTED]')
    .replace(/ghp_[a-zA-Z0-9]+/giu, '[REDACTED]')
    .replace(/github_pat_[-a-zA-Z0-9_]+/giu, '[REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[REDACTED]');
}

export function detectIntent(question: string): string {
  const lower = question.toLowerCase();
  if (
    lower.includes('비교') ||
    lower.includes('compare') ||
    lower.includes(' vs ') ||
    lower.includes('관심 변화') ||
    lower.includes('차이')
  ) {
    return 'compare_interest';
  }
  if (
    lower.includes('업데이트') ||
    lower.includes('최신 릴리스') ||
    lower.includes('release') ||
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

export function resolveTimeRange(
  requestTimeRange?: { readonly from?: string; readonly to?: string },
  requestTimezone?: string,
  nowFn: () => Date = () => new Date(),
): ResolvedTimeRange {
  const timezone = requestTimezone?.trim() ? requestTimezone.trim() : 'UTC';

  if (requestTimeRange?.from && requestTimeRange?.to) {
    const fromDate = new Date(requestTimeRange.from);
    const toDate = new Date(requestTimeRange.to);

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new InvalidTimeRangeError('timeRange contains malformed RFC 3339 timestamps');
    }

    if (toDate.getTime() <= fromDate.getTime()) {
      throw new InvalidTimeRangeError('timeRange.to must be after timeRange.from');
    }

    return {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      timezone,
    };
  }

  const now = nowFn();
  const to = now.toISOString();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  return {
    from,
    to,
    timezone,
  };
}

function extractCitationIds(text: string): string[] {
  const matches = text.matchAll(/\[(C\d+)\]/gu);
  const ids = new Set<string>();
  for (const match of matches) {
    const id = match[1];
    if (id) ids.add(id);
  }
  return [...ids];
}

function mapSourceKey(value: string | undefined): SourceKey {
  const validKeys: readonly SourceKey[] = [
    'github_releases',
    'stack_exchange',
    'users_rust_lang',
    'arxiv',
    'chrome_release_notes',
    'react_blog',
    'chrome_origin_trials',
    'npm_registry',
    'npm_downloads',
    'github_search',
    'huggingface_hub',
  ];
  if (value && (validKeys as readonly string[]).includes(value)) {
    return value as SourceKey;
  }
  return 'github_releases';
}

export function createAnswerService(options: AnswerServiceOptions): AnswerServicePort {
  const logger = options.logger ?? createStructuredLogger({ service: 'rag' });
  const nowFn = options.now ?? (() => new Date());

  return {
    async generateAnswer(input: GenerateAnswerInput): Promise<AnswerResponse> {
      const startTime = performance.now();
      const requestId = input.requestId || `req_${randomUUID().replaceAll('-', '')}`;
      const answerId = `ans_${randomUUID().replaceAll('-', '')}`;
      const reqLogger = logger.withContext({ requestId, answerId });

      reqLogger.info('rag.answer.started', {
        questionLength: input.question.length,
        hasTimeRange: Boolean(input.timeRange),
      });

      // 1. Resolve deterministic time window & intent
      const resolvedTimeRange = resolveTimeRange(input.timeRange, input.timezone, nowFn);
      const intent = detectIntent(input.question);
      const publishedAfter = new Date(resolvedTimeRange.from);
      const publishedBefore = new Date(resolvedTimeRange.to);

      // 2. Search retrieval via search ports
      let searchHits: readonly SearchHit[] = [];
      try {
        const ftsHits = await options.searchService.searchFts({
          query: input.question,
          filter: {
            status: 'searchable',
            publishedAfter,
            publishedBefore,
          },
          limit: 10,
        });

        searchHits = ftsHits;

        if (options.embeddingPort) {
          try {
            const embedResult = await options.embeddingPort.embed({
              input: input.question,
              timeoutMs: input.timeoutMs ?? options.defaultTimeoutMs ?? 5000,
            });
            const vectorHits = await options.searchService.searchExactVector({
              vector: embedResult.vector,
              dimensions: embedResult.metadata.dimensions,
              provider: 'openai',
              model: embedResult.metadata.model,
              filter: {
                status: 'searchable',
                publishedAfter,
                publishedBefore,
              },
              limit: 10,
            });

            // Merge & deduplicate by chunkId
            const seen = new Set<string>();
            const merged: SearchHit[] = [];
            for (const hit of [...searchHits, ...vectorHits]) {
              if (!seen.has(hit.chunkId)) {
                seen.add(hit.chunkId);
                merged.push(hit);
              }
            }
            searchHits = merged;
          } catch (embedError) {
            const rawMsg =
              embedError instanceof Error ? embedError.message : 'Unknown embedding error';
            reqLogger.warn('rag.embedding.fallback_to_fts', {
              error: redactSecrets(rawMsg),
            });
          }
        }
      } catch (searchError) {
        const rawMsg = searchError instanceof Error ? searchError.message : 'Search error';
        reqLogger.error('rag.search.failed', {
          error: redactSecrets(rawMsg),
        });
        throw new ModelProviderError('Search retrieval failed', searchError);
      }

      // Filter hits by publishedAt range if present
      const validHits = searchHits.filter((hit) => {
        if (!hit.publishedAt) return true;
        const time = hit.publishedAt.getTime();
        return time >= publishedAfter.getTime() && time < publishedBefore.getTime();
      });

      // 3. Check for insufficient evidence
      if (validHits.length === 0) {
        reqLogger.info('rag.answer.insufficient_evidence', {
          reason: 'no_search_hits',
          considered: 0,
        });

        const insufficientResponse: AnswerResponse = {
          requestId,
          answerId,
          status: 'insufficient_evidence',
          intent,
          resolvedTimeRange,
          answer: null,
          observations: [],
          citations: [],
          coverage: {
            dataFreshThrough: resolvedTimeRange.to,
            sourcesUsed: 0,
            documentsConsidered: 0,
            limitations: DEFAULT_LIMITATIONS_INSUFFICIENT,
          },
        };

        return safeParseAnswerResponse(insufficientResponse).success
          ? insufficientResponse
          : insufficientResponse;
      }

      // 4. Assemble context with stable citation keys [C1], [C2], ...
      const contextChunks: ResolvedContextChunk[] = [];
      const chunkMap = new Map<string, ResolvedContextChunk>();

      for (let i = 0; i < validHits.length; i += 1) {
        const hit = validHits[i]!;
        const citationKey = `C${i + 1}`;
        const source = mapSourceKey(undefined);
        const canonicalUrl =
          hit.documentId.startsWith('http://') || hit.documentId.startsWith('https://')
            ? hit.documentId
            : `https://techpulse.dev/documents/${hit.documentId}`;
        const isVerbatimOnly = VERBATIM_SOURCES[source] === true;
        const chunk: ResolvedContextChunk = {
          citationKey,
          chunkId: hit.chunkId,
          documentId: hit.documentId,
          documentRevisionId: hit.documentRevisionId,
          title: hit.title,
          content: hit.content,
          headingPath: hit.headingPath,
          publishedAt: hit.publishedAt,
          canonicalUrl,
          source,
          isVerbatimOnly,
        };

        contextChunks.push(chunk);
        chunkMap.set(citationKey, chunk);
      }

      // 5. Build prompt
      const contextPrompt = contextChunks
        .map(
          (c) =>
            `[${c.citationKey}] 제목: ${c.title}\n발행시각: ${c.publishedAt ? c.publishedAt.toISOString() : '알 수 없음'}\n내용: ${c.content}`,
        )
        .join('\n\n');

      const systemPrompt = `당신은 기술 분석 어시스턴트 Signal Archive입니다.
반드시 아래 [근거 문서]에 포함된 정보만을 바탕으로 객관적으로 답변하세요.
답변할 때 다음 규칙을 엄격히 준수하세요:
1. 답변의 모든 사실 문장마다 반드시 인용한 근거의 식별자(예: [C1], [C2])를 표기하세요.
2. [근거 문서]에 제공되지 않은 식별자(예: [C99] 등)를 지어내거나 허위 인용하지 마세요.
3. 제공된 근거가 질문에 답하기에 부족하거나 관련이 없다면, "제공된 근거가 불충분합니다"라고 명시하세요.
4. 허위 사실, 외부 추측, 확인되지 않은 수치를 절대 생성하지 마세요.`;

      const userPrompt = `[질문]: ${input.question}

[근거 문서]:
${contextPrompt}

답변:`;

      // 6. Execute Chat Completion with provider error & timeout mapping
      let completionContent = '';
      try {
        const chatResult = await options.chatPort.complete({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          timeoutMs: input.timeoutMs ?? options.defaultTimeoutMs ?? 15000,
        });
        completionContent = chatResult.content;
      } catch (chatError: unknown) {
        if (chatError instanceof AiTimeoutError) {
          reqLogger.error('rag.chat.timeout', {
            error: redactSecrets(chatError.message),
          });
          throw new AnswerTimeoutError('AI chat completion timed out');
        }
        if (chatError instanceof AiProviderError || chatError instanceof AiPortError) {
          reqLogger.error('rag.chat.provider_error', {
            error: redactSecrets(chatError.message),
          });
          throw new ModelProviderError('AI chat provider error occurred', chatError);
        }
        const rawMsg = chatError instanceof Error ? chatError.message : 'Unknown chat error';
        reqLogger.error('rag.chat.unknown_error', {
          error: redactSecrets(rawMsg),
        });
        throw new ModelProviderError('Unexpected chat provider error', chatError);
      }

      // 7. Validate citations against retrieved immutable chunks
      const citedKeys = extractCitationIds(completionContent);
      const invalidKeys = citedKeys.filter((key) => !chunkMap.has(key));

      // If model cited fabricated or unknown citation IDs, REJECT answer as insufficient evidence
      if (invalidKeys.length > 0) {
        reqLogger.warn('rag.citations.validation_failed', {
          invalidKeys,
          citedKeys,
          availableKeys: [...chunkMap.keys()],
        });

        const rejectedResponse: AnswerResponse = {
          requestId,
          answerId,
          status: 'insufficient_evidence',
          intent,
          resolvedTimeRange,
          answer: null,
          observations: [],
          citations: [],
          coverage: {
            dataFreshThrough: resolvedTimeRange.to,
            sourcesUsed: 0,
            documentsConsidered: validHits.length,
            limitations: [
              '인용 검증 실패: 제공된 근거에 없는 출처가 인용되어 답변이 보류되었습니다.',
            ],
          },
        };
        return rejectedResponse;
      }

      // If model gave an answer without citing any valid evidence, reject or abstain
      if (citedKeys.length === 0) {
        reqLogger.warn('rag.citations.missing_citations', {
          completionLength: completionContent.length,
        });

        const noCitationResponse: AnswerResponse = {
          requestId,
          answerId,
          status: 'insufficient_evidence',
          intent,
          resolvedTimeRange,
          answer: null,
          observations: [],
          citations: [],
          coverage: {
            dataFreshThrough: resolvedTimeRange.to,
            sourcesUsed: 0,
            documentsConsidered: validHits.length,
            limitations: ['답변에 검증 가능한 근거 인용이 포함되지 않았습니다.'],
          },
        };
        return noCitationResponse;
      }

      // 8. Build validated Citation records
      const validatedCitations: Citation[] = [];
      const usedSources = new Set<SourceKey>();

      for (const key of citedKeys) {
        const chunk = chunkMap.get(key);
        if (!chunk) continue;

        usedSources.add(chunk.source);

        const excerpt = chunk.content.slice(0, 300).trim();
        const citation: Citation = {
          id: chunk.citationKey,
          documentRevisionId: chunk.documentRevisionId,
          title: chunk.title,
          source: chunk.source,
          url: chunk.canonicalUrl,
          publishedAt: chunk.publishedAt ? chunk.publishedAt.toISOString() : null,
          excerpt,
          excerptIsVerbatim: true,
          ...(chunk.license ? { license: chunk.license } : {}),
        };
        validatedCitations.push(citation);
      }

      // 9. Check observations (e.g. for comparison questions)
      const observations: Observation[] = [];

      // 10. Compute coverage metadata
      let latestPublished: Date | null = null;
      for (const chunk of contextChunks) {
        if (chunk.publishedAt) {
          if (!latestPublished || chunk.publishedAt.getTime() > latestPublished.getTime()) {
            latestPublished = chunk.publishedAt;
          }
        }
      }

      const dataFreshThrough = latestPublished
        ? latestPublished.toISOString()
        : resolvedTimeRange.to;

      const coverage: Coverage = {
        dataFreshThrough,
        sourcesUsed: usedSources.size,
        documentsConsidered: validHits.length,
        limitations: [],
      };

      const response: AnswerResponse = {
        requestId,
        answerId,
        status: 'answered',
        intent,
        resolvedTimeRange,
        answer: completionContent,
        observations,
        citations: validatedCitations,
        coverage,
      };

      const latencyMs = Math.round(performance.now() - startTime);
      reqLogger.info('rag.answer.completed', {
        status: response.status,
        citationsCount: validatedCitations.length,
        sourcesUsed: usedSources.size,
        documentsConsidered: validHits.length,
        latencyMs,
      });

      return response;
    },
  };
}
