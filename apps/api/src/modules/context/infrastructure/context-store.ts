import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AFFILIATION_LINK_TYPE_ID,
  type ContextKind,
  type ExternalRef,
  type ExternalRefState,
  type RecordState,
  type SourceCompanyLink,
} from '../../domain';
import { insertContextChange, type ChangeWrite } from './context-changes';
import { tenantAdvisoryLock, tenantClient, type TenantTransaction } from '../../tenancy';

/**
 * Persistence for canonical context (M6, ADR 0014). Only
 * `ContextIngestionService` may use it (dependency rule
 * `context-store-only-from-ingestion`): it is the single canonical writer.
 * Every method takes an open tenant transaction (forced RLS).
 */

export interface RefRow {
  readonly canonicalId: string;
  readonly system: string;
  readonly objectType: string;
  readonly externalId: string;
  readonly state: ExternalRefState;
  readonly mergedIntoExternalId: string | undefined;
  readonly sourceUpdatedAt: Date | undefined;
  readonly sourceCreatedAt: Date | undefined;
  readonly fieldHash: string | undefined;
  readonly deletedAt: Date | undefined;
  readonly retiredAt: Date | undefined;
  readonly lastSeenAt: Date;
  readonly firstSeenAt: Date;
}

export interface RefWrite {
  readonly state: ExternalRefState;
  readonly mergedIntoExternalId?: string | null;
  readonly sourceCreatedAt?: Date | null;
  readonly sourceUpdatedAt?: Date | null;
  readonly deletedAt?: Date | null;
  /** M9B: cleared (with the retiring run) whenever the reference becomes active again. */
  readonly retiredAt?: null;
  readonly retiredByRunId?: null;
  readonly fieldHash?: string | null;
  readonly lastSeenAt?: Date;
  readonly lastChangeId?: string | null;
}

export interface CompanyValues {
  readonly name: string | null;
  readonly domains: readonly string[];
}

export interface PersonValues {
  readonly primaryEmail: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly jobTitle: string | null;
  readonly companyId: string | null;
}

export type { ChangeWrite } from './context-changes';
export { sourceConnectionId } from './context-changes';

export interface CanonicalRow<V> {
  readonly id: string;
  readonly values: V;
  readonly recordState: RecordState;
  readonly mergedIntoId: string | undefined;
}

const refKey = (r: { system: string; objectType: string; id: string }) =>
  `${r.system}:${r.objectType}:${r.id}`;

function toRef(
  kind: ContextKind,
  r: {
    companyId?: string;
    personId?: string;
    system: string;
    objectType: string;
    externalId: string;
    state: string;
    mergedIntoExternalId: string | null;
    sourceUpdatedAt: Date | null;
    sourceCreatedAt: Date | null;
    fieldHash: string | null;
    deletedAt: Date | null;
    retiredAt?: Date | null;
    lastSeenAt: Date;
    firstSeenAt: Date;
  },
): RefRow {
  return {
    canonicalId: (kind === 'company' ? r.companyId : r.personId)!,
    system: r.system,
    objectType: r.objectType,
    externalId: r.externalId,
    state: r.state as ExternalRefState,
    mergedIntoExternalId: r.mergedIntoExternalId ?? undefined,
    sourceUpdatedAt: r.sourceUpdatedAt ?? undefined,
    sourceCreatedAt: r.sourceCreatedAt ?? undefined,
    fieldHash: r.fieldHash ?? undefined,
    deletedAt: r.deletedAt ?? undefined,
    retiredAt: r.retiredAt ?? undefined,
    lastSeenAt: r.lastSeenAt,
    firstSeenAt: r.firstSeenAt,
  };
}

@Injectable()
export class ContextStore {
  /**
   * Serialises all writers of one source record for the rest of the
   * transaction (also before the reference exists, so two concurrent creates
   * of a new record cannot both insert).
   */
  async lockRef(tx: TenantTransaction, kind: ContextKind, ref: ExternalRef): Promise<void> {
    const key = createHash('sha256')
      .update(`${tx.tenantId}|${kind}|${refKey(ref)}`)
      .digest()
      .readBigInt64BE(0);
    await tenantClient(tx).$executeRaw`SELECT pg_advisory_xact_lock(${key}::bigint)`;
  }

