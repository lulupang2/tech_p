import { Value } from '@sinclair/typebox/value';
import {
  ContractValidationError,
  COVERAGE_ROUTES,
  CoverageReportSchema,
  parseAnswerResponse,
  parseHealthLiveResponse,
  parseHealthReadyResponse,
  parseSourceDetailResponse,
  parseSourceListResponse,
  parseTopicListResponse,
  safeParseErrorEnvelope,
  type AnswerRequest,
  type AnswerResponse,
  type CoverageQuery,
  type CoverageReportResponse,
  type ErrorCode,
  type ErrorEnvelope,
  type HealthLiveResponse,
  type HealthReadyResponse,
  type SourceDetailResponse,
  type SourceKey,
  type SourceListQuery,
  type SourceListResponse,
  type TopicListResponse,
  type TopicSearchQuery,
  type ValidationIssue,
} from '@techpulse/contracts';

export interface ApiClientOptions {
  /**
   * Base URL for the API server (e.g. 'http://localhost:3000' or '' for relative same-origin calls).
   * Defaults to empty string (relative calls).
   */
  readonly baseUrl?: string;
  /**
   * Injectable fetch implementation (useful for tests and SSR).
   * Defaults to global fetch.
   */
  readonly fetch?: typeof fetch;
  /**
   * Default headers included with every request.
   */
  readonly defaultHeaders?: Record<string, string>;
  /**
   * Request timeout in milliseconds.
   */
  readonly timeoutMs?: number;
}

export interface RequestOptions {
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  readonly body?: unknown;
}

export type ApiClientErrorCode =
  ErrorCode | 'INVALID_RESPONSE' | 'NETWORK_ERROR' | 'TIMEOUT' | 'UNAVAILABLE';

export interface ApiClientErrorParams {
  readonly message: string;
  readonly status: number;
  readonly code: ApiClientErrorCode;
  readonly details?: readonly ValidationIssue[];
  readonly retryable?: boolean;
  readonly requestId?: string | undefined;
  readonly envelope?: ErrorEnvelope | undefined;
  readonly cause?: unknown;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiClientErrorCode;
  readonly details: readonly ValidationIssue[];
  readonly retryable: boolean;
  readonly requestId?: string | undefined;
  readonly envelope?: ErrorEnvelope | undefined;

  constructor(params: ApiClientErrorParams) {
    super(params.message);
    this.name = 'ApiClientError';
    this.status = params.status;
    this.code = params.code;
    this.details = params.details ?? [];
    this.retryable = params.retryable ?? (params.status >= 500 && params.status !== 501);
    this.requestId = params.requestId;
    this.envelope = params.envelope;
    if (params.cause !== undefined) {
      this.cause = params.cause;
    }
  }
}

export interface AnswerEndpointStatus {
  readonly available: boolean;
  readonly reason: string;
  readonly blockedTicket?: 'API-003';
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly defaultTimeoutMs: number;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ? options.baseUrl.replace(/\/+$/, '') : '';
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultHeaders = {
      Accept: 'application/json',
      ...options.defaultHeaders,
    };
    this.defaultTimeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * Check process live health.
   * GET /health/live
   */
  async getHealthLive(options?: RequestOptions): Promise<HealthLiveResponse> {
    const url = this.buildUrl('/health/live');
    const json = await this.request(url, options);
    try {
      return parseHealthLiveResponse(json);
    } catch (err) {
      throw this.createContractValidationError(err, 'HealthLiveResponse');
    }
  }

  /**
   * Check system and database readiness.
   * GET /health/ready
   */
  async getHealthReady(options?: RequestOptions): Promise<HealthReadyResponse> {
    const url = this.buildUrl('/health/ready');
    const json = await this.request(url, options);
    try {
      return parseHealthReadyResponse(json);
    } catch (err) {
      throw this.createContractValidationError(err, 'HealthReadyResponse');
    }
  }

