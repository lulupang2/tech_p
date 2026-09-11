import { type HealthLiveResponse, type HealthReadyResponse } from '@techpulse/contracts';
import { Elysia } from 'elysia';

export type DatabaseHealthCheck = () => Promise<boolean>;
export type DependencyHealthCheck = () => Promise<boolean>;

export interface HealthRouteOptions {
  readonly checkDatabaseHealth?: DependencyHealthCheck | undefined;
  readonly checkRedisHealth?: DependencyHealthCheck | undefined;
  readonly checkWorkerHealth?: DependencyHealthCheck | undefined;
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
      const checkDb = options.checkDatabaseHealth;
      let isDbHealthy = false;

      if (checkDb !== undefined) {
        try {
          isDbHealthy = await checkDb();
        } catch {
          isDbHealthy = false;
        }
      }

      let isRedisHealthy = true;
      if (options.checkRedisHealth !== undefined) {
        try {
          isRedisHealthy = await options.checkRedisHealth();
        } catch {
          isRedisHealthy = false;
        }
      }

      let isWorkerHealthy = true;
      if (options.checkWorkerHealth !== undefined) {
        try {
          isWorkerHealthy = await options.checkWorkerHealth();
        } catch {
          isWorkerHealthy = false;
        }
      }

      const isReady = isDbHealthy && isRedisHealthy && isWorkerHealthy;
      const timestamp = new Date().toISOString();

      if (isReady) {
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
          database: isDbHealthy ? 'ok' : 'unavailable',
        },
      };
    });
}
