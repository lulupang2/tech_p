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

  if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, unknown>;
    if (
      errObj['name'] === 'ContractValidationError' ||
      (Array.isArray(errObj['issues']) && errObj['issues'].length > 0)
    ) {
      const issues = (errObj['issues'] as ValidationIssue[]) || [];
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
    if (errObj['name'] === 'CollectionStateError') {
      const code = String(errObj['code'] || '');
      if (code === 'not_found') {
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
      if (code === 'policy_blocked') {
        return {
          status: 422,
          envelope: createErrorEnvelope(
            requestId,
            'FORBIDDEN',
            'Operation blocked by policy',
            [],
            false,
          ),
        };
      }
      if (code === 'stale_lease') {
        return {
          status: 409,
          envelope: createErrorEnvelope(
            requestId,
            'IDEMPOTENCY_CONFLICT',
            'Operation failed due to stale lease or conflict',
            [],
            false,
          ),
        };
      }
      return {
        status: 400,
        envelope: createErrorEnvelope(
          requestId,
          'INVALID_REQUEST',
          typeof errObj['message'] === 'string'
            ? errObj['message']
            : 'Invalid collection state request',
          [{ path: '', reason: code || 'invalid_state' }],
          false,
        ),
      };
    }
    if (errObj['name'] === 'InvalidTimeRangeError' || errObj['code'] === 'INVALID_TIME_RANGE') {
      return {
        status: 400,
        envelope: createErrorEnvelope(
          requestId,
          'INVALID_TIME_RANGE',
          typeof errObj['message'] === 'string'
            ? errObj['message']
            : 'timeRange.to must be after timeRange.from',
          [{ path: 'timeRange.to', reason: 'must_be_after_from' }],
          false,
        ),
      };
    }
    if (errObj['name'] === 'ModelProviderError' || errObj['code'] === 'MODEL_PROVIDER_ERROR') {
      return {
        status: 502,
        envelope: createErrorEnvelope(
          requestId,
          'MODEL_PROVIDER_ERROR',
          'Upstream AI model provider error',
          [],
          true,
        ),
      };
    }
    if (errObj['name'] === 'AnswerTimeoutError' || errObj['code'] === 'ANSWER_TIMEOUT') {
      return {
        status: 504,
        envelope: createErrorEnvelope(
          requestId,
          'ANSWER_TIMEOUT',
          'Answer generation deadline exceeded',
          [],
          true,
        ),
      };
    }
    if (
      errObj['name'] === 'DatabaseRetrievalError' ||
      errObj['code'] === 'DATABASE_RETRIEVAL_ERROR'
    ) {
      return {
        status: 503,
        envelope: createErrorEnvelope(
          requestId,
          'DEPENDENCY_UNAVAILABLE',
          'Database retrieval service is unavailable',
          [],
          true,
        ),
      };
    }
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
