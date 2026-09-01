import {
  correlationContextFromHeaders,
  isValidCorrelationId,
  type CorrelationContext,
} from '@techpulse/observability';
import { randomUUID } from 'node:crypto';

export interface RequestCorrelation {
  readonly requestId: string;
  readonly context: CorrelationContext;
}

export function generateRequestId(): string {
  return `req_${randomUUID().replaceAll('-', '')}`;
}

export function resolveRequestCorrelation(request: Request): RequestCorrelation {
  const context = correlationContextFromHeaders(request.headers);
  const requestId =
    context.requestId !== undefined && isValidCorrelationId(context.requestId)
      ? context.requestId
      : generateRequestId();

  return {
    requestId,
    context: {
      ...context,
      requestId,
    },
  };
}
