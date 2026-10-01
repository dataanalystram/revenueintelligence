import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ContextKindSchema, ExternalSystemSchema } from '../domain';

/**
 * Job contracts of context processing (ADR 0013). Payloads carry identifiers
 * only — tenant id, system, delivery key or subject id, checkpoint id,
 * correlation id — never names, emails, property values or credentials.
 * Each schema is strict: an unexpected field fails validation (poison job).
 */
export const QUEUES = {
  receipts: 'lip-receipts',
  sync: 'lip-sync',
  bulk: 'lip-bulk',
} as const;

export const JOBS = {
  receipt: 'receipt.process',
  subject: 'subject.sync',
  backfillPage: 'backfill.page',
  reconcilePage: 'reconcile.page',
  tick: 'context.tick',
} as const;

const Uuid = z.uuid();
const DeliveryKey = z.string().regex(/^[0-9a-f]{64}$/);
const ExternalId = z.string().regex(/^[A-Za-z0-9_.-]{1,255}$/);

export const CauseSchema = z.enum(['webhook', 'backfill', 'reconciliation', 'replay', 'resync']);
export type Cause = z.infer<typeof CauseSchema>;

export const ReceiptJobSchema = z.strictObject({
  v: z.literal(1),
  tenantId: Uuid,
  system: ExternalSystemSchema,
  deliveryKey: DeliveryKey,
  correlationId: Uuid,
  /** Set by operator replays (provenance cause `replay`). */
  replay: z.literal(true).optional(),
});
export type ReceiptJob = z.infer<typeof ReceiptJobSchema>;

export const SubjectJobSchema = z.strictObject({
  v: z.literal(1),
  tenantId: Uuid,
  system: ExternalSystemSchema,
  kind: ContextKindSchema,
  externalId: ExternalId,
  cause: CauseSchema,
  correlationId: Uuid,
});
export type SubjectJob = z.infer<typeof SubjectJobSchema>;

export const PageJobSchema = z.strictObject({
  v: z.literal(1),
  tenantId: Uuid,
  checkpointId: Uuid,
  correlationId: Uuid,
  page: z.number().int().min(0),
});
export type PageJob = z.infer<typeof PageJobSchema>;

export const TickJobSchema = z.strictObject({ v: z.literal(1) });

function digest(...parts: readonly (string | number)[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40);
}

/** Deterministic job ids (no ':'; BullMQ ignores a duplicate id while it is queued). */
export const jobIds = {
  /** `salt` (replays only) gives a fresh id, so a replay is never shadowed by an old failed job. */
  receipt: (tenantId: string, system: string, deliveryKey: string, salt?: string) =>
    `rcpt-${digest(tenantId, system, deliveryKey)}${salt ? `-${salt}` : ''}`,
  subject: (tenantId: string, system: string, kind: string, externalId: string, salt: string) =>
    `subj-${digest(tenantId, system, kind, externalId)}-${digest(salt).slice(0, 12)}`,
  page: (mode: 'backfill' | 'reconcile', checkpointId: string, page: number) =>
    `${mode === 'backfill' ? 'bf' : 'rc'}-${checkpointId}-p${page}`,
};

/** The adapter mapping version recorded in provenance (bump when a mapping changes). */
export const CONTEXT_ADAPTER_VERSION = 'm6.1';
