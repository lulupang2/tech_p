import { Elysia, t } from 'elysia';
import { ApiHttpError } from '../errors.js';

export interface OpsRouteOptions {
  readonly opsApiKey?: string | undefined;
}

export function createOpsRoutes(options: OpsRouteOptions = {}) {
  return new Elysia({ prefix: '/ops' })
    .onBeforeHandle(({ request }) => {
      const authHeader = request.headers.get('authorization');
      if (!authHeader) {
        throw new ApiHttpError({
          code: 'UNAUTHENTICATED',
          status: 401,
          message: 'Authentication required for operations endpoint',
        });
      }

      const expectedToken = options.opsApiKey || process.env['OPS_API_KEY'];
      if (!expectedToken) {
        throw new ApiHttpError({
          code: 'FORBIDDEN',
          status: 403,
          message: 'Operations endpoint is not configured or disabled',
        });
      }

      const match = /^Bearer\s+(.+)$/i.exec(authHeader);
      const token = match ? match[1] : authHeader;

      if (token !== expectedToken) {
        throw new ApiHttpError({
          code: 'FORBIDDEN',
          status: 403,
          message: 'Invalid operations authorization token',
        });
      }
    })
    .get('/status', () => {
      return {
        status: 'ok',
        service: 'api-ops',
        timestamp: new Date().toISOString(),
      };
    })
    .post(
      '/replay',
      ({ body }) => {
        return {
          status: 'accepted',
          jobId: `job_${Date.now()}`,
          sourceKey: body.sourceKey,
        };
      },
      {
        body: t.Object({
          sourceKey: t.String(),
          dryRun: t.Optional(t.Boolean()),
        }),
      },
    );
}