  /**
   * Serialises a check across records for the rest of the transaction (e.g.
   * the shared-email check). Always taken after the record lock, so lock
   * order is fixed and cannot deadlock.
   */
  async lockKey(tx: TenantTransaction, scope: string, value: string): Promise<void> {
    await tenantAdvisoryLock(tx, scope, value);
  }

  async findRef(
    tx: TenantTransaction,
    kind: ContextKind,
    ref: ExternalRef,
  ): Promise<RefRow | undefined> {
    const db = tenantClient(tx);
    const where = {
      tenantId: tx.tenantId,
      system: ref.system,
      objectType: ref.objectType,
      externalId: ref.id,
    };
    const row =
      kind === 'company'
        ? await db.companyExternalRef.findFirst({ where })
        : await db.personExternalRef.findFirst({ where });
    return row ? toRef(kind, row) : undefined;
  }

  async refsOf(tx: TenantTransaction, kind: ContextKind, canonicalId: string): Promise<RefRow[]> {
    const db = tenantClient(tx);
    const rows =
      kind === 'company'
        ? await db.companyExternalRef.findMany({
            where: { tenantId: tx.tenantId, companyId: canonicalId },
          })
        : await db.personExternalRef.findMany({
            where: { tenantId: tx.tenantId, personId: canonicalId },
          });
    return rows.map((r) => toRef(kind, r));
  }

  /**
   * M9B: active company references of one source object last read before
   * `notSeenSince` (a reference read after a run's read started is never
   * that run's candidate).
   */
  async activeCompanyRefsOf(
    tx: TenantTransaction,
    system: string,
    objectType: string,
    notSeenSince: Date,
  ): Promise<
    { readonly externalId: string; readonly canonicalId: string; readonly lastSeenAt: Date }[]
  > {
    const rows = await tenantClient(tx).companyExternalRef.findMany({
      where: {
        tenantId: tx.tenantId,
        system,
        objectType,
        state: 'active',
        lastSeenAt: { lte: notSeenSince },
      },
      select: { externalId: true, companyId: true, lastSeenAt: true },
      orderBy: { externalId: 'asc' },
    });
    return rows.map((r) => ({
      externalId: r.externalId,
      canonicalId: r.companyId,
      lastSeenAt: r.lastSeenAt,
    }));
  }

  /** M9B: `active` → `retired`, with the retiring run (no other state is touched). */
  async retireCompanyRef(
    tx: TenantTransaction,
    ref: ExternalRef,
    retiredAt: Date,
    runId: string,
  ): Promise<boolean> {
    const out = await tenantClient(tx).companyExternalRef.updateMany({
      where: {
        tenantId: tx.tenantId,
        system: ref.system,
        objectType: ref.objectType,
        externalId: ref.id,
        state: 'active',
      },
      data: { state: 'retired', retiredAt, retiredByRunId: runId },
    });
    return out.count === 1;
  }

  async insertRef(
    tx: TenantTransaction,
    kind: ContextKind,
    ref: ExternalRef,
    canonicalId: string,
    values: RefWrite & { readonly firstSeenAt: Date; readonly lastSeenAt: Date },
  ): Promise<void> {
    const db = tenantClient(tx);
    const data = {
      tenantId: tx.tenantId,
      system: ref.system,
      objectType: ref.objectType,
      externalId: ref.id,
      state: values.state,
      mergedIntoExternalId: values.mergedIntoExternalId ?? null,
      firstSeenAt: values.firstSeenAt,
      lastSeenAt: values.lastSeenAt,
      sourceCreatedAt: values.sourceCreatedAt ?? null,
      sourceUpdatedAt: values.sourceUpdatedAt ?? null,
      deletedAt: values.deletedAt ?? null,
      fieldHash: values.fieldHash ?? null,
      lastChangeId: values.lastChangeId ?? null,
    };
    if (kind === 'company') {
      await db.companyExternalRef.create({ data: { ...data, companyId: canonicalId } });
    } else {
      await db.personExternalRef.create({ data: { ...data, personId: canonicalId } });
    }
  }

