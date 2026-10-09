import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../shared/canonical-json';
import { ACTOR_ID_PATTERN, ACTOR_KINDS, ASSURANCES } from './actor';
import { CAPABILITIES } from './capabilities';
import { findSecretLike } from './secret-like';

/**
 * Audit events (M10A1 plan §5, §5.1, §6). Identifiers, codes, counts and
 * hashes only: never source values, names, emails or secrets.
 */
export const AUDIT_ACTIONS = [
  'tenant.provision',
  'tenant.status',
  'integration.configure',
  'credential_ref.save',
  'credential_ref.delete',
  'flow.set',
  'lead_source_mapping.save',
  'lead_source_mapping.delete',
  'policy.save',
  'qualification.update',
  'oauth.install_state.issue',
  'oauth.grant.store',
  'oauth.grant.delete',
  'oauth.grant.refresh',
  'webhook.receipts.store',
  'product_model.publish',
  'subscription_import.run',
  'subscription_import.cancel',
  'source_connection.configure',
  'source_connection.status',
  'source_connection.test',
  'source_schema.capture',
  'mapping.publish',
  'authority.publish',
  'sync.start',
  'sync.execute',
  'sync.finish',
  'sync.abandon',
  'profile.start',
  'profile.execute',
  'profile.finish',
  'profile.abandon',
  'profile.purge',
  'eligibility.record',
  'dead_letter.replay',
  'dead_letter.discard',
  'context.backfill.start',
  'context.reconcile.start',
  'context.resync',
  'context.receipts.process',
  'security.rekey',
  'security.audit.purge',
  'security.audit.verify',
  'security.audit.read',
  'operation.denied',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_OUTCOMES = ['allowed', 'denied', 'failed', 'completed'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_REASON_CODES = [
  'capability_not_granted',
  'actor_kind_not_supported',
  'operator_id_required',
  'secret_like_value',
  'stale_base_version',
  'validation_failed',
  'operation_failed',
  'audit_purge_disabled',
] as const;
export type AuditReasonCode = (typeof AUDIT_REASON_CODES)[number];

/** Identifier-only target references: ids, keys, versions, run ids. */
export const TARGET_REF_PATTERN = /^[A-Za-z0-9_.:@/-]{1,200}$/;
export const AUDIT_TARGET_KINDS = [
  'tenant',
  'integration',
  'credential_ref',
  'flow',
  'lead_source_mapping',
  'policy',
  'qualification',
  'oauth',
  'product_model',
  'subscription_import',
  'source_connection',
  'mapping',
  'authority',
  'sync_run',
  'profile_run',
  'eligibility_snapshot',
  'dead_letter',
  'context',
  'audit',
  'key',
] as const;
export type AuditTargetKind = (typeof AUDIT_TARGET_KINDS)[number];

/** Details: a flat object of identifiers, codes, counts, booleans and hashes. */
const DETAIL_KEY = /^[a-z][a-zA-Z0-9_]{0,63}$/;
/** Mirrors the database's app_jsonb_has_secret_like_key (M8): such keys are refused early. */
const SECRET_LIKE_KEY =
  /(secret|password|passwd|passphrase|token|apikey|privatekey|accesskey|credential|bearer|authorization|cookie)/;
export function isSecretLikeKey(key: string): boolean {
  return SECRET_LIKE_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}
const DETAIL_STRING = /^[A-Za-z0-9_.:@/+=-]{0,200}$/;
export const AUDIT_DETAILS_MAX_BYTES = 4096;

export const AuditDetailsSchema = z
  .record(
    z.string().regex(DETAIL_KEY),
    z.union([
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.string().regex(DETAIL_STRING),
      z.array(z.union([z.number().finite(), z.string().regex(DETAIL_STRING)])).max(50),
    ]),
  )
  .superRefine((details, ctx) => {
    for (const key of Object.keys(details)) {
      if (isSecretLikeKey(key)) ctx.addIssue({ code: 'custom', message: 'secret-like detail key' });
    }
    if (new TextEncoder().encode(JSON.stringify(details)).length > AUDIT_DETAILS_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'audit details exceed 4 KB' });
    }
    for (const value of Object.values(details)) {
      const strings = Array.isArray(value) ? value : [value];
      for (const s of strings) {
        if (typeof s === 'string' && findSecretLike(s) !== undefined) {
          ctx.addIssue({ code: 'custom', message: 'audit details contain a secret-like value' });
        }
      }
    }
  });
