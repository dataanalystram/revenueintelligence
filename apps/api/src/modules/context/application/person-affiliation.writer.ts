import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  affiliationIssues,
  decideAffiliationObservation,
  normaliseRoleCodes,
  type AffiliationEndReason,
  type AffiliationFields,
  type ExternalRef,
} from '../../domain';
import { GovernanceError } from '../../governance';
import {
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  recordValueHistory,
  TenantDatabase,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import {
  AccountStructureStore,
  type AffiliationRow,
} from '../infrastructure/account-structure.store';
import type {
  CompanyMerge,
  CompanyMergeParticipant,
  PersonMerge,
  PersonMergeParticipant,
} from '../merge-participants';
import {
  accountStructureEnabled,
  operatorProvenance,
  requireAccountStructure,
  requireReason,
  requireUuid,
  type StructureProvenance,
} from './account-structure.shared';

/** One stated affiliation, its company already a source reference. */
export interface ObservedAffiliation {
  readonly company: ExternalRef;
  readonly fields: AffiliationFields;
}

export interface AffiliationObservation {
  readonly personId: string;
  readonly personRef: ExternalRef;
  /** Links / affiliations the authoritative observation states now. */
  readonly present: readonly ObservedAffiliation[];
  /** Links an authoritative observation removed (became `removed` in this observation). */
  readonly removed: readonly ExternalRef[];
  readonly observedAt: Date;
  readonly provenance: StructureProvenance;
  /**
   * The late-company path (plan §3.2): create a missing affiliation only; an
   * existing row's fields are never overwritten from the link alone.
   */
  readonly createOnly?: boolean;
}

export interface AffiliationObservationOutcome {
  readonly created: number;
  readonly updated: number;
  readonly ended: number;
  readonly unresolved: number;
  /**
   * Source statements an operator decision overrode, left unapplied: an active
   * `human` row (whether the source agrees or not; never changed by a source),
   * or an operator ending not yet released (review M6, n5).
   */
  readonly humanRows: number;
}

export interface OperatorAffiliationAdd {
  readonly personId: string;
  readonly companyId: string;
  readonly roleCodes?: readonly string[];
  readonly startsAt?: Date;
  readonly endsAt?: Date;
  readonly reason: string;
}

/** Hands an operator-ended (person, company) pair back to the source (review M6). */
export interface OperatorAffiliationRelease {
  readonly personId: string;
  readonly companyId: string;
  readonly reason: string;
}

export interface OperatorAffiliationEnd {
  readonly affiliationId: string;
  readonly endsAt?: Date;
  readonly reason: string;
}

export interface AffiliationWritten {
  readonly affiliationId: string;
  readonly personId: string;
  readonly companyId: string;
  readonly status: string;
  readonly changed: boolean;
}

/** SHA-256 of an affiliation's fields (idempotency only; never a value). */
export function affiliationFieldHash(f: {
  readonly roleCodes: readonly string[];
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        normaliseRoleCodes(f.roleCodes),
        f.startsAt?.toISOString() ?? null,
        f.endsAt?.toISOString() ?? null,
      ]),
    )
    .digest('hex');
}

const issueIdentity = (tenantId: string, personId: string, company: ExternalRef) =>
  `${tenantId}|affiliation|${personId}|${company.system}:${company.objectType}:${company.id}`;

/**
 * The single writer of `tenant_person_affiliations` (M10C plan §3.3, ADR 0029).
 * Affiliations are created, updated and ended; never deleted, never re-pointed
 * (endpoints and origin are immutable; a merge ends the loser row and inserts
 * or reuses a survivor row). One active row per (person, company), enforced by
 * the guard trigger. Nothing is inferred: no affiliation is created or ended
 * from an email domain, an email's absence, or a record's disappearance — only
 * from an authoritative statement, a stated end date, an operator or a merge.
 * History rows are value-free (the fields are personal, Q15).
 */