  async updateRef(
    tx: TenantTransaction,
    kind: ContextKind,
    ref: ExternalRef,
    values: Partial<RefWrite> & { readonly canonicalId?: string },
  ): Promise<void> {
    const db = tenantClient(tx);
    const where = {
      tenantId: tx.tenantId,
      system: ref.system,
      objectType: ref.objectType,
      externalId: ref.id,
    };
    const { canonicalId, ...rest } = values;
    const data = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    if (kind === 'company') {
      await db.companyExternalRef.updateMany({
        where,
        data: { ...data, ...(canonicalId ? { companyId: canonicalId } : {}) },
      });
    } else {
      await db.personExternalRef.updateMany({
        where,
        data: { ...data, ...(canonicalId ? { personId: canonicalId } : {}) },
      });
    }
  }

  async getCompany(tx: TenantTransaction, id: string): Promise<CanonicalRow<CompanyValues>> {
    const c = await tenantClient(tx).company.findFirstOrThrow({
      where: { tenantId: tx.tenantId, id },
    });
    return {
      id: c.id,
      values: { name: c.name, domains: c.domains },
      recordState: c.recordState as RecordState,
      mergedIntoId: c.mergedIntoId ?? undefined,
    };
  }

  async getPerson(tx: TenantTransaction, id: string): Promise<CanonicalRow<PersonValues>> {
    const p = await tenantClient(tx).person.findFirstOrThrow({
      where: { tenantId: tx.tenantId, id },
    });
    return {
      id: p.id,
      values: {
        primaryEmail: p.primaryEmail,
        firstName: p.firstName,
        lastName: p.lastName,
        jobTitle: p.jobTitle,
        companyId: p.companyId,
      },
      recordState: p.recordState as RecordState,
      mergedIntoId: p.mergedIntoId ?? undefined,
    };
  }

  async createCompany(tx: TenantTransaction, values: CompanyValues, now: Date): Promise<string> {
    const id = randomUUID();
    await tenantClient(tx).company.create({
      data: {
        id,
        tenantId: tx.tenantId,
        name: values.name,
        domains: [...values.domains],
        createdAt: now,
        updatedAt: now,
      },
    });
    return id;
  }

  async createPerson(tx: TenantTransaction, values: PersonValues, now: Date): Promise<string> {
    const id = randomUUID();
    await tenantClient(tx).person.create({
      data: { id, tenantId: tx.tenantId, ...values, createdAt: now, updatedAt: now },
    });
    return id;
  }

  async updateCompany(
    tx: TenantTransaction,
    id: string,
    values: Partial<CompanyValues> & {
      readonly recordState?: RecordState;
      readonly mergedIntoId?: string | null;
    },
    now: Date,
  ): Promise<void> {
    const { domains, ...rest } = values;
    await tenantClient(tx).company.updateMany({
      where: { tenantId: tx.tenantId, id },
      data: { ...rest, ...(domains ? { domains: [...domains] } : {}), updatedAt: now },
    });
  }

  async updatePerson(
    tx: TenantTransaction,
    id: string,
    values: Partial<PersonValues> & {
      readonly recordState?: RecordState;
      readonly mergedIntoId?: string | null;
    },
    now: Date,
  ): Promise<void> {
    await tenantClient(tx).person.updateMany({
      where: { tenantId: tx.tenantId, id },
      data: { ...values, updatedAt: now },
    });
  }

  /** Follows merge lineage to the surviving canonical record. */
  async resolveCanonical(tx: TenantTransaction, kind: ContextKind, id: string): Promise<string> {
    let current = id;
    for (let hops = 0; hops < 20; hops += 1) {
      const row =
        kind === 'company' ? await this.getCompany(tx, current) : await this.getPerson(tx, current);
      if (row.recordState !== 'merged' || !row.mergedIntoId) return current;
      current = row.mergedIntoId;
    }
    throw new Error('merge lineage too deep');
  }

  /**
   * References that keep a canonical record active. M9B: a `retired` company
   * reference counts as active here — retirement is absence from a source
   * read, never evidence that the company itself is gone.
   */
  async activeRefCount(tx: TenantTransaction, kind: ContextKind, id: string): Promise<number> {
    const db = tenantClient(tx);
    return kind === 'company'
      ? db.companyExternalRef.count({
          where: { tenantId: tx.tenantId, companyId: id, state: { in: ['active', 'retired'] } },
        })
      : db.personExternalRef.count({
          where: { tenantId: tx.tenantId, personId: id, state: 'active' },
        });
  }

  /** The canonical company of a source company reference, following merges. */
  async companyIdForRef(tx: TenantTransaction, ref: ExternalRef): Promise<string | undefined> {
    const r = await this.findRef(tx, 'company', ref);
    return r ? this.resolveCanonical(tx, 'company', r.canonicalId) : undefined;
  }

