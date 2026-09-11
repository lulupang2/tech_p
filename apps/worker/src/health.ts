import type { PartitionRuntimeStatus } from './partition-runtime.js';

export type WorkerHealthStatus = 'starting' | 'healthy' | 'degraded' | 'unhealthy' | 'stopped';

export interface WorkerHealthInfo {
  readonly status: WorkerHealthStatus;
  readonly isHealthy: boolean;
  readonly uptimeSeconds: number;
  readonly startedAt: string;
  readonly lastTickAt: string | null;
  readonly lastError: string | null;
  readonly consecutiveErrors: number;
  readonly runtime: PartitionRuntimeStatus;
}

export class WorkerLifecycle {
  private status: WorkerHealthStatus = 'starting';
  private readonly startedAt: Date;
  private lastTickAt: Date | null = null;
  private lastError: string | null = null;
  private consecutiveErrors = 0;
  private readonly errorThresholdDegraded = 3;
  private readonly errorThresholdUnhealthy = 10;

  constructor(now: Date = new Date()) {
    this.startedAt = now;
  }

  setRunning(): void {
    this.status = 'healthy';
    this.consecutiveErrors = 0;
    this.lastError = null;
  }

  setStopped(): void {
    this.status = 'stopped';
  }

  recordTick(success: boolean, error?: Error | string | null): void {
    this.lastTickAt = new Date();
    if (success) {
      this.consecutiveErrors = 0;
      this.lastError = null;
      if (this.status !== 'stopped') {
        this.status = 'healthy';
      }
    } else {
      this.consecutiveErrors++;
      if (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      if (this.consecutiveErrors >= this.errorThresholdUnhealthy) {
        this.status = 'unhealthy';
      } else if (this.consecutiveErrors >= this.errorThresholdDegraded) {
        this.status = 'degraded';
      }
    }
  }

  getHealth(runtimeStatus?: PartitionRuntimeStatus): WorkerHealthInfo {
    const defaultRuntime: PartitionRuntimeStatus = {
      running: this.status === 'healthy' || this.status === 'degraded',
      activeIncrementalTasks: 0,
      activeBackfillTasks: 0,
      totalDispatched: 0,
    };

    const isHealthy =
      this.status === 'healthy' || this.status === 'starting' || this.status === 'degraded';

    return {
      status: this.status,
      isHealthy,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      startedAt: this.startedAt.toISOString(),
      lastTickAt: this.lastTickAt ? this.lastTickAt.toISOString() : null,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
      runtime: runtimeStatus ?? defaultRuntime,
    };
  }
}
