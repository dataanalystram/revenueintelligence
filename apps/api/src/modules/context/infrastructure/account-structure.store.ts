import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  HIERARCHY_LOCK_SCOPE,
  HIERARCHY_LOCK_VALUE,
  HIERARCHY_MAX_DEPTH_CEILING,
  type AffiliationEndReason,
  type AffiliationOrigin,
  type AffiliationStatus,
  type ContextKind,
  type IdentityConflictKind,
  type ParentCompanyOrigin,
} from '../../domain';
import { tenantAdvisoryLock, tenantClient, type TenantTransaction } from '../../tenancy';
import { COMPANY_CANONICAL_LOCK_SCOPE, PERSON_CANONICAL_LOCK_SCOPE } from '../merge-participants';
import { insertContextChange, type ChangeWrite } from './context-changes';

/**
 * Persistence for the M10C account structure (plan §2, §3): the hierarchy
 * columns of `companies` and `tenant_person_affiliations`. Used only by the
 * account-hierarchy writer, the affiliation writer and their read models.
 * Every method takes an open tenant transaction (forced RLS); every query
 * carries the tenant predicate. Identifiers only — never a name or an email.
 */

export interface CompanyNode {
  readonly id: string;
  readonly recordState: string;
  readonly parentId: string | null;
  readonly origin: ParentCompanyOrigin | null;
}

export interface AffiliationRow {
  readonly id: string;
  readonly personId: string;
  readonly companyId: string;
  readonly status: AffiliationStatus;
  readonly roleCodes: readonly string[];
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly endedAt: Date | null;
  readonly endReason: AffiliationEndReason | null;
  readonly mergedIntoId: string | null;
  readonly origin: AffiliationOrigin;
}

export interface IssueWrite {
  readonly kind: IdentityConflictKind;
  readonly entityKind: ContextKind;
  /** The identity the conflict key is derived from (identifiers only). */
  readonly identity: string;
  readonly canonicalIds: readonly string[];
  readonly externalRefs: readonly { system: string; objectType: string; id: string }[];
}

const refKey = (r: { system: string; objectType: string; id: string }) =>
  `${r.system}:${r.objectType}:${r.id}`;

function toAffiliation(r: {
  id: string;
  personId: string;
  companyId: string;
  status: string;
  roleCodes: string[];
  startsAt: Date | null;
  endsAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  mergedIntoId: string | null;
  origin: string;
}): AffiliationRow {
  return {
    id: r.id,
    personId: r.personId,
    companyId: r.companyId,
    status: r.status as AffiliationStatus,
    roleCodes: r.roleCodes,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    endedAt: r.endedAt,
    endReason: r.endReason as AffiliationEndReason | null,
    mergedIntoId: r.mergedIntoId,
    origin: r.origin as AffiliationOrigin,
  };
}

@Injectable()
export class AccountStructureStore {
  // --- Locks ------------------------------------------------------------------

  /** The per-tenant hierarchy lock — the same key the `companies_hierarchy_guard` trigger takes. */
  async lockHierarchy(tx: TenantTransaction): Promise<void> {
    await tenantAdvisoryLock(tx, HIERARCHY_LOCK_SCOPE, HIERARCHY_LOCK_VALUE);
  }

  /** The canonical company / person locks of the merge workflow, sorted (no deadlock). */
  async lockEntities(
    tx: TenantTransaction,
    entities: readonly { readonly kind: 'company' | 'person'; readonly id: string }[],
  ): Promise<void> {
    const keys = [
      ...new Set(
        entities.map(
          (e) =>
            `${e.kind === 'company' ? COMPANY_CANONICAL_LOCK_SCOPE : PERSON_CANONICAL_LOCK_SCOPE}\u0000${e.id}`,
        ),
      ),
    ].sort();
    for (const k of keys) {
      const [scope, id] = k.split('\u0000') as [string, string];
      await tenantAdvisoryLock(tx, scope, id);
    }
  }

  // --- Resolution ---------------------------------------------------------------

  /** The canonical company of a source company reference, following merges. */
  async companyIdForRef(
    tx: TenantTransaction,
    ref: { system: string; objectType: string; id: string },
  ): Promise<string | undefined> {
    const row = await tenantClient(tx).companyExternalRef.findFirst({
      where: {
        tenantId: tx.tenantId,
        system: ref.system,
        objectType: ref.objectType,
        externalId: ref.id,
      },
      select: { companyId: true },
    });
    return row ? this.resolveCompany(tx, row.companyId) : undefined;
  }

