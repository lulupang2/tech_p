import { type HealthLiveResponse, type HealthReadyResponse } from '@techpulse/contracts';
import { Elysia } from 'elysia';

export type DatabaseHealthCheck = () => Promise<boolean>;

export interface HealthRouteOptions {
  readonly checkDatabaseHealth?: DatabaseHealthCheck | undefined;
}

export function createHealthRoutes(options: HealthRouteOptions = {}) {
  return new Elysia()
    .get('/health/live', (): HealthLiveResponse => {
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
      };
    })
    .get('/health/ready', async ({ set }): Promise<HealthReadyResponse> => {
      const check = options.checkDatabaseHealth;
      let isHealthy = false;

      if (check !== undefined) {
        try {
          isHealthy = await check();
        } catch {
          isHealthy = false;
        }
      }

      const timestamp = new Date().toISOString();

      if (isHealthy) {
        set.status = 200;
        return {
          status: 'ok',
          timestamp,
          dependencies: {
            database: 'ok',
          },
        };
      }

      set.status = 503;
      return {
        status: 'unavailable',
        timestamp,
        dependencies: {
          database: 'unavailable',
        },
      };
    });
}
