import { type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  AnswerRequestSchema,
  AnswerResponseSchema,
  ErrorEnvelopeSchema,
  HealthLiveResponseSchema,
  HealthReadyResponseSchema,
  SourceSummarySchema,
  SourceListResponseSchema,
  SourceDetailResponseSchema,
  TopicSummarySchema,
  TopicListResponseSchema,
  TopicSearchQuerySchema,
  SourceListQuerySchema,
  type AnswerRequest,
  type AnswerResponse,
  type ErrorEnvelope,
  type HealthLiveResponse,
  type HealthReadyResponse,
  type SourceSummary,
  type SourceListResponse,
  type SourceDetailResponse,
  type TopicSummary,
  type TopicListResponse,
  type TopicSearchQuery,
  type SourceListQuery,
  type ValidationIssue,
} from './schemas.js';

export type ValidationSuccess<T> = {
  readonly success: true;
  readonly data: T;
};

export type ValidationFailure = {
  readonly success: false;
  readonly error: ContractValidationError;
};

export type SafeParseResult<T> = ValidationSuccess<T> | ValidationFailure;

export class ContractValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super('Contract validation failed');
    this.name = 'ContractValidationError';
    this.issues = issues;
  }
}

type SchemaValidationError = {
  readonly path?: string;
  readonly type?: unknown;
};

type SchemaValidator = TSchema;

const answerRequestValidator = AnswerRequestSchema;
const answerResponseValidator = AnswerResponseSchema;
const errorEnvelopeValidator = ErrorEnvelopeSchema;
const healthLiveResponseValidator = HealthLiveResponseSchema;
const healthReadyResponseValidator = HealthReadyResponseSchema;
const sourceSummaryValidator = SourceSummarySchema;
const sourceListResponseValidator = SourceListResponseSchema;
const sourceDetailResponseValidator = SourceDetailResponseSchema;
const topicSummaryValidator = TopicSummarySchema;
const topicListResponseValidator = TopicListResponseSchema;
const topicSearchQueryValidator = TopicSearchQuerySchema;
const sourceListQueryValidator = SourceListQuerySchema;

function pathFromPointer(pointer: string | undefined): string {
  if (!pointer) return '';

  return pointer
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .join('.');
}

function reasonFromError(error: SchemaValidationError): string {
  if (error.type === 'Object') return 'unknown_field_or_invalid_object';
  if (typeof error.type === 'string' && error.type.length > 0) {
    return error.type.toLowerCase();
  }
  return 'invalid_value';
}

function issuesFromErrors(
  errors: readonly (SchemaValidationError | undefined)[],
): ValidationIssue[] {
  return errors
    .filter((error): error is SchemaValidationError => Boolean(error))
    .map((error) => ({
      path: pathFromPointer(error.path),
      reason: reasonFromError(error),
    }));
}

function parseSchema<T>(validator: SchemaValidator, value: unknown): T {
  if (!Value.Check(validator, value)) {
    throw new ContractValidationError(issuesFromErrors([...Value.Errors(validator, value)]));
  }

  return value as T;
}

function safeParseSchema<T>(validator: SchemaValidator, value: unknown): SafeParseResult<T> {
  try {
    return { success: true, data: parseSchema<T>(validator, value) };
  } catch (error) {
    if (error instanceof ContractValidationError) {
      return { success: false, error };
    }
    throw error;
  }
}

export function parseAnswerRequest(value: unknown): AnswerRequest {
  return parseSchema<AnswerRequest>(answerRequestValidator, value);
}

export function safeParseAnswerRequest(value: unknown): SafeParseResult<AnswerRequest> {
  return safeParseSchema<AnswerRequest>(answerRequestValidator, value);
}

export function sanitizeAnswerResponse(value: unknown): AnswerResponse {
  let cleaned: unknown;
  try {
    cleaned = Value.Clean(AnswerResponseSchema, value);
  } catch {
    throw new ContractValidationError([{ path: '', reason: 'invalid_value' }]);
  }

  return parseSchema<AnswerResponse>(answerResponseValidator, cleaned);
}

export function parseAnswerResponse(value: unknown): AnswerResponse {
  return parseSchema<AnswerResponse>(answerResponseValidator, value);
}

export function safeParseAnswerResponse(value: unknown): SafeParseResult<AnswerResponse> {
  return safeParseSchema<AnswerResponse>(answerResponseValidator, value);
}

export function parseErrorEnvelope(value: unknown): ErrorEnvelope {
  return parseSchema<ErrorEnvelope>(errorEnvelopeValidator, value);
}

export function safeParseErrorEnvelope(value: unknown): SafeParseResult<ErrorEnvelope> {
  return safeParseSchema<ErrorEnvelope>(errorEnvelopeValidator, value);
}

export function parseHealthLiveResponse(value: unknown): HealthLiveResponse {
  return parseSchema<HealthLiveResponse>(healthLiveResponseValidator, value);
}

export function safeParseHealthLiveResponse(value: unknown): SafeParseResult<HealthLiveResponse> {
  return safeParseSchema<HealthLiveResponse>(healthLiveResponseValidator, value);
}

