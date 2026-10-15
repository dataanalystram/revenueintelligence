import { Inject, Injectable } from '@nestjs/common';
import {
  AFFILIATION_LINK_TYPE_ID,
  decideApplyWithHash,
  decideMerge,
  decideRetirement,
  fieldHash,
  findSecretLike,
  primaryCompanyLink,
  type ApplyDecision,
  type ContextKind,
  type ExternalRef,
  type PresentObservation,
  type SecretPatternCode,
  type SecurityActor,
  type SourceObservation,
} from '../../domain';
import {
  assertAuthorized,
  recordValueHistory,
  SecurityEventsService,
  TenantDatabase,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import { CONTEXT_ADAPTER_VERSION, type Cause } from '../jobs';
import {
  COMPANY_CANONICAL_LOCK_SCOPE,
  COMPANY_MERGE_PARTICIPANTS,
  PERSON_MERGE_PARTICIPANTS,
  type CompanyMergeParticipant,
  type PersonMergeParticipant,
} from '../merge-participants';
import { AccountHierarchyWriter } from './account-hierarchy.writer';
import { accountStructureEnabled } from './account-structure.shared';
import { PersonAffiliationWriter, type ObservedAffiliation } from './person-affiliation.writer';
import {
  ContextStore,
  type CompanyValues,
  type PersonValues,
  type RefRow,
} from '../infrastructure/context-store';

/** Why and how an observation is being ingested: recorded in provenance. */
export interface IngestMeta {
  readonly cause: Cause;
  readonly correlationId: string;
  readonly receiptDeliveryKey?: string;
  readonly checkpointId?: string;
  /** M8 versioned sources: the producing adapter version and mapping version. */
  readonly adapterVersion?: string;
  readonly mappingVersion?: number;
  /** M10A1: who writes (recorded on the change record); set from the authorized context. */
  readonly actor?: SecurityActor;
}

/** M10A1 amendment A1: a source value refused as secret-like and held (never written or logged). */
export interface HeldField {
  readonly field: string;
  readonly code: SecretPatternCode;
}

export interface IngestResult {
  readonly decision: ApplyDecision;
  readonly entityId?: string;
  /** True when a canonical change (and a provenance row) was written. */
  readonly changed: boolean;
  /** Source companies a person links to that are not known yet (read them back). */
  readonly unknownCompanies: readonly ExternalRef[];
  /** Free-text fields refused as secret-like: not written; any previous value is kept. */
  readonly held?: readonly HeldField[];
  /**
   * M10C: the parent reference an `account.parent` observation named that is
   * not known yet (the run retries it in its second pass, plan §2.4).
   */
  readonly unresolvedParent?: ExternalRef;
}

/** M10C: a child→parent pair left unresolved by a run's first pass (identifiers only). */
export interface PendingParent {
  readonly child: ExternalRef;
  readonly parent: ExternalRef;
  readonly observedAt: Date;
  readonly sourceUpdatedAt?: Date;
}

/** Free-text canonical fields checked for secret-like values (plan §11). */
const FREE_TEXT_FIELDS: Readonly<Record<ContextKind, readonly string[]>> = {
  company: ['name'],
  person: ['firstName', 'lastName', 'jobTitle'],
};

function heldFields(obs: SourceObservation): HeldField[] {
  if (obs.presence !== 'present') return [];
  const fields = obs.fields as Record<string, unknown>;
  const held: HeldField[] = [];
  for (const field of FREE_TEXT_FIELDS[obs.kind]) {
    const value = fields[field];
    const code = typeof value === 'string' ? findSecretLike(value) : undefined;
    if (code) held.push({ field, code });
  }
  return held;
}

/**
 * The field hash with held values replaced by a marker: a re-read of the same
 * secret-like value stays `unchanged`, removing it at the source is a change,
 * and no hash of the refused value is ever stored.
 */
function heldAwareHash(obs: PresentObservation, held: readonly HeldField[]): string {
  if (held.length === 0) return fieldHash(obs);
  const fields: Record<string, unknown> = { ...obs.fields };
  for (const h of held) fields[h.field] = `held:${h.code}`;
  return fieldHash({ ...obs, fields });
}

export interface MergeInput {
  readonly kind: ContextKind;
  readonly survivor: ExternalRef;
  readonly merged: readonly ExternalRef[];
  readonly observedAt: Date;
}

/** M9B: retirement of the references an accepted full read no longer returned. */
export interface RetireAbsentInput {
  readonly system: ExternalRef['system'];
  readonly objectType: string;
  /** Every id the run saw for the object: read (accepted or rejected) or referenced. */
  readonly seen: ReadonlySet<string>;
  /** The run's read time: the retirement time, and only references last read before it qualify. */
  readonly observedAt: Date;
  readonly runId: string;
}

export interface IngestOptions {
  /** Run inside this transaction (a backfill page) instead of opening one. */
  readonly within?: TenantTransaction;
  /** Runs in the same transaction after the canonical write (e.g. mark the receipt processed). */
  readonly afterApply?: (tx: TenantTransaction, result: IngestResult) => Promise<void>;
}

const TX_TIMEOUT_MS = 30_000;

/**
 * The single canonical writer (ADR 0014). Webhook read-backs, backfill pages
 * and reconciliation pages all end here, so there is one implementation of
 * identity resolution, apply rules, lifecycle semantics and provenance.
 *
 * Identity is resolved by external reference only: platform UUIDs are
 * canonical, source ids are references, and no cross-system matching rule
 * exists in M6. Everything for one observation happens in one tenant
 * transaction under a per-record advisory lock; any failure rolls it all back.
 */
@Injectable()
export class ContextIngestionService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: ContextStore,
    @Inject(COMPANY_MERGE_PARTICIPANTS)
    private readonly mergeParticipants: readonly CompanyMergeParticipant[],
    private readonly events: SecurityEventsService,
    // M10C (ADR 0029): the account-structure writers and the person-merge port.
    private readonly hierarchy: AccountHierarchyWriter,
    private readonly affiliations: PersonAffiliationWriter,
    @Inject(PERSON_MERGE_PARTICIPANTS)
    private readonly personMergeParticipants: readonly PersonMergeParticipant[],
  ) {}

  /** M10C: company references a person observation's links removed, per transaction. */
  private readonly removedLinks = new WeakMap<TenantTransaction, ExternalRef[]>();

  async ingest(
    actx: AuthorizedContext<'canonical.source_sync'>,
    observation: SourceObservation,
    meta: IngestMeta,
    options: IngestOptions = {},
  ): Promise<IngestResult> {
    assertAuthorized(actx, 'canonical.source_sync');
    const attributed: IngestMeta = { ...meta, actor: actx.actor };
    const run = async (tx: TenantTransaction) => {
      const applied = await this.apply(actx, tx, observation, attributed);
      const result = await this.structure(actx, tx, observation, applied, attributed);
      await options.afterApply?.(tx, result);
      return result;
    };
    const result = await (options.within
      ? run(options.within)
      : this.db.transaction(actx.tenant, run, { timeoutMs: TX_TIMEOUT_MS }));
    for (const h of result.held ?? []) {
      // Coordinates and codes only: the value is never part of the event.
      this.events.emit({
        event: 'secret_like_refused',
        outcome: 'refused',
        tenant: actx.tenant.tenantSlug,
        actorKind: actx.actor.kind,
        reasonCode: 'secret_like_value',
        correlationId: meta.correlationId,
        coordinates: {
          system: observation.ref.system,
          objectType: observation.ref.objectType,
          recordId: observation.ref.id,
          field: h.field,
          pattern: h.code,
        },
      });
    }
    return result;
  }

  /**
   * M10C (plan §2.4, Q6): the second pass of a run. A child whose parent was
   * not known when the child was read is retried after every account
   * observation of the run was applied, under the same authority. Still
   * unknown → an open `hierarchy_parent_unresolved` issue (identifiers only),
   * retried on the next run that observes the child. No pending store.
   */
  async resolvePendingParent(
    actx: AuthorizedContext<'canonical.source_sync'>,
    pending: PendingParent,
    meta: IngestMeta,
  ): Promise<'applied' | 'unchanged' | 'refused' | 'human_override' | 'unresolved' | 'disabled'> {
    assertAuthorized(actx, 'canonical.source_sync');
    const attributed: IngestMeta = { ...meta, actor: actx.actor };
    return this.db.transaction(
      actx.tenant,
      async (tx) => {
        await this.store.lockRef(tx, 'company', pending.child);
        const childId = await this.store.companyIdForRef(tx, pending.child);
        if (!childId) return 'unresolved' as const;
        const out = await this.hierarchy.observeParent(actx, tx, {
          childId,
          childRef: pending.child,
          parent: { kind: 'set', ref: pending.parent },
          effectiveAt: pending.sourceUpdatedAt ?? pending.observedAt,
          provenance: this.change(attributed, pending.child, pending.sourceUpdatedAt),
        });
        if (out === 'unresolved') {
          await this.hierarchy.recordUnresolved(actx, tx, {
            childId,
            childRef: pending.child,
            parentRef: pending.parent,
          });
        }
        return out;
      },
      { timeoutMs: TX_TIMEOUT_MS },
    );
  }

  /**
   * M9B (governed correction after live M08): retires, inside the caller's
   * transaction, every active company reference of one source object that a
   * successful, proven and operator-accepted full read did not see. The caller
   * owns those gates. Retirement is a reference lifecycle state only: the row
   * is kept, the canonical company and its record state are untouched (no
   * account deletion is inferred), and one provenance row per reference
   * records the run. A later observation reactivates the reference.
   */
  async retireAbsentWithin(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: RetireAbsentInput,
    meta: IngestMeta,
  ): Promise<number> {
    assertAuthorized(actx, 'canonical.source_sync');
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('retirement tenant does not match the transaction tenant');
    }
    // M10A1: the retirement change records carry the authorized actor.
    meta = { ...meta, actor: actx.actor };
    let retired = 0;
    const candidates = await this.store.activeCompanyRefsOf(
      tx,
      input.system,
      input.objectType,
      input.observedAt,
    );
    // The caller (SourceSyncService 4d) owns the run gates: only an accepted,
    // proven, full run without uncertainty reaches here (M9B). The shared rule
    // (M10B plan §2.4) decides each candidate.
    const run = {
      accepted: true,
      proven: true,
      full: true,
      uncertain: false,
      observedAt: input.observedAt,
      seen: input.seen,
    };
    for (const row of candidates) {
      const decision = decideRetirement(
        {
          externalId: row.externalId,
          origin: 'observed',
          state: 'active',
          lastSeenAt: row.lastSeenAt,
        },
        run,
      );
      if (!decision.retire) continue;
      const ref: ExternalRef = {
        system: input.system,
        objectType: input.objectType,
        id: row.externalId,
      };
      await this.store.lockRef(tx, 'company', ref);
      if (!(await this.store.retireCompanyRef(tx, ref, input.observedAt, input.runId))) continue;
      const id = await this.store.resolveCanonical(tx, 'company', row.canonicalId);
      const changeId = await this.store.insertChange(tx, {
        entityKind: 'company',
        entityId: id,
        changeType: 'state_changed',
        changedFields: ['refState'],
        ...this.change(meta, ref, undefined),
      });
      await this.store.updateRef(tx, 'company', ref, { lastChangeId: changeId });
      retired += 1;
    }
    return retired;
  }

  /** Applies a source merge: lineage from merged ids to the survivor (ADR 0014 §5). */
  async ingestMerge(
    actx: AuthorizedContext<'canonical.source_sync'>,
    input: MergeInput,
    meta: IngestMeta,
    afterApply?: (
      tx: TenantTransaction,
      result: { readonly applied: boolean; readonly survivorKnown: boolean },
    ) => Promise<void>,
  ): Promise<{ readonly applied: boolean; readonly survivorKnown: boolean }> {
    assertAuthorized(actx, 'canonical.source_sync');
    const attributed: IngestMeta = { ...meta, actor: actx.actor };
    const run = async (tx: TenantTransaction) => {
      const result = await this.merge(tx, input, attributed);
      await afterApply?.(tx, result);
      return result;
    };
    return this.db.transaction(actx.tenant, run, { timeoutMs: TX_TIMEOUT_MS });
  }

  private change(
    meta: IngestMeta,
    source: ExternalRef,
    sourceUpdatedAt: Date | undefined,
  ): { readonly source: ExternalRef } & Pick<
    Parameters<ContextStore['insertChange']>[1],
    | 'cause'
    | 'receiptDeliveryKey'
    | 'checkpointId'
    | 'sourceUpdatedAt'
    | 'adapter'
    | 'adapterVersion'
    | 'correlationId'
    | 'mappingVersion'
  > {
    return {
      source,
      cause: meta.cause,
      ...(meta.receiptDeliveryKey ? { receiptDeliveryKey: meta.receiptDeliveryKey } : {}),
      ...(meta.checkpointId ? { checkpointId: meta.checkpointId } : {}),
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
      adapter: source.system,
      adapterVersion: meta.adapterVersion ?? CONTEXT_ADAPTER_VERSION,
      correlationId: meta.correlationId,
      ...(meta.mappingVersion !== undefined ? { mappingVersion: meta.mappingVersion } : {}),
      ...(meta.actor ? { actor: meta.actor } : {}),
    };
  }

  private async apply(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    obs: SourceObservation,
    meta: IngestMeta,
  ): Promise<IngestResult> {
    await this.store.lockRef(tx, obs.kind, obs.ref);
    if (obs.kind === 'person' && obs.presence === 'present' && obs.companyLinks) {
      // Serialises with the primary company's own ingestion, so whichever
      // commits second sees the other: no person is left waiting for a company
      // created concurrently. Taken before any row is written, so the
      // company's link step never waits on this transaction (no deadlock).
      const { link } = primaryCompanyLink(obs.companyLinks);
      if (link) await this.store.lockRef(tx, 'company', link.company);
    }
    if (
      obs.kind === 'person' &&
      obs.presence === 'present' &&
      (obs.companyLinks || obs.affiliations) &&
      (await accountStructureEnabled(tx))
    ) {
      // M10C: the affiliation companies' canonical locks, before any row is
      // written (the order merges and subscription writers use), so a concurrent
      // company merge cannot interleave with the affiliation step.
      const ids = new Set<string>();
      for (const ref of [
        ...(obs.companyLinks ?? []).map((l) => l.company),
        ...(obs.affiliations ?? []).map((a) => a.company),
      ]) {
        const id = await this.store.companyIdForRef(tx, ref);
        if (id) ids.add(id);
      }
      for (const id of [...ids].sort()) {
        await this.store.lockKey(tx, COMPANY_CANONICAL_LOCK_SCOPE, id);
      }
    }
    const stored = await this.store.findRef(tx, obs.kind, obs.ref);
    const held = heldFields(obs);
    const hash = obs.presence === 'present' ? heldAwareHash(obs, held) : undefined;
    const decision = decideApplyWithHash(stored, obs, hash);
    const none: IngestResult = {
      decision,
      changed: false,
      unknownCompanies: [],
      ...(held.length ? { held } : {}),
    };

    switch (decision) {
      case 'not_found':
      case 'stale':
        return stored ? { ...none, entityId: stored.canonicalId } : none;
      case 'unchanged': {
        await this.store.updateRef(tx, obs.kind, obs.ref, {
          lastSeenAt: maxDate(
            stored!.lastSeenAt,
            obs.presence === 'present' ? obs.observedAt : undefined,
          ),
        });
        // A person committed concurrently may still wait for this company
        // (its follow-up read finds the company unchanged): link it now.
        if (obs.kind === 'company' && obs.presence === 'present') {
          const id = await this.store.resolveCanonical(tx, 'company', stored!.canonicalId);
          await this.afterWrite(actx, tx, obs, id, meta);
        }
        return { ...none, entityId: stored!.canonicalId };
      }
      case 'delete':
        return this.tombstone(tx, obs, stored!, meta);
      case 'create':
        return withHeld(
          await this.create(actx, tx, obs as PresentObservation, meta, held, hash!),
          held,
        );
      case 'apply':
      case 'restore':
        return withHeld(
          await this.update(
            actx,
            tx,
            obs as PresentObservation,
            stored!,
            decision,
            meta,
            held,
            hash!,
          ),
          held,
        );
    }
  }

  private async create(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    obs: PresentObservation,
    meta: IngestMeta,
    held: readonly HeldField[],
    hash: string,
  ): Promise<IngestResult> {
    const now = new Date();
    const unknownCompanies: ExternalRef[] = [];
    let id: string;
    let changedFields: string[];
    let createdName: string | null = null;
    if (obs.kind === 'company') {
      const values = withoutHeld(companyValues(obs), held, undefined);
      id = await this.store.createCompany(tx, values, now);
      createdName = values.name;
      changedFields = presentFields({
        name: values.name,
        domains: values.domains.length ? 1 : null,
      });
    } else {
      const companyId = await this.primaryCompanyId(tx, obs, unknownCompanies);
      const values = withoutHeld(personValues(obs, companyId ?? null), held, undefined);
      id = await this.store.createPerson(tx, values, now);
      changedFields = presentFields({ ...values });
    }
    const changeId = await this.store.insertChange(tx, {
      entityKind: obs.kind,
      entityId: id,
      changeType: 'created',
      changedFields,
      ...this.change(meta, obs.ref, obs.sourceUpdatedAt),
    });
    if (obs.kind === 'company' && createdName !== null) {
      // M10A2: value history, same transaction as the projection and the change record.
      await recordValueHistory(tx, {
        entityKind: 'company',
        entityId: id,
        changeId,
        effectiveAt: obs.sourceUpdatedAt ?? obs.observedAt,
        ...(meta.actor ? { actor: meta.actor } : {}),
        changes: [{ field: 'name', oldValue: null, newValue: createdName }],
      });
    }
    await this.store.insertRef(tx, obs.kind, obs.ref, id, {
      state: 'active',
      firstSeenAt: obs.observedAt,
      lastSeenAt: obs.observedAt,
      sourceCreatedAt: obs.sourceCreatedAt ?? null,
      sourceUpdatedAt: obs.sourceUpdatedAt ?? null,
      fieldHash: hash,
      lastChangeId: changeId,
    });
    await this.afterWrite(actx, tx, obs, id, meta);
    return { decision: 'create', entityId: id, changed: true, unknownCompanies };
  }

  private async update(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    obs: PresentObservation,
    stored: RefRow,
    decision: 'apply' | 'restore',
    meta: IngestMeta,
    held: readonly HeldField[],
    hash: string,
  ): Promise<IngestResult> {
    const now = new Date();
    const id = await this.store.resolveCanonical(tx, obs.kind, stored.canonicalId);
    const unknownCompanies: ExternalRef[] = [];
    const changedFields: string[] = [];
    let recordStateBefore: string;
    let nameChange: { oldValue: string | null; newValue: string | null } | undefined;

    if (obs.kind === 'company') {
      const current = await this.store.getCompany(tx, id);
      recordStateBefore = current.recordState;
      const next = withoutHeld(companyValues(obs), held, current.values);
      if (current.values.name !== next.name) {
        changedFields.push('name');
        nameChange = { oldValue: current.values.name, newValue: next.name };
      }
      if (!sameList(current.values.domains, next.domains)) changedFields.push('domains');
      if (changedFields.length) await this.store.updateCompany(tx, id, next, now);
    } else {
      const current = await this.store.getPerson(tx, id);
      recordStateBefore = current.recordState;
      const companyId =
        obs.companyLinks === undefined
          ? current.values.companyId
          : ((await this.primaryCompanyId(tx, obs, unknownCompanies)) ?? null);
      const next = withoutHeld(personValues(obs, companyId), held, current.values);
      for (const k of Object.keys(next) as (keyof PersonValues)[]) {
        if (current.values[k] !== next[k]) changedFields.push(k);
      }
      if (changedFields.length) await this.store.updatePerson(tx, id, next, now);
    }

    await this.store.updateRef(tx, obs.kind, obs.ref, {
      state: 'active',
      deletedAt: null,
      ...(obs.kind === 'company' ? { retiredAt: null, retiredByRunId: null } : {}),
      sourceCreatedAt: obs.sourceCreatedAt ?? stored.sourceCreatedAt ?? null,
      sourceUpdatedAt: obs.sourceUpdatedAt ?? stored.sourceUpdatedAt ?? null,
      fieldHash: hash,
      lastSeenAt: maxDate(stored.lastSeenAt, obs.observedAt),
    });
    if (decision === 'restore') changedFields.push('refState');
    const recordState = await this.recomputeRecordState(tx, obs.kind, id, recordStateBefore, now);
    if (recordState) changedFields.push('recordState');
    const linksChanged = await this.afterWrite(actx, tx, obs, id, meta);

    if (changedFields.length === 0 && !linksChanged) {
      return { decision, entityId: id, changed: false, unknownCompanies };
    }
    const changeId = await this.store.insertChange(tx, {
      entityKind: obs.kind,
      entityId: id,
      changeType:
        decision === 'restore'
          ? 'state_changed'
          : changedFields.length === 0
            ? 'relationship_changed'
            : 'updated',
      changedFields: changedFields.length ? changedFields : ['companyLinks'],
      ...this.change(meta, obs.ref, obs.sourceUpdatedAt),
    });
    if (nameChange) {
      // M10A2: value history, same transaction as the projection and the change record.
      await recordValueHistory(tx, {
        entityKind: 'company',
        entityId: id,
        changeId,
        effectiveAt: obs.sourceUpdatedAt ?? obs.observedAt,
        ...(meta.actor ? { actor: meta.actor } : {}),
        changes: [{ field: 'name', ...nameChange }],
      });
    }
    await this.store.updateRef(tx, obs.kind, obs.ref, { lastChangeId: changeId });
    return { decision, entityId: id, changed: true, unknownCompanies };
  }

  private async tombstone(
    tx: TenantTransaction,
    obs: SourceObservation,
    stored: RefRow,
    meta: IngestMeta,
  ): Promise<IngestResult> {
    const now = new Date();
    const id = await this.store.resolveCanonical(tx, obs.kind, stored.canonicalId);
    await this.store.updateRef(tx, obs.kind, obs.ref, {
      state: 'deleted',
      deletedAt: obs.observedAt,
    });
    const before =
      obs.kind === 'company'
        ? (await this.store.getCompany(tx, id)).recordState
        : (await this.store.getPerson(tx, id)).recordState;
    const changedFields = ['refState'];
    if (await this.recomputeRecordState(tx, obs.kind, id, before, now))
      changedFields.push('recordState');
    const changeId = await this.store.insertChange(tx, {
      entityKind: obs.kind,
      entityId: id,
      changeType: 'state_changed',
      changedFields,
      ...this.change(meta, obs.ref, undefined),
    });
    await this.store.updateRef(tx, obs.kind, obs.ref, { lastChangeId: changeId });
    return { decision: 'delete', entityId: id, changed: true, unknownCompanies: [] };
  }

  /** active ⇄ inactive from the references; merged records are left alone. */
  private async recomputeRecordState(
    tx: TenantTransaction,
    kind: ContextKind,
    id: string,
    before: string,
    now: Date,
  ): Promise<boolean> {
    if (before === 'merged') return false;
    const next = (await this.store.activeRefCount(tx, kind, id)) > 0 ? 'active' : 'inactive';
    if (next === before) return false;
    if (kind === 'company') await this.store.updateCompany(tx, id, { recordState: next }, now);
    else await this.store.updatePerson(tx, id, { recordState: next }, now);
    return true;
  }

  private async primaryCompanyId(
    tx: TenantTransaction,
    obs: Extract<PresentObservation, { kind: 'person' }>,
    unknown: ExternalRef[],
  ): Promise<string | undefined> {
    if (!obs.companyLinks) return undefined;
    const { link } = primaryCompanyLink(obs.companyLinks);
    if (!link) return undefined;
    const id = await this.store.companyIdForRef(tx, link.company);
    if (!id) unknown.push(link.company);
    return id;
  }

  /** Source relationships, late company links and identity questions. Returns link change. */
  private async afterWrite(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    obs: PresentObservation,
    id: string,
    meta: IngestMeta,
  ): Promise<boolean> {
    if (obs.kind === 'person') {
      let changed = false;
      if (obs.companyLinks) {
        const replaced = await this.store.replacePersonLinks(
          tx,
          obs.ref,
          obs.companyLinks,
          obs.observedAt,
        );
        changed = replaced.changed;
        // M10C: an authoritative removal may end an affiliation (structure step).
        if (replaced.removed.length) this.removedLinks.set(tx, [...replaced.removed]);
        const { ambiguous } = primaryCompanyLink(obs.companyLinks);
        if (ambiguous) {
          await this.store.recordConflict(tx, {
            kind: 'ambiguous_primary_company',
            entityKind: 'person',
            identity: `${tx.tenantId}|${obs.ref.system}|${obs.ref.objectType}|${obs.ref.id}`,
            canonicalIds: [id],
            externalRefs: [obs.ref, ...obs.companyLinks.map((l) => l.company)],
          });
        }
      }
      if (obs.fields.email) {
        // Concurrent ingestion of two people with one email must still see each other.
        await this.store.lockKey(tx, 'email', obs.fields.email);
        const others = await this.store.personIdsWithEmail(tx, obs.fields.email, id);
        if (others.length > 0) {
          // Email is not identity: record the question, never merge (ADR 0014).
          await this.store.recordConflict(tx, {
            kind: 'shared_email',
            entityKind: 'person',
            identity: `${tx.tenantId}|${obs.fields.email}`,
            canonicalIds: [id, ...others],
            externalRefs: [obs.ref],
          });
        }
      }
      return changed;
    }
    // A company that arrives after its people: link them now, with provenance.
    const waiting = await this.store.peopleAwaitingCompany(tx, obs.ref, id);
    const now = new Date();
    for (const personId of waiting) {
      await this.store.updatePerson(tx, personId, { companyId: id }, now);
      await this.store.insertChange(tx, {
        entityKind: 'person',
        entityId: personId,
        changeType: 'relationship_changed',
        changedFields: ['companyId'],
        ...this.change(meta, obs.ref, obs.sourceUpdatedAt),
      });
    }
    // M10C (plan §3.2): people linked to this company before it arrived get the
    // missing affiliation now (never overwriting an existing row's fields).
    const linkedPeople = (await accountStructureEnabled(tx))
      ? await this.store.peopleLinkedTo(tx, obs.ref)
      : [];
    for (const linked of linkedPeople) {
      await this.affiliations.observe(actx, tx, {
        personId: linked.personId,
        personRef: linked.ref,
        present: [{ company: obs.ref, fields: { roleCodes: [] } }],
        removed: [],
        observedAt: obs.observedAt,
        provenance: this.change(meta, obs.ref, obs.sourceUpdatedAt),
        createOnly: true,
      });
    }
    return false;
  }

  /**
   * M10C (plan §2, §3): the account-structure step of one present observation,
   * after the record itself was applied (also when it was `unchanged`, so a
   * tenant that adopted 0.3 gets its structure from the next authoritative run
   * without a backfill, Q9). Refusals never undo the record's other fields.
   */
  private async structure(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    obs: SourceObservation,
    result: IngestResult,
    meta: IngestMeta,
  ): Promise<IngestResult> {
    const removedLinks = this.removedLinks.get(tx) ?? [];
    this.removedLinks.delete(tx);
    if (
      obs.presence !== 'present' ||
      !result.entityId ||
      !['create', 'apply', 'restore', 'unchanged'].includes(result.decision)
    ) {
      return result;
    }
    const entityId = await this.store.resolveCanonical(tx, obs.kind, result.entityId);
    const provenance = this.change(meta, obs.ref, obs.sourceUpdatedAt);
    if (obs.kind === 'company') {
      if (!obs.parent) return result;
      const out = await this.hierarchy.observeParent(actx, tx, {
        childId: entityId,
        childRef: obs.ref,
        parent: obs.parent,
        effectiveAt: obs.sourceUpdatedAt ?? obs.observedAt,
        provenance,
      });
      if (out === 'unresolved' && obs.parent.kind === 'set') {
        return { ...result, unresolvedParent: obs.parent.ref };
      }
      return out === 'applied' ? { ...result, changed: true } : result;
    }
    if (!obs.companyLinks && !obs.affiliations) {
      await this.affiliations.endAllOnAbsence(tx, entityId, obs.observedAt, provenance);
      return result;
    }
    const removed = [...removedLinks];
    const present: ObservedAffiliation[] = (obs.companyLinks ?? []).map((l) => ({
      company: l.company,
      fields: { roleCodes: [] },
    }));
    if (obs.affiliations) {
      // `person.affiliation` links are kept in their own scope of the source relationships.
      const replaced = await this.store.replacePersonLinks(
        tx,
        obs.ref,
        obs.affiliations.map((a) => ({
          company: a.company,
          typeId: AFFILIATION_LINK_TYPE_ID,
          category: 'standard' as const,
          primary: false,
        })),
        obs.observedAt,
        'affiliations',
      );
      removed.push(...replaced.removed);
      for (const a of obs.affiliations) {
        present.push({
          company: a.company,
          fields: {
            roleCodes: a.roleCodes,
            ...(a.startsAt ? { startsAt: a.startsAt } : {}),
            ...(a.endsAt ? { endsAt: a.endsAt } : {}),
          },
        });
      }
    }
    const out = await this.affiliations.observe(actx, tx, {
      personId: entityId,
      personRef: obs.ref,
      present,
      removed,
      observedAt: obs.observedAt,
      provenance,
    });
    return out.created + out.updated + out.ended > 0 ? { ...result, changed: true } : result;
  }

  private async merge(
    tx: TenantTransaction,
    input: MergeInput,
    meta: IngestMeta,
  ): Promise<{ applied: boolean; survivorKnown: boolean }> {
    const now = new Date();
    const all = [input.survivor, ...input.merged].sort((a, b) => a.id.localeCompare(b.id));
    for (const ref of all) await this.store.lockRef(tx, input.kind, ref);
    const survivorRef = await this.store.findRef(tx, input.kind, input.survivor);
    if (!survivorRef) return { applied: false, survivorKnown: false };
    const survivorId = await this.store.resolveCanonical(tx, input.kind, survivorRef.canonicalId);
    let applied = false;

    for (const ref of input.merged) {
      const row = await this.store.findRef(tx, input.kind, ref);
      if (!row) {
        // Lineage even for a record we never saw.
        await this.store.insertRef(tx, input.kind, ref, survivorId, {
          state: 'merged',
          mergedIntoExternalId: input.survivor.id,
          firstSeenAt: input.observedAt,
          lastSeenAt: input.observedAt,
        });
        await this.store.insertChange(tx, {
          entityKind: input.kind,
          entityId: survivorId,
          changeType: 'merged',
          changedFields: ['mergedFrom'],
          ...this.change(meta, ref, undefined),
        });
        applied = true;
        continue;
      }
      // M10B plan §2.4: the shared merge rule (already merged into this survivor → nothing to do).
      if (
        decideMerge(
          { externalId: ref.id, state: row.state, mergedIntoExternalId: row.mergedIntoExternalId },
          input.survivor.id,
        ) === 'unchanged'
      ) {
        continue;
      }

      await this.store.updateRef(tx, input.kind, ref, {
        state: 'merged',
        mergedIntoExternalId: input.survivor.id,
        // M9B: `merged` supersedes `retired` (the retirement columns are set only while retired).
        ...(input.kind === 'company' ? { retiredAt: null, retiredByRunId: null } : {}),
      });
      applied = true;
      const loserId = await this.store.resolveCanonical(tx, input.kind, row.canonicalId);
      if (loserId === survivorId) {
        await this.store.insertChange(tx, {
          entityKind: input.kind,
          entityId: survivorId,
          changeType: 'merged',
          changedFields: ['refState'],
          ...this.change(meta, ref, undefined),
        });
        continue;
      }
      const otherSystems = (await this.store.refsOf(tx, input.kind, loserId)).filter(
        (r) => r.system !== ref.system,
      );
      if (otherSystems.length > 0) {
        // Never merge across systems automatically: record the question.
        await this.store.recordConflict(tx, {
          kind: 'merge_across_systems',
          entityKind: input.kind,
          identity: `${tx.tenantId}|${input.kind}|${loserId}|${survivorId}`,
          canonicalIds: [loserId, survivorId],
          externalRefs: [
            ref,
            input.survivor,
            ...otherSystems.map((r) => ({
              system: r.system as ExternalRef['system'],
              objectType: r.objectType,
              id: r.externalId,
            })),
          ],
        });
        continue;
      }
      if (input.kind === 'company') {
        // Writers of company-owned facts (e.g. subscriptions) take the same
        // lock before touching their rows: nothing can land on the loser
        // while it is being merged. Sorted, so two merges cannot deadlock.
        for (const id of [loserId, survivorId].sort()) {
          await this.store.lockKey(tx, COMPANY_CANONICAL_LOCK_SCOPE, id);
        }
      }
      await this.store.repointRefs(tx, input.kind, loserId, survivorId);
      if (input.kind === 'company') {
        for (const participant of this.mergeParticipants) {
          await participant.onCompanyMerged(tx, {
            loserId,
            survivorId,
            provenance: this.change(meta, ref, undefined),
          });
        }
        await this.store.updateCompany(
          tx,
          loserId,
          { recordState: 'merged', mergedIntoId: survivorId },
          now,
        );
      } else {
        // M10C (plan §4): the person-merge port, same transaction, before the loser is marked merged.
        for (const participant of this.personMergeParticipants) {
          await participant.onPersonMerged(tx, {
            loserId,
            survivorId,
            provenance: this.change(meta, ref, undefined),
          });
        }
        await this.store.updatePerson(
          tx,
          loserId,
          { recordState: 'merged', mergedIntoId: survivorId },
          now,
        );
      }
      await this.store.insertChange(tx, {
        entityKind: input.kind,
        entityId: loserId,
        changeType: 'merged',
        changedFields: ['recordState', 'mergedIntoId'],
        ...this.change(meta, ref, undefined),
      });
      await this.store.insertChange(tx, {
        entityKind: input.kind,
        entityId: survivorId,
        changeType: 'merged',
        changedFields: ['mergedFrom'],
        ...this.change(meta, ref, undefined),
      });
    }
    return { applied, survivorKnown: true };
  }
}

/** Held fields keep the previous accepted value (`null` when there is none). */
function withoutHeld<V extends object>(
  next: V,
  held: readonly HeldField[],
  current: Partial<V> | undefined,
): V {
  if (held.length === 0) return next;
  const out = { ...next } as Record<string, unknown>;
  for (const h of held)
    out[h.field] = (current as Record<string, unknown> | undefined)?.[h.field] ?? null;
  return out as V;
}

function withHeld(result: IngestResult, held: readonly HeldField[]): IngestResult {
  return held.length ? { ...result, held } : result;
}

function companyValues(obs: Extract<PresentObservation, { kind: 'company' }>): CompanyValues {
  return { name: obs.fields.name ?? null, domains: obs.fields.domain ? [obs.fields.domain] : [] };
}

function personValues(
  obs: Extract<PresentObservation, { kind: 'person' }>,
  companyId: string | null,
): PersonValues {
  return {
    primaryEmail: obs.fields.email ?? null,
    firstName: obs.fields.firstName ?? null,
    lastName: obs.fields.lastName ?? null,
    jobTitle: obs.fields.jobTitle ?? null,
    companyId,
  };
}

function presentFields(values: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(values)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k]) => k);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function maxDate(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
