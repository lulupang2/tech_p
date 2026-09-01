import { type TSchema } from '@sinclair/typebox';
import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';

import {
  AnswerRequestSchema,
  AnswerResponseSchema,
  CollectionJobPayloadSchema,
  ReplayJobPayloadSchema,
  ErrorEnvelopeSchema,
  type AnswerRequest,
  type AnswerResponse,
  type CollectionJobPayload,
  type ReplayJobPayload,
  type ErrorEnvelope,
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

type CompiledSchema = TypeCheck<TSchema>;

const answerRequestValidator = TypeCompiler.Compile(AnswerRequestSchema);
const answerResponseValidator = TypeCompiler.Compile(AnswerResponseSchema);
const collectionJobPayloadValidator = TypeCompiler.Compile(CollectionJobPayloadSchema);
const replayJobPayloadValidator = TypeCompiler.Compile(ReplayJobPayloadSchema);
const errorEnvelopeValidator = TypeCompiler.Compile(ErrorEnvelopeSchema);

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

function parseSchema<T>(validator: CompiledSchema, value: unknown): T {
  if (!validator.Check(value)) {
    throw new ContractValidationError(issuesFromErrors([...validator.Errors(value)]));
  }

  return value as T;
}

function safeParseSchema<T>(validator: CompiledSchema, value: unknown): SafeParseResult<T> {
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

export function parseCollectionJobPayload(value: unknown): CollectionJobPayload {
  return parseSchema<CollectionJobPayload>(collectionJobPayloadValidator, value);
}

export function safeParseCollectionJobPayload(
  value: unknown,
): SafeParseResult<CollectionJobPayload> {
  return safeParseSchema<CollectionJobPayload>(collectionJobPayloadValidator, value);
}

export function parseReplayJobPayload(value: unknown): ReplayJobPayload {
  return parseSchema<ReplayJobPayload>(replayJobPayloadValidator, value);
}

export function safeParseReplayJobPayload(value: unknown): SafeParseResult<ReplayJobPayload> {
  return safeParseSchema<ReplayJobPayload>(replayJobPayloadValidator, value);
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
