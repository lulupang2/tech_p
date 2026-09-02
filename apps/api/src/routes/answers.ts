import { type AnswerResponse } from '@techpulse/contracts';
import { type AnswerServicePort } from '@techpulse/rag';
import { Elysia, t } from 'elysia';

import { type ConcurrencyLimiter, type DailyBudgetTracker } from '../abuse-controls.js';
import { ApiHttpError } from '../errors.js';

export interface AnswerRouteOptions {
  readonly answerService?: AnswerServicePort | undefined;
  readonly concurrencyLimiter?: ConcurrencyLimiter | undefined;
  readonly budgetTracker?: DailyBudgetTracker | undefined;
}
export function createAnswerRoutes(options: AnswerRouteOptions = {}) {
  return new Elysia().post(
    '/answers',
    async ({ body, store, set }): Promise<AnswerResponse> => {
      const requestId =
        ((store as Record<string, unknown>)['requestId'] as string | undefined) ||
        `req_${Date.now()}`;

      if (!options.answerService) {
        throw new ApiHttpError({
          code: 'DEPENDENCY_UNAVAILABLE',
          status: 503,
          message: 'Answer service is currently unavailable or unconfigured',
        });
      }
      const trimmedQuestion = body.question.trim();
      if (trimmedQuestion.length === 0) {
        throw new ApiHttpError({
          code: 'INVALID_REQUEST',
          status: 400,
          message: 'Question must contain non-whitespace characters',
          details: [{ path: 'question', reason: 'must_not_be_empty' }],
        });
      }

      // Check daily provider budget limit
      if (options.budgetTracker && !options.budgetTracker.tryConsume(1)) {
        throw new ApiHttpError({
          code: 'RATE_LIMITED',
          status: 429,
          message: 'Daily AI provider budget limit reached',
          retryable: false,
        });
      }

      // Acquire concurrency slot
      if (options.concurrencyLimiter && !options.concurrencyLimiter.tryAcquire()) {
        throw new ApiHttpError({
          code: 'RATE_LIMITED',
          status: 429,
          message: 'Too many concurrent answer requests. Please retry shortly.',
          retryable: true,
        });
      }

      try {
        const result = await options.answerService.generateAnswer({
          question: trimmedQuestion,
          requestId,
          ...(body.timeRange ? { timeRange: body.timeRange } : {}),
          ...(body.timezone ? { timezone: body.timezone } : {}),
          ...(body.language ? { language: body.language } : {}),
        });

        set.headers['x-request-id'] = requestId;
        return result;
      } finally {
        options.concurrencyLimiter?.release();
      }
    },
    {
      body: t.Object(
        {
          question: t.String({ minLength: 1, maxLength: 2000 }),
          timeRange: t.Optional(
            t.Object(
              {
                from: t.String({ format: 'date-time' }),
                to: t.String({ format: 'date-time' }),
              },
              { additionalProperties: false },
            ),
          ),
          timezone: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
          language: t.Optional(t.Union([t.Literal('ko'), t.Literal('en')])),
        },
        { additionalProperties: false },
      ),
    },
  );
}
