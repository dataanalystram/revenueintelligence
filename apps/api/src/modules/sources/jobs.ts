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
