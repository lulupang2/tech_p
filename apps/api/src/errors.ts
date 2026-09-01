import { type ErrorCode, type ErrorEnvelope, type ValidationIssue } from '@techpulse/contracts';

export interface HttpErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly status: number;
  readonly details?: readonly ValidationIssue[];
  readonly retryable?: boolean;
}

export class ApiHttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: readonly ValidationIssue[];
  readonly retryable: boolean;

  constructor(options: HttpErrorOptions) {
    super(options.message);
    this.name = 'ApiHttpError';
    this.code = options.code;
    this.status = options.status;
    this.details = options.details ?? [];
    this.retryable = options.retryable ?? false;
  }
}

export function createErrorEnvelope(
  requestId: string,
  code: ErrorCode,
  message: string,
  details: readonly ValidationIssue[] = [],
  retryable = false,
): ErrorEnvelope {
  return {
    requestId,
    error: {
      code,
      message,
      details: [...details],
      retryable,
    },
  };
}

export interface SanitizedErrorResult {
  readonly status: number;
  readonly envelope: ErrorEnvelope;
}

type UnknownError = {
  readonly code?: unknown;
  readonly status?: unknown;
  readonly message?: unknown;
  readonly all?: unknown;
  readonly errors?: unknown;
};

function extractValidationIssues(error: unknown): ValidationIssue[] {
  if (typeof error !== 'object' || error === null) return [];

  const candidate = error as UnknownError;
  const rawErrors = Array.isArray(candidate.all)
    ? candidate.all
    : Array.isArray(candidate.errors)
      ? candidate.errors
      : [];

  const issues: ValidationIssue[] = [];
  for (const item of rawErrors) {
    if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>;
      const path =
        typeof record['path'] === 'string'
          ? record['path'].replace(/^\//u, '').replaceAll('/', '.')
          : '';
      const message = typeof record['message'] === 'string' ? record['message'] : 'invalid_value';
      issues.push({ path, reason: message });
    }
  }

  return issues;
}

export function formatErrorToEnvelope(error: unknown, requestId: string): SanitizedErrorResult {
  if (error instanceof ApiHttpError) {
    return {
      status: error.status,
      envelope: createErrorEnvelope(
        requestId,
        error.code,
        error.message,
        error.details,
        error.retryable,
      ),
    };
  }

  const candidate = (typeof error === 'object' && error !== null ? error : {}) as UnknownError;
  const code = typeof candidate.code === 'string' ? candidate.code : '';

  if (code === 'VALIDATION') {
    const issues = extractValidationIssues(error);
    return {
      status: 400,
      envelope: createErrorEnvelope(
        requestId,
        'INVALID_REQUEST',
        'Request validation failed',
        issues,
        false,
      ),
    };
  }

  if (code === 'NOT_FOUND') {
    return {
      status: 404,
      envelope: createErrorEnvelope(
        requestId,
        'NOT_FOUND',
        'The requested resource was not found',
        [],
        false,
      ),
    };
  }

  if (code === 'PARSE') {
    return {
      status: 400,
      envelope: createErrorEnvelope(
        requestId,
        'INVALID_REQUEST',
        'Malformed JSON request body',
        [],
        false,
      ),
    };
  }

  // Any unhandled internal error: strictly sanitized, no stack trace, no SQL, no secret leakage
  return {
    status: 500,
    envelope: createErrorEnvelope(
      requestId,
      'INTERNAL_SERVER_ERROR',
      'An internal server error occurred',
      [],
      false,
    ),
  };
}