  /** The canonical person of a source person reference, following merges. */
  async personIdForRef(
    tx: TenantTransaction,
    ref: { system: string; objectType: string; id: string },
  ): Promise<string | undefined> {
    const row = await tenantClient(tx).personExternalRef.findFirst({
      where: {
        tenantId: tx.tenantId,
        system: ref.system,
        objectType: ref.objectType,
        externalId: ref.id,
      },
      select: { personId: true },
    });
    if (!row) return undefined;
    let current = row.personId;
    for (let hops = 0; hops < 20; hops += 1) {
      const p = await tenantClient(tx).person.findFirst({
        where: { tenantId: tx.tenantId, id: current },
        select: { recordState: true, mergedIntoId: true },
      });
      if (!p || p.recordState !== 'merged' || !p.mergedIntoId) return current;
      current = p.mergedIntoId;
    }
    throw new Error('merge lineage too deep');
  }

  async resolveCompany(tx: TenantTransaction, id: string): Promise<string> {
    let current = id;
    for (let hops = 0; hops < 20; hops += 1) {
      const c = await tenantClient(tx).company.findFirst({
        where: { tenantId: tx.tenantId, id: current },
        select: { recordState: true, mergedIntoId: true },
      });
      if (!c || c.recordState !== 'merged' || !c.mergedIntoId) return current;
      current = c.mergedIntoId;
    }
    throw new Error('merge lineage too deep');
  }

  // --- Hierarchy ----------------------------------------------------------------

  async company(tx: TenantTransaction, id: string): Promise<CompanyNode | undefined> {
    const c = await tenantClient(tx).company.findFirst({
      where: { tenantId: tx.tenantId, id },
      select: { id: true, recordState: true, parentCompanyId: true, parentCompanyOrigin: true },
    });
    return c
      ? {
          id: c.id,
          recordState: c.recordState,
          parentId: c.parentCompanyId,
          origin: c.parentCompanyOrigin as ParentCompanyOrigin | null,
        }
      : undefined;
  }

  async person(
    tx: TenantTransaction,
    id: string,
  ): Promise<{ id: string; recordState: string; companyId: string | null } | undefined> {
    const p = await tenantClient(tx).person.findFirst({
      where: { tenantId: tx.tenantId, id },
      select: { id: true, recordState: true, companyId: true },
    });
    return p ?? undefined;
  }

  /**
   * The ancestor path from `id` upwards: `[id, parent, …, root]`, at most
   * `limit + 1` nodes. `truncated` when the walk stopped before a root (a
   * deeper tree, or a cycle planted around the trigger).
   */
  async path(
    tx: TenantTransaction,
    id: string,
    limit = HIERARCHY_MAX_DEPTH_CEILING,
  ): Promise<{ readonly path: string[]; readonly truncated: boolean }> {
    const rows = await tenantClient(tx).$queryRaw<
      { id: string; parent: string | null; n: number }[]
    >`
      WITH RECURSIVE up (id, parent, n) AS (
        SELECT c.id, c.parent_company_id, 0 FROM companies c
         WHERE c.tenant_id = ${tx.tenantId}::uuid AND c.id = ${id}::uuid
        UNION ALL
        SELECT c.id, c.parent_company_id, up.n + 1 FROM up
          JOIN companies c ON c.tenant_id = ${tx.tenantId}::uuid AND c.id = up.parent
         WHERE up.n < ${limit}
      )
      SELECT id::text AS id, parent::text AS parent, n FROM up ORDER BY n`;
    const path = rows.map((r) => r.id);
    const last = rows[rows.length - 1];
    return { path, truncated: last !== undefined && last.parent !== null };
  }

  /** Height of the subtree below `id` (0 = no children), bounded by `limit`. */
  async subtreeHeight(
    tx: TenantTransaction,
    id: string,
    limit = HIERARCHY_MAX_DEPTH_CEILING,
  ): Promise<{ readonly height: number; readonly truncated: boolean }> {
    const rows = await tenantClient(tx).$queryRaw<{ height: number | null }[]>`
      WITH RECURSIVE down (id, n) AS (
        SELECT c.id, 0 FROM companies c WHERE c.tenant_id = ${tx.tenantId}::uuid AND c.id = ${id}::uuid
        UNION ALL
        SELECT c.id, down.n + 1 FROM down
          JOIN companies c ON c.tenant_id = ${tx.tenantId}::uuid AND c.parent_company_id = down.id
         WHERE down.n < ${limit} AND c.record_state <> 'merged'
      )
      SELECT max(n)::int AS height FROM down`;
    const height = rows[0]?.height ?? 0;
    return { height, truncated: height >= limit };
  }

