import { z } from 'zod';

/**
 * Source synchronisation jobs (M8). Same BullMQ platform, retry/backoff and
 * dead-letter semantics as M6; a dedicated queue so the context module's
 * `lip-bulk` dispatcher never sees these jobs. Payloads carry identifiers only.
 */
export const SOURCES_QUEUE = 'lip-sources';
export const SOURCE_SYNC_JOB = 'source.sync';

export const SourceSyncJobSchema = z.strictObject({
  v: z.literal(1),
  tenantId: z.uuid(),
  /** The run (checkpoint) id. */
  checkpointId: z.uuid(),
  correlationId: z.uuid(),
});
export type SourceSyncJob = z.infer<typeof SourceSyncJobSchema>;

/** Deterministic: one queued job per run. */
export const sourceSyncJobId = (checkpointId: string) => `src-${checkpointId}`;

/** Source profiling (M9A, ADR 0022): same queue and processor registration, ids only. */
export const SOURCE_PROFILE_JOB = 'source.profile';

export const SourceProfileJobSchema = z.strictObject({
  v: z.literal(1),
  tenantId: z.uuid(),
  runId: z.uuid(),
  correlationId: z.uuid(),
});
export type SourceProfileJob = z.infer<typeof SourceProfileJobSchema>;

/** Deterministic: one queued job per profile run. */
export const sourceProfileJobId = (runId: string) => `prf-${runId}`;