  /**
   * Replaces a person's source company links; returns whether anything changed
   * and the company references that became `removed`. M10C: the
   * `person.affiliation` links (association type AFFILIATION_LINK_TYPE_ID) are
   * their own scope, so replacing one scope never removes the other's rows.
   */
  async replacePersonLinks(
    tx: TenantTransaction,
    person: ExternalRef,
    links: readonly SourceCompanyLink[],
    observedAt: Date,
    scope: 'company_links' | 'affiliations' = 'company_links',
  ): Promise<{ readonly changed: boolean; readonly removed: readonly ExternalRef[] }> {
    const db = tenantClient(tx);
    const base = {
      tenantId: tx.tenantId,
      system: person.system,
      fromObjectType: person.objectType,
      fromExternalId: person.id,
    };
    const inScope = (typeId: number) =>
      scope === 'affiliations'
        ? typeId === AFFILIATION_LINK_TYPE_ID
        : typeId !== AFFILIATION_LINK_TYPE_ID;
    const existing = (await db.tenantSourceRelationship.findMany({ where: base })).filter((r) =>
      inScope(r.associationTypeId),
    );
    const removed: ExternalRef[] = [];
    const key = (to: string, toType: string, typeId: number) => `${toType}:${to}:${typeId}`;
    const wanted = new Map(
      links.map((l) => [key(l.company.id, l.company.objectType, l.typeId), l] as const),
    );
    let changed = false;
    for (const row of existing) {
      const k = key(row.toExternalId, row.toObjectType, row.associationTypeId);
      if (!wanted.has(k) && row.state !== 'removed') {
        await db.tenantSourceRelationship.updateMany({
          where: {
            ...base,
            toObjectType: row.toObjectType,
            toExternalId: row.toExternalId,
            associationTypeId: row.associationTypeId,
          },
          data: { state: 'removed', lastSeenAt: observedAt, sourceObservedAt: observedAt },
        });
        removed.push({
          system: person.system,
          objectType: row.toObjectType,
          id: row.toExternalId,
        });
        changed = true;
      }
    }
    for (const [k, l] of wanted) {
      const row = existing.find(
        (e) => key(e.toExternalId, e.toObjectType, e.associationTypeId) === k,
      );
      if (!row) {
        await db.tenantSourceRelationship.create({
          data: {
            ...base,
            toObjectType: l.company.objectType,
            toExternalId: l.company.id,
            associationTypeId: l.typeId,
            category: l.category,
            isPrimary: l.primary,
            state: 'active',
            sourceObservedAt: observedAt,
            lastSeenAt: observedAt,
          },
        });
        changed = true;
      } else {
        const differs = row.state !== 'active' || row.isPrimary !== l.primary;
        await db.tenantSourceRelationship.updateMany({
          where: {
            ...base,
            toObjectType: row.toObjectType,
            toExternalId: row.toExternalId,
            associationTypeId: row.associationTypeId,
          },
          data: {
            state: 'active',
            isPrimary: l.primary,
            category: l.category,
            lastSeenAt: observedAt,
            ...(differs ? { sourceObservedAt: observedAt } : {}),
          },
        });
        changed ||= differs;
      }
    }
    return { changed, removed };
  }

  /**
   * People whose active primary source link points at this company reference
   * but whose canonical company differs (e.g. the company arrived after the
   * person). Returns their ids so the caller can link and record provenance.
   */
  async peopleAwaitingCompany(
    tx: TenantTransaction,
    company: ExternalRef,
    companyId: string,
  ): Promise<string[]> {
    const rows = await tenantClient(tx).$queryRaw<{ id: string }[]>`
      SELECT DISTINCT p.id::text AS id
        FROM tenant_source_relationships r
        JOIN person_external_refs pr
          ON pr.tenant_id = r.tenant_id AND pr.system = r.system
         AND pr.object_type = r.from_object_type AND pr.external_id = r.from_external_id
        JOIN persons p ON p.tenant_id = pr.tenant_id AND p.id = pr.person_id
       WHERE r.tenant_id = ${tx.tenantId}::uuid
         AND r.system = ${company.system}
         AND r.to_object_type = ${company.objectType}
         AND r.to_external_id = ${company.id}
         AND r.state = 'active' AND r.is_primary
         AND pr.state = 'active' AND p.record_state <> 'merged'
         AND p.company_id IS DISTINCT FROM ${companyId}::uuid`;
    return rows.map((r) => r.id);
  }

