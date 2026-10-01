import { Injectable } from '@nestjs/common';
import {
  decideApply,
  fieldHash,
  primaryCompanyLink,
  type ApplyDecision,
  type ContextKind,
  type ExternalRef,
  type PresentObservation,
  type SourceObservation,
} from '../../domain';
import { TenantDatabase, type TenantContext, type TenantTransaction } from '../../tenancy';
import { CONTEXT_ADAPTER_VERSION, type Cause } from '../jobs';
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
}

export interface IngestResult {
  readonly decision: ApplyDecision;
  readonly entityId?: string;
  /** True when a canonical change (and a provenance row) was written. */
  readonly changed: boolean;
  /** Source companies a person links to that are not known yet (read them back). */
  readonly unknownCompanies: readonly ExternalRef[];
}

export interface MergeInput {
  readonly kind: ContextKind;
  readonly survivor: ExternalRef;
  readonly merged: readonly ExternalRef[];
  readonly observedAt: Date;
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
  ) {}

  async ingest(
    ctx: TenantContext,
    observation: SourceObservation,
    meta: IngestMeta,
    options: IngestOptions = {},
  ): Promise<IngestResult> {
    const run = async (tx: TenantTransaction) => {
      const result = await this.apply(tx, observation, meta);
      await options.afterApply?.(tx, result);
      return result;
    };
    return options.within
      ? run(options.within)
      : this.db.transaction(ctx, run, { timeoutMs: TX_TIMEOUT_MS });
  }

  /** Applies a source merge: lineage from merged ids to the survivor (ADR 0014 §5). */
  async ingestMerge(
    ctx: TenantContext,
    input: MergeInput,
    meta: IngestMeta,
    afterApply?: (
      tx: TenantTransaction,
      result: { readonly applied: boolean; readonly survivorKnown: boolean },
    ) => Promise<void>,
  ): Promise<{ readonly applied: boolean; readonly survivorKnown: boolean }> {
    const run = async (tx: TenantTransaction) => {
      const result = await this.merge(tx, input, meta);
      await afterApply?.(tx, result);
      return result;
    };
    return this.db.transaction(ctx, run, { timeoutMs: TX_TIMEOUT_MS });
  }

  private change(
    meta: IngestMeta,
    source: ExternalRef,
    sourceUpdatedAt: Date | undefined,
  ): Pick<
    Parameters<ContextStore['insertChange']>[1],
    | 'source'
    | 'cause'
    | 'receiptDeliveryKey'
    | 'checkpointId'
    | 'sourceUpdatedAt'
    | 'adapter'
    | 'adapterVersion'
    | 'correlationId'
  > {
    return {
      source,
      cause: meta.cause,
      ...(meta.receiptDeliveryKey ? { receiptDeliveryKey: meta.receiptDeliveryKey } : {}),
      ...(meta.checkpointId ? { checkpointId: meta.checkpointId } : {}),
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
      adapter: source.system,
      adapterVersion: CONTEXT_ADAPTER_VERSION,
      correlationId: meta.correlationId,
    };
  }

  private async apply(
    tx: TenantTransaction,
    obs: SourceObservation,
    meta: IngestMeta,
  ): Promise<IngestResult> {
    await this.store.lockRef(tx, obs.kind, obs.ref);
    const stored = await this.store.findRef(tx, obs.kind, obs.ref);
    const decision = decideApply(stored, obs);
    const none: IngestResult = { decision, changed: false, unknownCompanies: [] };

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
          await this.afterWrite(tx, obs, id, meta);
        }
        return { ...none, entityId: stored!.canonicalId };
      }
      case 'delete':
        return this.tombstone(tx, obs, stored!, meta);
      case 'create':
        return this.create(tx, obs as PresentObservation, meta);
      case 'apply':
      case 'restore':
        return this.update(tx, obs as PresentObservation, stored!, decision, meta);
    }
  }

  private async create(
    tx: TenantTransaction,
    obs: PresentObservation,
    meta: IngestMeta,
  ): Promise<IngestResult> {
    const now = new Date();
    const unknownCompanies: ExternalRef[] = [];
    let id: string;
    let changedFields: string[];
    if (obs.kind === 'company') {
      const values = companyValues(obs);
      id = await this.store.createCompany(tx, values, now);
      changedFields = presentFields({
        name: values.name,
        domains: values.domains.length ? 1 : null,
      });
    } else {
      const companyId = await this.primaryCompanyId(tx, obs, unknownCompanies);
      const values = personValues(obs, companyId ?? null);
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
    await this.store.insertRef(tx, obs.kind, obs.ref, id, {
      state: 'active',
      firstSeenAt: obs.observedAt,
      lastSeenAt: obs.observedAt,
      sourceCreatedAt: obs.sourceCreatedAt ?? null,
      sourceUpdatedAt: obs.sourceUpdatedAt ?? null,
      fieldHash: fieldHash(obs),
      lastChangeId: changeId,
    });
    await this.afterWrite(tx, obs, id, meta);
    return { decision: 'create', entityId: id, changed: true, unknownCompanies };
  }

  private async update(
    tx: TenantTransaction,
    obs: PresentObservation,
    stored: RefRow,
    decision: 'apply' | 'restore',
    meta: IngestMeta,
  ): Promise<IngestResult> {
    const now = new Date();
    const id = await this.store.resolveCanonical(tx, obs.kind, stored.canonicalId);
    const unknownCompanies: ExternalRef[] = [];
    const changedFields: string[] = [];
    let recordStateBefore: string;

    if (obs.kind === 'company') {
      const current = await this.store.getCompany(tx, id);
      recordStateBefore = current.recordState;
      const next = companyValues(obs);
      if (current.values.name !== next.name) changedFields.push('name');
      if (!sameList(current.values.domains, next.domains)) changedFields.push('domains');
      if (changedFields.length) await this.store.updateCompany(tx, id, next, now);
    } else {
      const current = await this.store.getPerson(tx, id);
      recordStateBefore = current.recordState;
      const companyId =
        obs.companyLinks === undefined
          ? current.values.companyId
          : ((await this.primaryCompanyId(tx, obs, unknownCompanies)) ?? null);
      const next = personValues(obs, companyId);
      for (const k of Object.keys(next) as (keyof PersonValues)[]) {
        if (current.values[k] !== next[k]) changedFields.push(k);
      }
      if (changedFields.length) await this.store.updatePerson(tx, id, next, now);
    }

    await this.store.updateRef(tx, obs.kind, obs.ref, {
      state: 'active',
      deletedAt: null,
      sourceCreatedAt: obs.sourceCreatedAt ?? stored.sourceCreatedAt ?? null,
      sourceUpdatedAt: obs.sourceUpdatedAt ?? stored.sourceUpdatedAt ?? null,
      fieldHash: fieldHash(obs),
      lastSeenAt: maxDate(stored.lastSeenAt, obs.observedAt),
    });
    if (decision === 'restore') changedFields.push('refState');
    const recordState = await this.recomputeRecordState(tx, obs.kind, id, recordStateBefore, now);
    if (recordState) changedFields.push('recordState');
    const linksChanged = await this.afterWrite(tx, obs, id, meta);

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
    tx: TenantTransaction,
    obs: PresentObservation,
    id: string,
    meta: IngestMeta,
  ): Promise<boolean> {
    if (obs.kind === 'person') {
      let changed = false;
      if (obs.companyLinks) {
        changed = await this.store.replacePersonLinks(
          tx,
          obs.ref,
          obs.companyLinks,
          obs.observedAt,
        );
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
    return false;
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
      if (row.state === 'merged' && row.mergedIntoExternalId === input.survivor.id) continue;

      await this.store.updateRef(tx, input.kind, ref, {
        state: 'merged',
        mergedIntoExternalId: input.survivor.id,
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
      await this.store.repointRefs(tx, input.kind, loserId, survivorId);
      if (input.kind === 'company') {
        await this.store.updateCompany(
          tx,
          loserId,
          { recordState: 'merged', mergedIntoId: survivorId },
          now,
        );
      } else {
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