@Injectable()
export class PersonAffiliationWriter {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: AccountStructureStore,
    readonly audit: AuditTrail,
  ) {}

  /**
   * Projects one authoritative person observation (company links or the
   * `person.affiliation` target) inside the ingestion transaction. Below
   * canonical 0.3 nothing is written.
   */
  async observe(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: AffiliationObservation,
  ): Promise<AffiliationObservationOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('affiliation tenant does not match the transaction tenant');
    }
    const out = { created: 0, updated: 0, ended: 0, unresolved: 0, humanRows: 0 };
    if (!(await accountStructureEnabled(tx))) return out;
    const person = await this.store.person(tx, input.personId);
    if (!person || person.recordState === 'merged') return out;

    // One statement per company (the last wins: `person.affiliation` fields after plain links);
    // a company still stated is never ended by another link's removal.
    const byCompany = new Map<string, ObservedAffiliation>();
    for (const p of input.present) byCompany.set(refKey(p.company), p);
    const stated = [...byCompany.values()];
    const removed = input.removed.filter((r) => !byCompany.has(refKey(r)));
    const companies = new Map<string, string>();
    for (const ref of [...stated.map((p) => p.company), ...removed]) {
      const id = await this.store.companyIdForRef(tx, ref);
      if (id) companies.set(refKey(ref), id);
    }
    await this.store.lockEntities(tx, [
      ...[...companies.values()].map((id) => ({ kind: 'company' as const, id })),
      { kind: 'person' as const, id: input.personId },
    ]);

    for (const p of stated) {
      let companyId = companies.get(refKey(p.company));
      if (companyId) companyId = await this.store.resolveCompany(tx, companyId);
      if (!companyId) {
        out.unresolved += 1;
        await this.store.recordIssue(tx, {
          kind: 'affiliation_endpoint_unresolved',
          entityKind: 'person',
          identity: issueIdentity(tx.tenantId, input.personId, p.company),
          canonicalIds: [input.personId],
          externalRefs: [input.personRef, p.company],
        });
        continue;
      }
      if (affiliationIssues(p.fields).length > 0) continue;
      const result = await this.applyObserved(tx, input, companyId, {
        kind: 'present',
        fields: p.fields,
      });
      if (result !== 'unchanged') out[result] += 1;
      await this.store.resolveIssues(tx, [
        {
          kind: 'affiliation_endpoint_unresolved',
          identity: issueIdentity(tx.tenantId, input.personId, p.company),
        },
      ]);
    }
    for (const ref of removed) {
      const known = companies.get(refKey(ref));
      if (!known) continue; // never seen as a company: nothing to end
      const companyId = await this.store.resolveCompany(tx, known);
      const result = await this.applyObserved(tx, input, companyId, { kind: 'removed' });
      if (result !== 'unchanged') out[result] += 1;
    }
    return out;
  }

  private async applyObserved(
    tx: TenantTransaction,
    input: AffiliationObservation,
    companyId: string,
    observed: { kind: 'present'; fields: AffiliationFields } | { kind: 'removed' },
  ): Promise<'created' | 'updated' | 'ended' | 'humanRows' | 'unresolved' | 'unchanged'> {
    const company = await this.store.company(tx, companyId);
    if (!company || company.recordState === 'merged') return 'unresolved';
    const active = await this.store.activeAffiliation(tx, input.personId, companyId);
    const decision = decideAffiliationObservation(active, observed, input.observedAt);
    if (input.createOnly && decision.outcome !== 'create') return 'unchanged';
    // Human overrides win (CLAUDE.md, review M6): an operator ending stands until an
    // operator releases the pair; the source does not re-create it meanwhile.
    if (
      decision.outcome === 'create' &&
      (await this.store.operatorEndingStands(tx, input.personId, companyId))
    ) {
      return 'humanRows';
    }
    switch (decision.outcome) {
      case 'unchanged':
        return 'unchanged';
      case 'human_row':
        return 'humanRows';
      case 'create': {
        const f = (observed as { fields: AffiliationFields }).fields;
        await this.create(tx, {
          personId: input.personId,
          companyId,
          fields: f,
          origin: 'source_provided',
          provenance: input.provenance,
          effectiveAt: input.observedAt,
        });
        return 'created';
      }
      case 'update': {
        const f = (observed as { fields: AffiliationFields }).fields;
        await this.update(tx, active!, f, input.provenance, input.observedAt);
        return 'updated';
      }
      case 'end':
        await this.endRow(tx, active!, {
          status: 'ended',
          reason: decision.reason,
          endedAt: input.observedAt,
          ...(decision.reason === 'source_end_date' && observed.kind === 'present'
            ? { endsAt: observed.fields.endsAt ?? null }
            : {}),
          provenance: input.provenance,
        });
        return 'ended';
    }
  }

  // --- Operator entry (plan §3.2; canonical.human_entry) ---------------------------

  @AuditFailures('person.affiliation.add', 'person_affiliation')
  async add(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorAffiliationAdd,
  ): Promise<AffiliationWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const personId = requireUuid(input.personId, '--person');
    const companyId = requireUuid(input.companyId, '--company');
    const reason = requireReason(input.reason);
    const fields: AffiliationFields = {
      roleCodes: normaliseRoleCodes(input.roleCodes ?? []),
      ...(input.startsAt ? { startsAt: input.startsAt } : {}),
      ...(input.endsAt ? { endsAt: input.endsAt } : {}),
    };
    const issues = affiliationIssues(fields);
    if (issues.includes('affiliation_period_invalid')) {
      throw new GovernanceError('affiliation_period_invalid', 'The period ends before it starts');
    }
    if (issues.length > 0) {
      throw new GovernanceError(
        'validation_failed',
        'Role codes are identifiers (^[a-z0-9_]{1,64}$), at most ten, without repeats',
      );
    }
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireAccountStructure(tx);
      await this.store.lockEntities(tx, [
        { kind: 'company', id: companyId },
        { kind: 'person', id: personId },
      ]);
      const person = await this.store.person(tx, personId);
      const company = await this.store.company(tx, companyId);
      if (
        !person ||
        !company ||
        person.recordState === 'merged' ||
        company.recordState === 'merged'
      ) {
        throw new GovernanceError(
          'affiliation_endpoint_not_allowed',
          'The person and the company must exist and not be merged',
        );
      }
      const provenance = operatorProvenance(actx.actor, actx.correlationId, personId);
      const effectiveAt = new Date();
      const active = await this.store.activeAffiliation(tx, personId, companyId);
      let id: string;
      let changed = true;
      if (active?.origin === 'human') {
        // The operator's own row: its fields are updated in place.
        id = active.id;
        changed = affiliationFieldHash(active) !== affiliationFieldHash(fields);
        if (changed) await this.update(tx, active, fields, provenance, effectiveAt);
      } else {
        if (active) {
          // A source row is ended by the operator, then the operator's row is created (origin is immutable).
          await this.endRow(tx, active, {
            status: 'ended',
            reason: 'operator',
            endedAt: effectiveAt,
            provenance,
          });
        }
        id = await this.create(tx, {
          personId,
          companyId,
          fields,
          origin: 'human',
          provenance,
          effectiveAt,
        });
      }
      await this.audit.record(tx, actx, {
        action: 'person.affiliation.add',
        targetKind: 'person_affiliation',
        targetRef: id,
        details: { reason, changed, replacedSourceRow: active?.origin === 'source_provided' },
      });
      return { affiliationId: id, personId, companyId, status: 'active', changed };
    });
  }

  @AuditFailures('person.affiliation.end', 'person_affiliation')
  async end(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorAffiliationEnd,
  ): Promise<AffiliationWritten> {
    assertAuthorized(actx, 'canonical.human_entry');
    const id = requireUuid(input.affiliationId, '--affiliation');
    const reason = requireReason(input.reason);
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireAccountStructure(tx);
      const row = await this.store.affiliation(tx, id);
      if (!row) throw new GovernanceError('validation_failed', 'No such affiliation');
      await this.store.lockEntities(tx, [
        { kind: 'company', id: row.companyId },
        { kind: 'person', id: row.personId },
      ]);
      const current = (await this.store.affiliation(tx, id))!;
      if (current.status !== 'active') {
        throw new GovernanceError('validation_failed', `The affiliation is ${current.status}`);
      }
      if (input.endsAt && current.startsAt && input.endsAt < current.startsAt) {
        throw new GovernanceError('affiliation_period_invalid', 'The period ends before it starts');
      }
      await this.endRow(tx, current, {
        status: 'ended',
        reason: 'operator',
        endedAt: new Date(),
        ...(input.endsAt ? { endsAt: input.endsAt } : {}),
        provenance: operatorProvenance(actx.actor, actx.correlationId, current.personId),
      });
      await this.audit.record(tx, actx, {
        action: 'person.affiliation.end',
        targetKind: 'person_affiliation',
        targetRef: id,
        details: { reason },
      });
      return {
        affiliationId: id,
        personId: current.personId,
        companyId: current.companyId,
        status: 'ended',
        changed: true,
      };
    });
  }

  /**
   * Hands an operator-ended (person, company) pair back to the source (review
   * M6): the standing operator endings are marked released, so the next
   * authoritative statement of the link may create a `source_provided` row
   * again. Nothing else changes; refused when no operator ending stands.
   */
  @AuditFailures('person.affiliation.release', 'person_affiliation')
  async release(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorAffiliationRelease,
  ): Promise<{
    readonly personId: string;
    readonly companyId: string;
    readonly released: readonly string[];
  }> {
    assertAuthorized(actx, 'canonical.human_entry');
    const personId = requireUuid(input.personId, '--person');
    const companyId = requireUuid(input.companyId, '--company');
    const reason = requireReason(input.reason);
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireAccountStructure(tx);
      await this.store.lockEntities(tx, [
        { kind: 'company', id: companyId },
        { kind: 'person', id: personId },
      ]);
      const released = await this.store.releaseOperatorEndings(tx, personId, companyId, new Date());
      if (released.length === 0) {
        throw new GovernanceError(
          'validation_failed',
          'No operator ending stands for this person and company',
        );
      }
      await this.audit.record(tx, actx, {
        action: 'person.affiliation.release',
        targetKind: 'person_affiliation',
        targetRef: released.at(-1)!,
        details: { reason, released: released.length },
      });
      return { personId, companyId, released };
    });
  }

  // --- Merge (plan §4, Q13) ---------------------------------------------------------

  /** Company merge: each active loser-company row ends `merged` into a survivor-company row. */
  async onCompanyMerged(tx: TenantTransaction, merge: CompanyMerge): Promise<void> {
    const rows = await this.store.affiliationsOf(tx, {
      companyId: merge.loserId,
      activeOnly: true,
    });
    for (const row of rows) {
      await this.moveRow(
        tx,
        row,
        { personId: row.personId, companyId: merge.survivorId },
        'company_merged',
        {
          ...merge.provenance,
        },
      );
    }
  }

  /** Person merge: each active loser-person row ends `merged` into a survivor-person row. */
  async onPersonMerged(tx: TenantTransaction, merge: PersonMerge): Promise<void> {
    const rows = await this.store.affiliationsOf(tx, { personId: merge.loserId, activeOnly: true });
    if (rows.length === 0) return;
    await this.store.lockEntities(tx, [
      ...rows.map((r) => ({ kind: 'company' as const, id: r.companyId })),
      { kind: 'person' as const, id: merge.loserId },
      { kind: 'person' as const, id: merge.survivorId },
    ]);
    for (const row of rows) {
      await this.moveRow(
        tx,
        row,
        { personId: merge.survivorId, companyId: row.companyId },
        'person_merged',
        {
          ...merge.provenance,
        },
      );
    }
  }

  private async moveRow(
    tx: TenantTransaction,
    row: AffiliationRow,
    to: { readonly personId: string; readonly companyId: string },
    reason: 'company_merged' | 'person_merged',
    provenance: StructureProvenance,
  ): Promise<void> {
    const effectiveAt = provenance.sourceUpdatedAt ?? new Date();
    const existing = await this.store.activeAffiliation(tx, to.personId, to.companyId);
    const targetId =
      existing?.id ??
      (await this.create(tx, {
        personId: to.personId,
        companyId: to.companyId,
        fields: {
          roleCodes: row.roleCodes,
          ...(row.startsAt ? { startsAt: row.startsAt } : {}),
          ...(row.endsAt ? { endsAt: row.endsAt } : {}),
        },
        origin: row.origin,
        provenance,
        effectiveAt,
      }));
    await this.endRow(tx, row, {
      status: 'merged',
      reason,
      endedAt: effectiveAt,
      mergedIntoId: targetId,
      provenance,
    });
  }

  // --- Row writes: projection, change record, value-free history -----------------

  private async create(
    tx: TenantTransaction,
    input: {
      readonly personId: string;
      readonly companyId: string;
      readonly fields: AffiliationFields;
      readonly origin: 'source_provided' | 'human';
      readonly provenance: StructureProvenance;
      readonly effectiveAt: Date;
    },
  ): Promise<string> {
    const roleCodes = normaliseRoleCodes(input.fields.roleCodes);
    const id = await this.store.insertAffiliation(tx, {
      personId: input.personId,
      companyId: input.companyId,
      roleCodes,
      startsAt: input.fields.startsAt ?? null,
      endsAt: input.fields.endsAt ?? null,
      origin: input.origin,
      fieldHash: affiliationFieldHash(input.fields),
    });
    const changeId = await this.store.insertChange(tx, {
      entityKind: 'person_affiliation',
      entityId: id,
      changeType: 'created',
      changedFields: ['status', 'roleCodes', 'startsAt', 'endsAt'],
      ...input.provenance,
    });
    await this.store.setAffiliationChange(tx, id, changeId);
    await this.history(tx, id, changeId, input.effectiveAt, input.provenance, [
      { field: 'status', oldValue: null, newValue: 'active' },
      ...(roleCodes.length ? [{ field: 'role_codes', oldValue: null, newValue: roleCodes }] : []),
      ...(input.fields.startsAt
        ? [{ field: 'starts_at', oldValue: null, newValue: input.fields.startsAt }]
        : []),
      ...(input.fields.endsAt
        ? [{ field: 'ends_at', oldValue: null, newValue: input.fields.endsAt }]
        : []),
    ]);
    return id;
  }

  private async update(
    tx: TenantTransaction,
    row: AffiliationRow,
    fields: AffiliationFields,
    provenance: StructureProvenance,
    effectiveAt: Date,
  ): Promise<void> {
    const roleCodes = normaliseRoleCodes(fields.roleCodes);
    const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];
    const changedFields: string[] = [];
    if (roleCodes.join(',') !== normaliseRoleCodes(row.roleCodes).join(',')) {
      changes.push({ field: 'role_codes', oldValue: row.roleCodes, newValue: roleCodes });
      changedFields.push('roleCodes');
    }
    const same = (a: Date | null | undefined, b: Date | null | undefined) =>
      (a?.getTime() ?? null) === (b?.getTime() ?? null);
    if (!same(row.startsAt, fields.startsAt)) {
      changes.push({
        field: 'starts_at',
        oldValue: row.startsAt,
        newValue: fields.startsAt ?? null,
      });
      changedFields.push('startsAt');
    }
    if (!same(row.endsAt, fields.endsAt)) {
      changes.push({ field: 'ends_at', oldValue: row.endsAt, newValue: fields.endsAt ?? null });
      changedFields.push('endsAt');
    }
    if (changedFields.length === 0) return;
    const changeId = await this.store.insertChange(tx, {
      entityKind: 'person_affiliation',
      entityId: row.id,
      changeType: 'updated',
      changedFields,
      ...provenance,
    });
    await this.store.updateAffiliation(tx, row.id, {
      roleCodes,
      startsAt: fields.startsAt ?? null,
      endsAt: fields.endsAt ?? null,
      fieldHash: affiliationFieldHash(fields),
      lastChangeId: changeId,
    });
    await this.history(tx, row.id, changeId, effectiveAt, provenance, changes);
  }

  private async endRow(
    tx: TenantTransaction,
    row: AffiliationRow,
    end: {
      readonly status: 'ended' | 'merged';
      readonly reason: AffiliationEndReason;
      readonly endedAt: Date;
      readonly endsAt?: Date | null;
      readonly mergedIntoId?: string;
      readonly provenance: StructureProvenance;
    },
  ): Promise<void> {
    const changeId = await this.store.insertChange(tx, {
      entityKind: 'person_affiliation',
      entityId: row.id,
      changeType: end.status === 'merged' ? 'merged' : 'state_changed',
      changedFields: end.endsAt !== undefined ? ['status', 'endsAt'] : ['status'],
      ...end.provenance,
    });
    const ended = await this.store.endAffiliation(tx, row.id, {
      status: end.status,
      reason: end.reason,
      endedAt: end.endedAt,
      ...(end.endsAt !== undefined ? { endsAt: end.endsAt } : {}),
      ...(end.mergedIntoId ? { mergedIntoId: end.mergedIntoId } : {}),
      lastChangeId: changeId,
    });
    if (!ended) throw new Error('affiliation was not active');
    await this.history(tx, row.id, changeId, end.endedAt, end.provenance, [
      { field: 'status', oldValue: 'active', newValue: end.status },
      ...(end.endsAt !== undefined
        ? [{ field: 'ends_at', oldValue: row.endsAt, newValue: end.endsAt }]
        : []),
    ]);
  }

  private async history(
    tx: TenantTransaction,
    id: string,
    changeId: string,
    effectiveAt: Date,
    provenance: StructureProvenance,
    changes: readonly { field: string; oldValue: unknown; newValue: unknown }[],
  ): Promise<void> {
    if (changes.length === 0) return;
    // Personal fields (Q15): the restricted-history rule writes value-free rows.
    await recordValueHistory(tx, {
      entityKind: 'person_affiliation',
      entityId: id,
      changeId,
      effectiveAt,
      ...(provenance.actor ? { actor: provenance.actor } : {}),
      changes,
    });
  }
}

function refKey(r: ExternalRef): string {
  return `${r.system}:${r.objectType}:${r.id}`;
}

/** The company-merge participant of the affiliations (wired by `ContextModule`, always present). */
@Injectable()
export class AffiliationCompanyMergeParticipant implements CompanyMergeParticipant {
  constructor(private readonly writer: PersonAffiliationWriter) {}

  onCompanyMerged(tx: TenantTransaction, merge: CompanyMerge): Promise<void> {
    return this.writer.onCompanyMerged(tx, merge);
  }
}

/** The person-merge participant of the affiliations (plan §4: the new person-merge port). */
@Injectable()
export class AffiliationPersonMergeParticipant implements PersonMergeParticipant {
  constructor(private readonly writer: PersonAffiliationWriter) {}

  onPersonMerged(tx: TenantTransaction, merge: PersonMerge): Promise<void> {
    return this.writer.onPersonMerged(tx, merge);
  }
}
