import { getSchemaValidator, type TSchema } from 'elysia';

import {
  AnswerRequestSchema,
  AnswerResponseSchema,
  CollectionJobPayloadSchema,
  ErrorEnvelopeSchema,
  type AnswerRequest,
  type AnswerResponse,
  type CollectionJobPayload,
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

function parseSchema<T>(schema: TSchema, value: unknown): T {
  const validator = getSchemaValidator(schema, { normalize: false });
  if (!validator) {
    throw new Error('Unable to create contract validator');
  }

  const result = validator.safeParse(value);
  if (!result.success) {
    throw new ContractValidationError(issuesFromErrors(result.errors));
  }

  return result.data as T;
}

function safeParseSchema<T>(schema: TSchema, value: unknown): SafeParseResult<T> {
  try {
    return { success: true, data: parseSchema<T>(schema, value) };
  } catch (error) {
    if (error instanceof ContractValidationError) {
      return { success: false, error };
    }
    throw error;
  }
}

export function parseAnswerRequest(value: unknown): AnswerRequest {
  return parseSchema<AnswerRequest>(AnswerRequestSchema, value);
}

export function safeParseAnswerRequest(value: unknown): SafeParseResult<AnswerRequest> {
  return safeParseSchema<AnswerRequest>(AnswerRequestSchema, value);
}

export function sanitizeAnswerResponse(value: unknown): AnswerResponse {
  const validator = getSchemaValidator(AnswerResponseSchema, { normalize: 'typebox' });
  if (!validator?.Clean) {
    throw new Error('Unable to create response sanitizer');
  }

  let cleaned: unknown;
  try {
    cleaned = validator.Clean(value);
  } catch {
    throw new ContractValidationError([{ path: '', reason: 'invalid_value' }]);
  }

  return parseSchema<AnswerResponse>(AnswerResponseSchema, cleaned);
}

export function parseAnswerResponse(value: unknown): AnswerResponse {
  return parseSchema<AnswerResponse>(AnswerResponseSchema, value);
}

export function safeParseAnswerResponse(value: unknown): SafeParseResult<AnswerResponse> {
  return safeParseSchema<AnswerResponse>(AnswerResponseSchema, value);
}

export function parseErrorEnvelope(value: unknown): ErrorEnvelope {
  return parseSchema<ErrorEnvelope>(ErrorEnvelopeSchema, value);
}

export function safeParseErrorEnvelope(value: unknown): SafeParseResult<ErrorEnvelope> {
  return safeParseSchema<ErrorEnvelope>(ErrorEnvelopeSchema, value);
}

export function parseCollectionJobPayload(value: unknown): CollectionJobPayload {
  return parseSchema<CollectionJobPayload>(CollectionJobPayloadSchema, value);
}

export function safeParseCollectionJobPayload(
  value: unknown,
): SafeParseResult<CollectionJobPayload> {
  return safeParseSchema<CollectionJobPayload>(CollectionJobPayloadSchema, value);
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
