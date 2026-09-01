import { createReplayService, type ReplayJob, type ReplayRequest, type ReplayResult, type ReplayTargetPort, type ReplayPublisherPort, type ReplayAuditPort } from '@techpulse/domain';

export const REPLAY_JOB_NAME = 'replay';
export const REPLAY_JOB_SCHEMA_VERSION = 1 as const;

export interface ReplayJobData extends ReplayJob {}

export function createReplayJobData(input: ReplayRequest): ReplayJobData {
  const stage = input.stage;
  if (!input.targetId || (input.scope === 'stage' && !stage)) throw new Error('Invalid replay job');
  const requestedAt = input.requestedAt.toISOString();
  const naturalKey = `replay:v1:${input.scope}:${input.targetId}:${stage ?? 'normalization'}`;
  return { schemaVersion: REPLAY_JOB_SCHEMA_VERSION, replayId: naturalKey, naturalKey, scope: input.scope, targetId: input.targetId, stage: stage ?? 'normalization', requestedAt };
}

export function parseReplayJobData(value: unknown): ReplayJobData {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid replay job');
  const job = value as Record<string, unknown>;
  if (job['schemaVersion'] !== 1 || typeof job['replayId'] !== 'string' || typeof job['naturalKey'] !== 'string' || typeof job['targetId'] !== 'string' || typeof job['requestedAt'] !== 'string') throw new Error('Invalid replay job');
  if (!['run', 'raw', 'stage'].includes(String(job['scope'])) || !['normalization', 'deduplication'].includes(String(job['stage']))) throw new Error('Invalid replay job');
  return job as unknown as ReplayJobData;
}

export function createReplayHandler(options: { readonly targets: ReplayTargetPort; readonly publisher: ReplayPublisherPort; readonly audit?: ReplayAuditPort }): (job: ReplayJobData) => Promise<ReplayResult> {
  const service = createReplayService(options);
  return (job) => service.replay({ scope: job.scope, targetId: job.targetId, stage: job.stage, requestedAt: new Date(job.requestedAt) });
}