export function parseHealthReadyResponse(value: unknown): HealthReadyResponse {
  return parseSchema<HealthReadyResponse>(healthReadyResponseValidator, value);
}

export function safeParseHealthReadyResponse(value: unknown): SafeParseResult<HealthReadyResponse> {
  return safeParseSchema<HealthReadyResponse>(healthReadyResponseValidator, value);
}

export function sanitizeSourceSummary(value: unknown): SourceSummary {
  let cleaned: unknown;
  try {
    cleaned = Value.Clean(SourceSummarySchema, value);
  } catch {
    throw new ContractValidationError([{ path: '', reason: 'invalid_value' }]);
  }
  return parseSchema<SourceSummary>(sourceSummaryValidator, cleaned);
}

export function parseSourceSummary(value: unknown): SourceSummary {
  return parseSchema<SourceSummary>(sourceSummaryValidator, value);
}

export function safeParseSourceSummary(value: unknown): SafeParseResult<SourceSummary> {
  return safeParseSchema<SourceSummary>(sourceSummaryValidator, value);
}

export function sanitizeSourceListResponse(value: unknown): SourceListResponse {
  let cleaned: unknown;
  try {
    cleaned = Value.Clean(SourceListResponseSchema, value);
  } catch {
    throw new ContractValidationError([{ path: '', reason: 'invalid_value' }]);
  }
  return parseSchema<SourceListResponse>(sourceListResponseValidator, cleaned);
}

export function parseSourceListResponse(value: unknown): SourceListResponse {
  return parseSchema<SourceListResponse>(sourceListResponseValidator, value);
}

export function safeParseSourceListResponse(value: unknown): SafeParseResult<SourceListResponse> {
  return safeParseSchema<SourceListResponse>(sourceListResponseValidator, value);
}

export function sanitizeSourceDetailResponse(value: unknown): SourceDetailResponse {
  let cleaned: unknown;
  try {
    cleaned = Value.Clean(SourceDetailResponseSchema, value);
  } catch {
    throw new ContractValidationError([{ path: '', reason: 'invalid_value' }]);
  }
  return parseSchema<SourceDetailResponse>(sourceDetailResponseValidator, cleaned);
}

export function parseSourceDetailResponse(value: unknown): SourceDetailResponse {
  return parseSchema<SourceDetailResponse>(sourceDetailResponseValidator, value);
}

export function safeParseSourceDetailResponse(
  value: unknown,
): SafeParseResult<SourceDetailResponse> {
  return safeParseSchema<SourceDetailResponse>(sourceDetailResponseValidator, value);
}

export function sanitizeTopicSummary(value: unknown): TopicSummary {
  let cleaned: unknown;
  try {
    cleaned = Value.Clean(TopicSummarySchema, value);
  } catch {
    throw new ContractValidationError([{ path: '', reason: 'invalid_value' }]);
  }
  return parseSchema<TopicSummary>(topicSummaryValidator, cleaned);
}

export function parseTopicSummary(value: unknown): TopicSummary {
  return parseSchema<TopicSummary>(topicSummaryValidator, value);
}

export function safeParseTopicSummary(value: unknown): SafeParseResult<TopicSummary> {
  return safeParseSchema<TopicSummary>(topicSummaryValidator, value);
}

export function sanitizeTopicListResponse(value: unknown): TopicListResponse {
  let cleaned: unknown;
  try {
    cleaned = Value.Clean(TopicListResponseSchema, value);
  } catch {
    throw new ContractValidationError([{ path: '', reason: 'invalid_value' }]);
  }
  return parseSchema<TopicListResponse>(topicListResponseValidator, cleaned);
}

export function parseTopicListResponse(value: unknown): TopicListResponse {
  return parseSchema<TopicListResponse>(topicListResponseValidator, value);
}

export function safeParseTopicListResponse(value: unknown): SafeParseResult<TopicListResponse> {
  return safeParseSchema<TopicListResponse>(topicListResponseValidator, value);
}

export function parseTopicSearchQuery(value: unknown): TopicSearchQuery {
  return parseSchema<TopicSearchQuery>(topicSearchQueryValidator, value);
}

export function safeParseTopicSearchQuery(value: unknown): SafeParseResult<TopicSearchQuery> {
  return safeParseSchema<TopicSearchQuery>(topicSearchQueryValidator, value);
}

export function parseSourceListQuery(value: unknown): SourceListQuery {
  return parseSchema<SourceListQuery>(sourceListQueryValidator, value);
}

export function safeParseSourceListQuery(value: unknown): SafeParseResult<SourceListQuery> {
  return safeParseSchema<SourceListQuery>(sourceListQueryValidator, value);
}

export type BadRequestValidationResponse = {
  readonly status: 400;
  readonly body: ErrorEnvelope;
};

/** Convert a validation failure to the stable HTTP 400 error contract. */
export function mapValidationFailureTo400(
  error: unknown,
  requestId: string,
): BadRequestValidationResponse {
  const issues = error instanceof ContractValidationError ? [...error.issues] : [];

  return {
    status: 400,
    body: {
      requestId,
      error: {
        code: 'INVALID_REQUEST',
        message: 'Request validation failed',
        details: issues,
        retryable: false,
      },
    },
  };
}