export type AuditDetails = z.infer<typeof AuditDetailsSchema>;

export const AuditEventInputSchema = z
  .object({
    actorKind: z.enum(ACTOR_KINDS),
    actorId: z.string().regex(ACTOR_ID_PATTERN),
    actorAssurance: z.enum(ASSURANCES),
    capability: z.enum(CAPABILITIES),
    action: z.enum(AUDIT_ACTIONS),
    outcome: z.enum(AUDIT_OUTCOMES),
    reasonCode: z.enum(AUDIT_REASON_CODES).nullable(),
    targetKind: z.enum(AUDIT_TARGET_KINDS).nullable(),
    targetRef: z.string().regex(TARGET_REF_PATTERN).nullable(),
    correlationId: z.string().uuid(),
    policyVersion: z.number().int().positive(),
    details: AuditDetailsSchema,
  })
  .strict()
  .superRefine((e, ctx) => {
    const needsReason = e.outcome === 'denied' || e.outcome === 'failed';
    if (needsReason !== (e.reasonCode !== null)) {
      ctx.addIssue({ code: 'custom', message: 'reasonCode is required exactly for denied/failed' });
    }
  });
export type AuditEventInput = z.infer<typeof AuditEventInputSchema>;

/** §5.1: the first event of a tenant links to 64 hex zeros. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

/** The fields that are hashed, in a fixed shape (absent values are `null`). */
export interface AuditChainPayload extends AuditEventInput {
  readonly tenantId: string;
  readonly id: string;
  readonly seq: number;
  readonly occurredAt: Date;
}

/** Deterministic canonical payload: sorted keys, no whitespace, `null` for absent, UTC ms timestamps. */
export function auditCanonicalPayload(p: AuditChainPayload): string {
  return canonicalJson({
    tenantId: p.tenantId,
    id: p.id,
    seq: p.seq,
    occurredAt: p.occurredAt.toISOString(),
    actorKind: p.actorKind,
    actorId: p.actorId,
    actorAssurance: p.actorAssurance,
    capability: p.capability,
    action: p.action,
    outcome: p.outcome,
    reasonCode: p.reasonCode,
    targetKind: p.targetKind,
    targetRef: p.targetRef,
    correlationId: p.correlationId,
    policyVersion: p.policyVersion,
    details: p.details,
  });
}

/** `hash = sha256_hex(prev_hash ‖ "\n" ‖ canonical_json(payload))`. */
export function auditEventHash(prevHash: string, payload: AuditChainPayload): string {
  return createHash('sha256')
    .update(`${prevHash}\n${auditCanonicalPayload(payload)}`)
    .digest('hex');
}

export interface StoredAuditEvent extends AuditChainPayload {
  readonly prevHash: string;
  readonly hash: string;
}

export type ChainVerdict =
  | { readonly ok: true; readonly events: number; readonly head: string }
  | {
      readonly ok: false;
      readonly events: number;
      readonly brokenAtSeq: number;
      readonly reason: 'hash_mismatch' | 'link_mismatch' | 'seq_gap';
    };

/**
 * Walks a tenant's events in `seq` order from an anchor (genesis or the last
 * purged hash) and recomputes every link.
 */
export function verifyAuditChain(
  events: readonly StoredAuditEvent[],
  anchor: { readonly hash: string; readonly seq: number } = { hash: AUDIT_GENESIS_HASH, seq: 0 },
): ChainVerdict {
  let prev = anchor.hash;
  let expectedSeq = anchor.seq + 1;
  for (const e of events) {
    if (e.seq !== expectedSeq) {
      return { ok: false, events: events.length, brokenAtSeq: e.seq, reason: 'seq_gap' };
    }
    if (e.prevHash !== prev) {
      return { ok: false, events: events.length, brokenAtSeq: e.seq, reason: 'link_mismatch' };
    }
    if (auditEventHash(e.prevHash, e) !== e.hash) {
      return { ok: false, events: events.length, brokenAtSeq: e.seq, reason: 'hash_mismatch' };
    }
    prev = e.hash;
    expectedSeq += 1;
  }
  return { ok: true, events: events.length, head: prev };
}
