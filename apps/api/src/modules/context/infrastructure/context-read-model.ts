import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ContextKind, ExternalSystem } from '../../domain';
import { tenantClient, type TenantTransaction } from '../../tenancy';

const h = (v: unknown) =>
  v === null || v === undefined
    ? '-'
    : createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : '-');

/**
 * Read-only views of canonical context for reports, `context:show` and the
 * state hash. Values are hashed or omitted: reports never print names or
 * emails (the canonical row is the only place they live).
 */
@Injectable()
export class ContextReadModel {
  async counts(tx: TenantTransaction): Promise<Record<string, unknown>> {
    const db = tenantClient(tx);
    const companies = await db.company.groupBy({
      by: ['recordState'],
      where: { tenantId: tx.tenantId },
      _count: { _all: true },
      orderBy: { recordState: 'asc' },
    });
    const persons = await db.person.groupBy({
      by: ['recordState'],
      where: { tenantId: tx.tenantId },
      _count: { _all: true },
      orderBy: { recordState: 'asc' },
    });
    const companyRefs = await db.companyExternalRef.groupBy({
      by: ['state'],
      where: { tenantId: tx.tenantId },
      _count: { _all: true },
      orderBy: { state: 'asc' },
    });
    const personRefs = await db.personExternalRef.groupBy({
      by: ['state'],
      where: { tenantId: tx.tenantId },
      _count: { _all: true },
      orderBy: { state: 'asc' },
    });
    const conflicts = await db.tenantIdentityConflict.groupBy({
      by: ['kind', 'state'],
      where: { tenantId: tx.tenantId },
      _count: { _all: true },
      orderBy: [{ kind: 'asc' }, { state: 'asc' }],
    });
    const changes = await db.tenantContextChange.groupBy({
      by: ['cause', 'changeType'],
      where: { tenantId: tx.tenantId },
      _count: { _all: true },
      orderBy: [{ cause: 'asc' }, { changeType: 'asc' }],
    });
    const tally = (rows: { _count: { _all: number } }[], key: (r: never) => string) =>
      Object.fromEntries(rows.map((r) => [key(r as never), r._count._all]));
    return {
      companies: tally(companies, (r: { recordState: string }) => r.recordState),
      persons: tally(persons, (r: { recordState: string }) => r.recordState),
      companyRefs: tally(companyRefs, (r: { state: string }) => r.state),
      personRefs: tally(personRefs, (r: { state: string }) => r.state),
      identityConflicts: tally(
        conflicts,
        (r: { kind: string; state: string }) => `${r.kind}:${r.state}`,
      ),
      provenance: tally(
        changes,
        (r: { cause: string; changeType: string }) => `${r.cause}:${r.changeType}`,
      ),
    };
  }

  /** One canonical record behind a source reference: ids, states, field names and times. */
  async show(
    tx: TenantTransaction,
    kind: ContextKind,
    ref: { system: ExternalSystem; objectType: string; id: string },
  ): Promise<Record<string, unknown> | undefined> {
    const db = tenantClient(tx);
    const where = {
      tenantId: tx.tenantId,
      system: ref.system,
      objectType: ref.objectType,
      externalId: ref.id,
    };
    const link =
      kind === 'company'
        ? await db.companyExternalRef.findFirst({ where })
        : await db.personExternalRef.findFirst({ where });
    if (!link) return undefined;
    const id =
      kind === 'company'
        ? (link as { companyId: string }).companyId
        : (link as { personId: string }).personId;
    const record =
      kind === 'company'
        ? await db.company.findFirstOrThrow({ where: { tenantId: tx.tenantId, id } })
        : await db.person.findFirstOrThrow({ where: { tenantId: tx.tenantId, id } });
    const refs =
      kind === 'company'
        ? await db.companyExternalRef.findMany({ where: { tenantId: tx.tenantId, companyId: id } })
        : await db.personExternalRef.findMany({ where: { tenantId: tx.tenantId, personId: id } });
    const changes = await db.tenantContextChange.findMany({
      where: { tenantId: tx.tenantId, entityKind: kind, entityId: id },
      orderBy: { ingestedAt: 'asc' },
      take: 100,
    });
    const r = record as Record<string, unknown>;
    return {
      canonicalId: id,
      kind,
      recordState: r.recordState,
      mergedIntoId: r.mergedIntoId ?? null,
      // Which fields hold a value (never the value itself).
      fieldsPresent: Object.entries(r)
        .filter(
          ([k, v]) =>
            [
              'name',
              'domains',
              'primaryEmail',
              'firstName',
              'lastName',
              'jobTitle',
              'companyId',
            ].includes(k) &&
            v !== null &&
            !(Array.isArray(v) && v.length === 0),
        )
        .map(([k]) => k),
      references: refs.map((x) => ({
        system: x.system,
        objectType: x.objectType,
        externalId: x.externalId,
        state: x.state,
        mergedIntoExternalId: x.mergedIntoExternalId,
        firstSeenAt: x.firstSeenAt,
        lastSeenAt: x.lastSeenAt,
        sourceUpdatedAt: x.sourceUpdatedAt,
        deletedAt: x.deletedAt,
      })),
      provenance: changes.map((c) => ({
        changeType: c.changeType,
        changedFields: c.changedFields,
        source: `${c.sourceSystem}:${c.sourceObjectType}:${c.sourceRecordId}`,
        cause: c.cause,
        receiptDeliveryKey: c.receiptDeliveryKey,
        checkpointId: c.checkpointId,
        sourceUpdatedAt: c.sourceUpdatedAt,
        ingestedAt: c.ingestedAt,
        adapter: `${c.adapter}@${c.adapterVersion}`,
        correlationId: c.correlationId,
      })),
    };
  }