  /** Descendants of `id` with their depth below it (1 = child), bounded; merged rows excluded. */
  async descendants(
    tx: TenantTransaction,
    id: string,
    limit: number,
  ): Promise<{ id: string; parentId: string; depth: number }[]> {
    return tenantClient(tx).$queryRaw<{ id: string; parentId: string; depth: number }[]>`
      WITH RECURSIVE down (id, parent, n) AS (
        SELECT c.id, c.parent_company_id, 1 FROM companies c
         WHERE c.tenant_id = ${tx.tenantId}::uuid AND c.parent_company_id = ${id}::uuid
           AND c.record_state <> 'merged'
        UNION ALL
        SELECT c.id, c.parent_company_id, down.n + 1 FROM down
          JOIN companies c ON c.tenant_id = ${tx.tenantId}::uuid AND c.parent_company_id = down.id
         WHERE down.n < ${limit} AND c.record_state <> 'merged'
      )
      SELECT id::text AS id, parent::text AS "parentId", n AS depth FROM down ORDER BY n, id`;
  }

  /** Active (non-merged) children of a company. */
  async children(tx: TenantTransaction, id: string): Promise<string[]> {
    const rows = await tenantClient(tx).company.findMany({
      where: { tenantId: tx.tenantId, parentCompanyId: id, recordState: { not: 'merged' } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  /** Writes the parent and its origin (the trigger re-checks cycle / merged parent). */
  async setParent(
    tx: TenantTransaction,
    id: string,
    parentId: string | null,
    origin: ParentCompanyOrigin,
  ): Promise<void> {
    await tenantClient(tx).company.updateMany({
      where: { tenantId: tx.tenantId, id },
      data: { parentCompanyId: parentId, parentCompanyOrigin: origin, updatedAt: new Date() },
    });
  }

  // --- Data-quality issues (tenant_identity_conflicts, interim until M10L) --------

  static issueKey(kind: string, identity: string): string {
    return createHash('sha256').update(`${kind}|${identity}`).digest('hex');
  }

  /** Records (or re-opens) one issue per conflict key; identifiers only. */
  async recordIssue(tx: TenantTransaction, issue: IssueWrite): Promise<void> {
    const conflictKey = AccountStructureStore.issueKey(issue.kind, issue.identity);
    const canonicalIds = [...new Set(issue.canonicalIds)].sort();
    const externalRefs = [...new Set(issue.externalRefs.map(refKey))].sort();
    await tenantClient(tx).tenantIdentityConflict.upsert({
      where: { tenantId_conflictKey: { tenantId: tx.tenantId, conflictKey } },
      create: {
        tenantId: tx.tenantId,
        id: randomUUID(),
        kind: issue.kind,
        entityKind: issue.entityKind,
        conflictKey,
        canonicalIds,
        externalRefs,
      },
      update: {
        canonicalIds,
        externalRefs,
        state: 'open',
        resolvedAt: null,
        updatedAt: new Date(),
      },
    });
  }

  /** Resolves the open issues of the given kinds whose identity is one of `identities`. */
  async resolveIssues(
    tx: TenantTransaction,
    entries: readonly { readonly kind: IdentityConflictKind; readonly identity: string }[],
  ): Promise<void> {
    const keys = entries.map((e) => AccountStructureStore.issueKey(e.kind, e.identity));
    if (keys.length === 0) return;
    const now = new Date();
    await tenantClient(tx).tenantIdentityConflict.updateMany({
      where: { tenantId: tx.tenantId, conflictKey: { in: keys }, state: 'open' },
      data: { state: 'resolved', resolvedAt: now, updatedAt: now },
    });
  }

  // --- Affiliations ---------------------------------------------------------------

  async affiliation(tx: TenantTransaction, id: string): Promise<AffiliationRow | undefined> {
    const r = await tenantClient(tx).tenantPersonAffiliation.findFirst({
      where: { tenantId: tx.tenantId, id },
    });
    return r ? toAffiliation(r) : undefined;
  }

  async activeAffiliation(
    tx: TenantTransaction,
    personId: string,
    companyId: string,
  ): Promise<AffiliationRow | undefined> {
    const r = await tenantClient(tx).tenantPersonAffiliation.findFirst({
      where: { tenantId: tx.tenantId, personId, companyId, status: 'active' },
    });
    return r ? toAffiliation(r) : undefined;
  }

  async affiliationsOf(
    tx: TenantTransaction,
    where: {
      readonly personId?: string;
      readonly companyId?: string;
      readonly activeOnly?: boolean;
    },
    limit = 500,
  ): Promise<AffiliationRow[]> {
    const rows = await tenantClient(tx).tenantPersonAffiliation.findMany({
      where: {
        tenantId: tx.tenantId,
        ...(where.personId ? { personId: where.personId } : {}),
        ...(where.companyId ? { companyId: where.companyId } : {}),
        ...(where.activeOnly ? { status: 'active' } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toAffiliation);
  }

  async insertAffiliation(
    tx: TenantTransaction,
    row: {
      readonly personId: string;
      readonly companyId: string;
      readonly roleCodes: readonly string[];
      readonly startsAt: Date | null;
      readonly endsAt: Date | null;
      readonly origin: AffiliationOrigin;
      readonly fieldHash: string | null;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tenantClient(tx).tenantPersonAffiliation.create({
      data: {
        tenantId: tx.tenantId,
        id,
        personId: row.personId,
        companyId: row.companyId,
        status: 'active',
        roleCodes: [...row.roleCodes],
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        origin: row.origin,
        fieldHash: row.fieldHash,
      },
    });
    return id;
  }

  async updateAffiliation(
    tx: TenantTransaction,
    id: string,
    values: {
      readonly roleCodes?: readonly string[];
      readonly startsAt?: Date | null;
      readonly endsAt?: Date | null;
      readonly fieldHash?: string | null;
      readonly lastChangeId?: string;
    },
  ): Promise<void> {
    const { roleCodes, ...rest } = values;
    await tenantClient(tx).tenantPersonAffiliation.updateMany({
      where: { tenantId: tx.tenantId, id, status: 'active' },
      data: { ...rest, ...(roleCodes ? { roleCodes: [...roleCodes] } : {}) },
    });
  }

  /**
   * Whether an operator ending of this (person, company) pair still stands:
   * an `end_reason = 'operator'` row not yet released (review M6). A source
   * observation never re-creates such a pair until an operator releases it.
   */
  async operatorEndingStands(
    tx: TenantTransaction,
    personId: string,
    companyId: string,
  ): Promise<boolean> {
    const n = await tenantClient(tx).tenantPersonAffiliation.count({
      where: {
        tenantId: tx.tenantId,
        personId,
        companyId,
        status: 'ended',
        endReason: 'operator',
        releasedAt: null,
      },
    });
    return n > 0;
  }

  /** Releases every standing operator ending of the pair (set once); returns the released row ids. */
  async releaseOperatorEndings(
    tx: TenantTransaction,
    personId: string,
    companyId: string,
    at: Date,
  ): Promise<string[]> {
    const db = tenantClient(tx);
    const where = {
      tenantId: tx.tenantId,
      personId,
      companyId,
      status: 'ended',
      endReason: 'operator',
      releasedAt: null,
    };
    const rows = await db.tenantPersonAffiliation.findMany({
      where,
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (rows.length === 0) return [];
    await db.tenantPersonAffiliation.updateMany({ where, data: { releasedAt: at } });
    return rows.map((r) => r.id);
  }

  /** active → ended / merged (terminal). Returns whether the row was active. */
  async endAffiliation(
    tx: TenantTransaction,
    id: string,
    end: {
      readonly status: 'ended' | 'merged';
      readonly reason: AffiliationEndReason;
      readonly endedAt: Date;
      readonly endsAt?: Date | null;
      readonly mergedIntoId?: string;
      readonly lastChangeId?: string;
    },
  ): Promise<boolean> {
    const out = await tenantClient(tx).tenantPersonAffiliation.updateMany({
      where: { tenantId: tx.tenantId, id, status: 'active' },
      data: {
        status: end.status,
        endReason: end.reason,
        endedAt: end.endedAt,
        ...(end.endsAt !== undefined ? { endsAt: end.endsAt } : {}),
        ...(end.mergedIntoId ? { mergedIntoId: end.mergedIntoId } : {}),
        ...(end.lastChangeId ? { lastChangeId: end.lastChangeId } : {}),
      },
    });
    return out.count === 1;
  }

  async setAffiliationChange(tx: TenantTransaction, id: string, changeId: string): Promise<void> {
    // last_change_id is bookkeeping, allowed on terminal rows by the guard trigger.
    await tenantClient(tx).tenantPersonAffiliation.updateMany({
      where: { tenantId: tx.tenantId, id },
      data: { lastChangeId: changeId },
    });
  }

  // --- Change records -------------------------------------------------------------

  insertChange(tx: TenantTransaction, change: ChangeWrite): Promise<string> {
    return insertContextChange(tx, change);
  }
}