  /**
   * List data sources with optional pagination.
   * GET /api/v1/sources
   */
  async listSources(
    query?: SourceListQuery,
    options?: RequestOptions,
  ): Promise<SourceListResponse> {
    const searchParams = new URLSearchParams();
    if (query?.cursor) {
      searchParams.set('cursor', query.cursor);
    }
    if (query?.limit !== undefined) {
      searchParams.set('limit', String(query.limit));
    }

    const path = `/api/v1/sources${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
    const url = this.buildUrl(path);
    const json = await this.request(url, options);
    try {
      return parseSourceListResponse(json);
    } catch (err) {
      throw this.createContractValidationError(err, 'SourceListResponse');
    }
  }

  /**
   * Get single source detail by source key.
   * GET /api/v1/sources/:key
   */
  async getSource(
    key: SourceKey | string,
    options?: RequestOptions,
  ): Promise<SourceDetailResponse> {
    const path = `/api/v1/sources/${encodeURIComponent(key)}`;
    const url = this.buildUrl(path);
    const json = await this.request(url, options);
    try {
      return parseSourceDetailResponse(json);
    } catch (err) {
      throw this.createContractValidationError(err, 'SourceDetailResponse');
    }
  }

  /**
   * Search canonical topics with optional query and pagination.
   * GET /api/v1/topics
   */
  async listTopics(query?: TopicSearchQuery, options?: RequestOptions): Promise<TopicListResponse> {
    const searchParams = new URLSearchParams();
    if (query?.q !== undefined && query.q.trim().length > 0) {
      searchParams.set('q', query.q.trim());
    }
    if (query?.cursor) {
      searchParams.set('cursor', query.cursor);
    }
    if (query?.limit !== undefined) {
      searchParams.set('limit', String(query.limit));
    }

    const path = `/api/v1/topics${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
    const url = this.buildUrl(path);
    const json = await this.request(url, options);
    try {
      return parseTopicListResponse(json);
    } catch (err) {
      throw this.createContractValidationError(err, 'TopicListResponse');
    }
  }

  /**
   * Request natural-language evidence-backed answer.
   * POST /api/v1/answers
   */
  async createAnswer(request: AnswerRequest, options?: RequestOptions): Promise<AnswerResponse> {
    const url = this.buildUrl('/api/v1/answers');
    const json = await this.request(url, {
      timeoutMs: options?.timeoutMs ?? 90_000,
      ...options,
      method: 'POST',
      body: request,
    });
    try {
      return parseAnswerResponse(json);
    } catch (err) {
      throw this.createContractValidationError(err, 'AnswerResponse');
    }
  }

  /**
   * Query corpus data coverage report over a specified time range.
   * GET /api/v1/coverage
   */
  async getCoverage(
    query: CoverageQuery,
    options?: RequestOptions,
  ): Promise<CoverageReportResponse> {
    const searchParams = new URLSearchParams();
    searchParams.set('from', query.from);
    searchParams.set('to', query.to);
    if (query.topicId) {
      searchParams.set('topicId', query.topicId);
    }

    const path = `${COVERAGE_ROUTES.coverage}?${searchParams.toString()}`;
    const url = this.buildUrl(path);
    const json = await this.request(url, options);

    try {
      if (!Value.Check(CoverageReportSchema, json)) {
        const issues: ValidationIssue[] = [...Value.Errors(CoverageReportSchema, json)].map(
          (err) => ({
            path: err.path,
            reason: err.message || 'invalid_coverage_report',
          }),
        );
        throw new ContractValidationError(issues);
      }
      return json as CoverageReportResponse;
    } catch (err) {
      throw this.createContractValidationError(err, 'CoverageReportResponse');
    }
  }
  /**
   * Natural-language Q&A answer endpoint status.
   * Following API-003 integration, the answer endpoint is operational.
   */
  getAnswerEndpointStatus(): AnswerEndpointStatus {
    return {
      available: true,
      reason:
        'Natural-language answer generation is operational via POST /api/v1/answers (API-003).',
    };
  }

  private buildUrl(path: string): string {
    if (!this.baseUrl) {
      return path;
    }
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${cleanPath}`;
  }

  private async request(url: string, options?: RequestOptions): Promise<unknown> {
    const method = options?.method ?? 'GET';
    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...options?.headers,
    };

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    const init: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };

    if (options?.body !== undefined) {
      init.body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ApiClientError({
          status: 0,
          code: 'TIMEOUT',
          message: `Request to '${url}' timed out after ${timeoutMs}ms`,
          retryable: true,
          cause: err,
        });
      }
      throw new ApiClientError({
        status: 0,
        code: 'NETWORK_ERROR',
        message: `Network error while fetching '${url}': ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    const requestIdHeader = response.headers.get('x-request-id') ?? undefined;

    if (!response.ok) {
      let rawJson: unknown = null;
      try {
        rawJson = await response.json();
      } catch {
        rawJson = null;
      }

      if (rawJson && typeof rawJson === 'object') {
        const errorParse = safeParseErrorEnvelope(rawJson);
        if (errorParse.success) {
          const envelope = errorParse.data;
          throw new ApiClientError({
            status: response.status,
            code: envelope.error.code,
            message: envelope.error.message,
            details: envelope.error.details,
            retryable: envelope.error.retryable,
            requestId: envelope.requestId,
            envelope,
          });
        }
      }

      const defaultCode: ApiClientErrorCode =
        response.status === 404
          ? 'NOT_FOUND'
          : response.status === 400
            ? 'INVALID_REQUEST'
            : response.status === 503
              ? 'DEPENDENCY_UNAVAILABLE'
              : 'INTERNAL_SERVER_ERROR';

      throw new ApiClientError({
        status: response.status,
        code: defaultCode,
        message: `HTTP ${response.status} ${response.statusText || 'Request failed'}`,
        retryable: response.status >= 500,
        requestId: requestIdHeader,
      });
    }

    try {
      return await response.json();
    } catch (err) {
      throw new ApiClientError({
        status: response.status,
        code: 'INVALID_RESPONSE',
        message: `Failed to parse response body as JSON: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
        requestId: requestIdHeader,
        cause: err,
      });
    }
  }

  private createContractValidationError(err: unknown, schemaName: string): ApiClientError {
    const message = err instanceof Error ? err.message : String(err);
    const details = err instanceof ContractValidationError ? err.issues : [];

    return new ApiClientError({
      status: 200,
      code: 'INVALID_RESPONSE',
      message: `API response violates contract for ${schemaName}: ${message}`,
      details,
      retryable: false,
    });
  }
}

export function createApiClient(options?: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}