  /**
   * Canonical state as sorted lines (values hashed): equal after any number
   * of idempotent replays. Read times (`last_seen_at`) are excluded: an
   * unchanged re-read only moves them.
   */
  async hashRows(tx: TenantTransaction): Promise<Record<string, string[]>> {
    const db = tenantClient(tx);
    const t = tx.tenantId;
    const companies = await db.company.findMany({ where: { tenantId: t }, orderBy: { id: 'asc' } });
    const persons = await db.person.findMany({ where: { tenantId: t }, orderBy: { id: 'asc' } });
    const crefs = await db.companyExternalRef.findMany({
      where: { tenantId: t },
      orderBy: [{ system: 'asc' }, { objectType: 'asc' }, { externalId: 'asc' }],
    });
    const prefs = await db.personExternalRef.findMany({
      where: { tenantId: t },
      orderBy: [{ system: 'asc' }, { objectType: 'asc' }, { externalId: 'asc' }],
    });
    const rels = await db.tenantSourceRelationship.findMany({
      where: { tenantId: t },
      orderBy: [{ fromExternalId: 'asc' }, { toExternalId: 'asc' }, { associationTypeId: 'asc' }],
    });
    const conflicts = await db.tenantIdentityConflict.findMany({
      where: { tenantId: t },
      orderBy: { conflictKey: 'asc' },
    });
    return {
      companies: companies.map((c) =>
        [c.id, h(c.name), h(c.domains), c.recordState, c.mergedIntoId ?? '-'].join('|'),
      ),
      persons: persons.map((p) =>
        [
          p.id,
          h(p.primaryEmail),
          h([p.firstName, p.lastName, p.jobTitle]),
          p.companyId ?? '-',
          p.recordState,
          p.mergedIntoId ?? '-',
        ].join('|'),
      ),
      companyRefs: crefs.map((r) =>
        [
          r.system,
          r.objectType,
          r.externalId,
          r.companyId,
          r.state,
          r.mergedIntoExternalId ?? '-',
          r.fieldHash ?? '-',
          iso(r.sourceUpdatedAt),
          iso(r.deletedAt),
        ].join('|'),
      ),
      personRefs: prefs.map((r) =>
        [
          r.system,
          r.objectType,
          r.externalId,
          r.personId,
          r.state,
          r.mergedIntoExternalId ?? '-',
          r.fieldHash ?? '-',
          iso(r.sourceUpdatedAt),
          iso(r.deletedAt),
        ].join('|'),
      ),
      relationships: rels.map((r) =>
        [
          r.system,
          r.fromObjectType,
          r.fromExternalId,
          r.toObjectType,
          r.toExternalId,
          r.associationTypeId,
          r.isPrimary,
          r.state,
        ].join('|'),
      ),
      conflicts: conflicts.map((c) =>
        [c.kind, c.conflictKey, c.canonicalIds.join(','), c.state].join('|'),
      ),
    };
  }
}