  /**
   * People with an active source link to a company reference (any association
   * type) whose canonical record is not merged: the late-company path (plan §3.2).
   */
  async peopleLinkedTo(
    tx: TenantTransaction,
    company: ExternalRef,
  ): Promise<{ personId: string; ref: ExternalRef }[]> {
    const rows = await tenantClient(tx).$queryRaw<
      { id: string; system: string; object_type: string; external_id: string }[]
    >`
      SELECT DISTINCT p.id::text AS id, pr.system, pr.object_type, pr.external_id
        FROM tenant_source_relationships r
        JOIN person_external_refs pr
          ON pr.tenant_id = r.tenant_id AND pr.system = r.system
         AND pr.object_type = r.from_object_type AND pr.external_id = r.from_external_id
        JOIN persons p ON p.tenant_id = pr.tenant_id AND p.id = pr.person_id
       WHERE r.tenant_id = ${tx.tenantId}::uuid
         AND r.system = ${company.system}
         AND r.to_object_type = ${company.objectType}
         AND r.to_external_id = ${company.id}
         AND r.state = 'active' AND pr.state = 'active' AND p.record_state <> 'merged'
       ORDER BY 1`;
    return rows.map((r) => ({
      personId: r.id,
      ref: {
        system: r.system as ExternalRef['system'],
        objectType: r.object_type,
        id: r.external_id,
      },
    }));
  }

  async personIdsWithEmail(
    tx: TenantTransaction,
    email: string,
    excludeId: string,
  ): Promise<string[]> {
    const rows = await tenantClient(tx).person.findMany({
      where: {
        tenantId: tx.tenantId,
        primaryEmail: email,
        id: { not: excludeId },
        recordState: { not: 'merged' },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  /** Records an identity question once per conflict (idempotent); never resolves it. */
  async recordConflict(
    tx: TenantTransaction,
    conflict: {
      readonly kind: 'shared_email' | 'merge_across_systems' | 'ambiguous_primary_company';
      readonly entityKind: ContextKind;
      readonly identity: string;
      readonly canonicalIds: readonly string[];
      readonly externalRefs: readonly ExternalRef[];
    },
  ): Promise<void> {
    const conflictKey = createHash('sha256')
      .update(`${conflict.kind}|${conflict.identity}`)
      .digest('hex');
    const canonicalIds = [...new Set(conflict.canonicalIds)].sort();
    const externalRefs = [...new Set(conflict.externalRefs.map(refKey))].sort();
    await tenantClient(tx).tenantIdentityConflict.upsert({
      where: { tenantId_conflictKey: { tenantId: tx.tenantId, conflictKey } },
      create: {
        tenantId: tx.tenantId,
        id: randomUUID(),
        kind: conflict.kind,
        entityKind: conflict.entityKind,
        conflictKey,
        canonicalIds,
        externalRefs,
      },
      update: { canonicalIds, externalRefs, updatedAt: new Date() },
    });
  }

  /** Moves every reference of `fromId` to `toId` (merge forward). */
  async repointRefs(
    tx: TenantTransaction,
    kind: ContextKind,
    fromId: string,
    toId: string,
  ): Promise<void> {
    const db = tenantClient(tx);
    if (kind === 'company') {
      await db.companyExternalRef.updateMany({
        where: { tenantId: tx.tenantId, companyId: fromId },
        data: { companyId: toId },
      });
      await db.person.updateMany({
        where: { tenantId: tx.tenantId, companyId: fromId },
        data: { companyId: toId },
      });
      await db.company.updateMany({
        where: { tenantId: tx.tenantId, mergedIntoId: fromId },
        data: { mergedIntoId: toId },
      });
    } else {
      await db.personExternalRef.updateMany({
        where: { tenantId: tx.tenantId, personId: fromId },
        data: { personId: toId },
      });
      await db.person.updateMany({
        where: { tenantId: tx.tenantId, mergedIntoId: fromId },
        data: { mergedIntoId: toId },
      });
    }
  }

  async insertChange(tx: TenantTransaction, change: ChangeWrite): Promise<string> {
    return insertContextChange(tx, change);
  }
}
