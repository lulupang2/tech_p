import { parseCoverageQuery, type CoverageReportResponse } from '@techpulse/contracts';
import { type CoveragePort } from '@techpulse/domain';
import { Elysia } from 'elysia';

import { ApiHttpError } from '../errors.js';

export interface CoverageRouteOptions {
  readonly coveragePort?: CoveragePort | undefined;
  readonly now?: (() => Date) | undefined;
}

export function createCoverageRoutes(options: CoverageRouteOptions = {}) {
  return new Elysia().get('/coverage', async ({ query }): Promise<CoverageReportResponse> => {
    if (!options.coveragePort) {
      throw new ApiHttpError({
        code: 'DEPENDENCY_UNAVAILABLE',
        status: 503,
        message: 'Coverage service is currently unavailable or unconfigured',
      });
    }

    const parsedQuery = parseCoverageQuery(query);
    const from = new Date(parsedQuery.from);
    const to = new Date(parsedQuery.to);
    const topicIds = parsedQuery.topicId ? [parsedQuery.topicId] : [];
    const now = options.now ? options.now() : new Date();

    const report = await options.coveragePort.getCoverage({ from, to }, topicIds, now);

    return { ...report, reasons: [...report.reasons] };
  });
}
