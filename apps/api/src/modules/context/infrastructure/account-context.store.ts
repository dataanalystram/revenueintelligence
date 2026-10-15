import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ACCOUNT_CONTEXT_MIN_VERSION,
  ACCOUNT_CONTEXT_MODULE_KEY,
  compareCanonicalVersion,
  ContextTypeDefinitionSchema,
  fieldSpecFromDefinition,
  parseExtensionValue,
  type ContextTypeDefinition,
  type IdentityConflictKind,
  type SecurityActor,
} from '../../domain';
import {
  adoptedCanonicalVersion,
  recordValueHistory,
  tenantAdvisoryLock,
  tenantClient,
  type TenantTransaction,
  type ValueChange,
} from '../../tenancy';
import type { DimensionValue } from '../application/account-context.rules';
import { COMPANY_CANONICAL_LOCK_SCOPE, PERSON_CANONICAL_LOCK_SCOPE } from '../merge-participants';
import { insertContextChange, type ChangeWrite } from './context-changes';

/**
 * Persistence of M10E AccountContext (plan §3, §4, §7, §8): contexts, person
 * and product memberships and the line's `context_id`. Used only by the
 * account-context writers, merge participant and read model. Every method
 * takes an open tenant transaction (forced RLS) and carries the tenant
 * predicate. Identifiers and codes only — never logged.
 */

export type AccountContextGateState = 'ok' | 'canonical_version_too_low' | 'module_disabled';

export interface ContextTypeEntry {
  readonly id: string;
  readonly key: string;
  readonly status: string;
  readonly definition: ContextTypeDefinition;
}

export interface AccountContextRow {
  readonly id: string;
  readonly companyId: string;
  readonly contextTypeId: string;
  readonly naturalKeyHash: string;
  readonly dimensions: Readonly<Record<string, DimensionValue>>;
  readonly name: string;
  readonly status: 'active' | 'inactive' | 'retired';
  readonly ownerRef: string | null;
  /** `YYYY-MM-DD` or null. */
  readonly renewalDate: string | null;
  readonly recordState: 'active' | 'merged';
  readonly mergedIntoId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MembershipRow {
  readonly contextId: string;
  readonly personId: string;
  readonly roleCode: string;
  readonly status: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

export interface ContextProductRow {
  readonly contextId: string;
  readonly productKey: string;
  readonly origin: string;
}

export interface ContextIssueWrite {
  readonly kind: IdentityConflictKind;
  readonly identity: string;
  readonly canonicalIds: readonly string[];
  /** `system:objectType:id` references. */
  readonly externalRefs: readonly string[];
}

type Raw = {
  id: string;
  companyId: string;
  contextTypeId: string;
  naturalKeyHash: string;
  dimensions: unknown;
  name: string;
  status: string;
  ownerRef: string | null;
  renewalDate: Date | null;
  recordState: string;
  mergedIntoId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toContextRow(r: Raw): AccountContextRow {
  return {
    id: r.id,
    companyId: r.companyId,
    contextTypeId: r.contextTypeId,
    naturalKeyHash: r.naturalKeyHash,
    dimensions: (r.dimensions ?? {}) as Record<string, DimensionValue>,
    name: r.name,
    status: r.status as AccountContextRow['status'],
    ownerRef: r.ownerRef,
    renewalDate: r.renewalDate ? r.renewalDate.toISOString().slice(0, 10) : null,
    recordState: r.recordState as AccountContextRow['recordState'],
    mergedIntoId: r.mergedIntoId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const CONTEXT_SELECT = {
  id: true,
  companyId: true,
  contextTypeId: true,
  naturalKeyHash: true,
  dimensions: true,
  name: true,
  status: true,
  ownerRef: true,
  renewalDate: true,
  recordState: true,
  mergedIntoId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const MEMBER_SELECT = {
  contextId: true,
  personId: true,
  roleCode: true,
  status: true,
  startedAt: true,
  endedAt: true,
} as const;

/** `YYYY-MM-DD` → a UTC date (the column is a DATE). */
function toDate(v: string | null): Date | null {
  return v === null ? null : new Date(`${v}T00:00:00.000Z`);
}

@Injectable()
export class AccountContextStore {
  // --- Gate (plan §10, Q17) -----------------------------------------------------

  /** Adopted ≥ 0.5 and module `account_context` enabled (no audit; callers decide). */
  async gate(tx: TenantTransaction): Promise<AccountContextGateState> {
    const adopted = await adoptedCanonicalVersion(tx);
    if (compareCanonicalVersion(adopted, ACCOUNT_CONTEXT_MIN_VERSION) < 0) {
      return 'canonical_version_too_low';
    }
    const setting = await tenantClient(tx).tenantModuleSetting.findUnique({
      where: {
        tenantId_moduleKey: { tenantId: tx.tenantId, moduleKey: ACCOUNT_CONTEXT_MODULE_KEY },
      },
      select: { enabled: true },
    });
    return setting?.enabled ? 'ok' : 'module_disabled';
  }

  // --- Registry -----------------------------------------------------------------

  /** Context types (registry kind `context_type`), by key and id. Unparseable definitions are skipped. */
  async contextTypes(tx: TenantTransaction): Promise<{
    readonly byKey: ReadonlyMap<string, ContextTypeEntry>;
    readonly byId: ReadonlyMap<string, ContextTypeEntry>;
  }> {
    const rows = await tenantClient(tx).tenantRegistryEntry.findMany({
      where: { tenantId: tx.tenantId, kind: 'context_type' },
      select: { id: true, key: true, status: true, definition: true },
    });
    const entries: ContextTypeEntry[] = [];
    for (const r of rows) {
      const parsed = ContextTypeDefinitionSchema.safeParse(r.definition);
      if (parsed.success) {
        entries.push({ id: r.id, key: r.key, status: r.status, definition: parsed.data });
      }
    }
    return {
      byKey: new Map(entries.map((e) => [e.key, e])),
      byId: new Map(entries.map((e) => [e.id, e])),
    };
  }

  /** Product key → active, for the given keys. */
  async products(tx: TenantTransaction, keys: readonly string[]): Promise<Map<string, boolean>> {
    if (keys.length === 0) return new Map();
    // Read-only existence / active check of the published product projection
    // (ADR 0016: written only by the products module; ADR 0008 config delegates
    // stay untouched here).
    const rows = await tenantClient(tx).$queryRawUnsafe<{ key: string; active: boolean }[]>(
      'SELECT key, active FROM tenant_products WHERE tenant_id = $1::uuid AND key = ANY($2::text[])',
      tx.tenantId,
      [...new Set(keys)],
    );
    return new Map(rows.map((r) => [r.key, r.active]));
  }

  /**
   * An `extension_ref` dimension parser over the tenant's active extension
   * fields (R-C4: string / enum / integer): the canonical scalar or undefined.
   */
  async extensionParser(
    tx: TenantTransaction,
    fields: readonly string[],
  ): Promise<(field: string, raw: unknown) => DimensionValue | undefined> {
    const rows = fields.length
      ? await tenantClient(tx).tenantRegistryEntry.findMany({
          where: { tenantId: tx.tenantId, kind: 'extension', key: { in: [...new Set(fields)] } },
          select: { key: true, status: true, definition: true },
        })
      : [];
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return (field, raw) => {
      const e = byKey.get(field);
      if (!e || e.status !== 'active') return undefined;
      const def = (e.definition ?? {}) as Record<string, unknown>;
      const parsed = parseExtensionValue(fieldSpecFromDefinition(field, def), raw);
      if (!parsed.ok || parsed.value.state !== 'present') return undefined;
      const v = parsed.value;
      if (v.type === 'integer' && v.number !== undefined) return Number(v.number);
      if (v.type === 'enum' && v.enumCode !== undefined) return v.enumCode;
      if (v.type === 'string' && v.text !== undefined) return v.text;
      return undefined;
    };
  }

  // --- Locks (review M1: lock before the not-merged check; sorted order) ---------

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

  // --- Entities -----------------------------------------------------------------

  /**
   * M10E 2b: the canonical company / person a source reference names,
   * following merge lineage (undefined when the reference is unknown).
   */
  async canonicalForRef(
    tx: TenantTransaction,
    kind: 'company' | 'person',
    ref: { system: string; objectType: string; id: string },
  ): Promise<string | undefined> {
    const db = tenantClient(tx);
    const where = {
      tenantId: tx.tenantId,
      system: ref.system,
      objectType: ref.objectType,
      externalId: ref.id,
    };
    let id =
      kind === 'company'
        ? (await db.companyExternalRef.findFirst({ where, select: { companyId: true } }))?.companyId
        : (await db.personExternalRef.findFirst({ where, select: { personId: true } }))?.personId;
    for (let hops = 0; id && hops < 20; hops += 1) {
      const row =
        kind === 'company'
          ? await db.company.findFirst({
              where: { tenantId: tx.tenantId, id },
              select: { recordState: true, mergedIntoId: true },
            })
          : await db.person.findFirst({
              where: { tenantId: tx.tenantId, id },
              select: { recordState: true, mergedIntoId: true },
            });
      if (!row || row.recordState !== 'merged' || !row.mergedIntoId) return id;
      id = row.mergedIntoId;
    }
    return id;
  }

  async company(
    tx: TenantTransaction,
    id: string,
  ): Promise<{ readonly recordState: string } | undefined> {
    const r = await tenantClient(tx).company.findFirst({
      where: { tenantId: tx.tenantId, id },
      select: { recordState: true },
    });
    return r ?? undefined;
  }

  async person(
    tx: TenantTransaction,
    id: string,
  ): Promise<{ readonly recordState: string } | undefined> {
    const r = await tenantClient(tx).person.findFirst({
      where: { tenantId: tx.tenantId, id },
      select: { recordState: true },
    });
    return r ?? undefined;
  }

  async line(
    tx: TenantTransaction,
    id: string,
  ): Promise<{ readonly companyId: string; readonly contextId: string | null } | undefined> {
    const r = await tenantClient(tx).tenantSubscription.findFirst({
      where: { tenantId: tx.tenantId, id },
      select: { companyId: true, contextId: true },
    });
    return r ?? undefined;
  }

  // --- Contexts -----------------------------------------------------------------

  async context(tx: TenantTransaction, id: string): Promise<AccountContextRow | undefined> {
    const r = await tenantClient(tx).tenantAccountContext.findFirst({
      where: { tenantId: tx.tenantId, id },
      select: CONTEXT_SELECT,
    });
    return r ? toContextRow(r) : undefined;
  }

  async contexts(tx: TenantTransaction, ids: readonly string[]): Promise<AccountContextRow[]> {
    if (ids.length === 0) return [];
    const rows = await tenantClient(tx).tenantAccountContext.findMany({
      where: { tenantId: tx.tenantId, id: { in: [...new Set(ids)] } },
      select: CONTEXT_SELECT,
    });
    return rows.map(toContextRow);
  }

  async contextByNaturalKey(
    tx: TenantTransaction,
    companyId: string,
    contextTypeId: string,
    naturalKeyHash: string,
  ): Promise<AccountContextRow | undefined> {
    const r = await tenantClient(tx).tenantAccountContext.findFirst({
      where: {
        tenantId: tx.tenantId,
        companyId,
        contextTypeId,
        naturalKeyHash,
        recordState: 'active',
      },
      select: CONTEXT_SELECT,
    });
    return r ? toContextRow(r) : undefined;
  }

  /** Contexts of the given accounts (batch; optional id scope, Q21), newest first per account. */
  async contextsForCompanies(
    tx: TenantTransaction,
    companyIds: readonly string[],
    scope?: readonly string[],
    take?: number,
  ): Promise<AccountContextRow[]> {
    if (companyIds.length === 0) return [];
    const rows = await tenantClient(tx).tenantAccountContext.findMany({
      where: {
        tenantId: tx.tenantId,
        companyId: { in: [...new Set(companyIds)] },
        ...(scope ? { id: { in: [...new Set(scope)] } } : {}),
      },
      orderBy: [{ companyId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: CONTEXT_SELECT,
      ...(take ? { take } : {}),
    });
    return rows.map(toContextRow);
  }

  /** The context a generic source reference (kind `account_context`) points at, following merges. */
  async contextForRef(
    tx: TenantTransaction,
    ref: { system: string; objectType: string; id: string },
  ): Promise<string | undefined> {
    const row = await tenantClient(tx).tenantSourceReference.findUnique({
      where: {
        tenantId_system_objectType_externalId: {
          tenantId: tx.tenantId,
          system: ref.system,
          objectType: ref.objectType,
          externalId: ref.id,
        },
      },
      select: { entityKind: true, entityId: true },
    });
    if (!row || row.entityKind !== 'account_context' || !row.entityId) return undefined;
    let id = row.entityId;
    for (let hops = 0; hops < 20; hops += 1) {
      const c = await this.context(tx, id);
      if (!c || c.recordState !== 'merged' || !c.mergedIntoId) return id;
      id = c.mergedIntoId;
    }
    return id;
  }

  async insertContext(
    tx: TenantTransaction,
    input: {
      readonly companyId: string;
      readonly contextTypeId: string;
      readonly naturalKeyHash: string;
      readonly dimensions: Readonly<Record<string, DimensionValue>>;
      readonly name: string;
      readonly status: string;
      readonly ownerRef: string | null;
      readonly renewalDate: string | null;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tenantClient(tx).tenantAccountContext.create({
      data: {
        tenantId: tx.tenantId,
        id,
        companyId: input.companyId,
        contextTypeId: input.contextTypeId,
        naturalKeyHash: input.naturalKeyHash,
        dimensions: input.dimensions,
        name: input.name,
        status: input.status,
        ownerRef: input.ownerRef,
        renewalDate: toDate(input.renewalDate),
      },
    });
    return id;
  }

  async updateContext(
    tx: TenantTransaction,
    id: string,
    data: {
      readonly name?: string;
      readonly status?: string;
      readonly ownerRef?: string | null;
      readonly renewalDate?: string | null;
      readonly companyId?: string;
      readonly recordState?: 'merged';
      readonly mergedIntoId?: string;
      readonly lastChangeId?: string;
    },
  ): Promise<void> {
    const { renewalDate, ...rest } = data;
    await tenantClient(tx).tenantAccountContext.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id } },
      data: {
        ...rest,
        ...(renewalDate !== undefined ? { renewalDate: toDate(renewalDate) } : {}),
        updatedAt: new Date(),
      },
    });
  }

  /** The newest `human` change records of a context (Q14 hold derivation), newest first. */
  async humanChanges(
    tx: TenantTransaction,
    contextId: string,
  ): Promise<{ origin: string | null; changedFields: string[] }[]> {
    return tenantClient(tx).tenantContextChange.findMany({
      where: {
        tenantId: tx.tenantId,
        entityKind: 'account_context',
        entityId: contextId,
        origin: 'human',
      },
      orderBy: [{ ingestedAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: { origin: true, changedFields: true },
    });
  }

  // --- Memberships --------------------------------------------------------------

  async member(
    tx: TenantTransaction,
    contextId: string,
    personId: string,
    roleCode: string,
  ): Promise<MembershipRow | undefined> {
    const r = await tenantClient(tx).tenantAccountContextPerson.findFirst({
      where: { tenantId: tx.tenantId, contextId, personId, roleCode },
      select: MEMBER_SELECT,
    });
    return r ?? undefined;
  }

  async membersOfContexts(
    tx: TenantTransaction,
    contextIds: readonly string[],
  ): Promise<MembershipRow[]> {
    if (contextIds.length === 0) return [];
    return tenantClient(tx).tenantAccountContextPerson.findMany({
      where: { tenantId: tx.tenantId, contextId: { in: [...new Set(contextIds)] } },
      orderBy: [{ contextId: 'asc' }, { personId: 'asc' }, { roleCode: 'asc' }],
      select: MEMBER_SELECT,
    });
  }

  async membersOfPerson(tx: TenantTransaction, personId: string): Promise<MembershipRow[]> {
    return tenantClient(tx).tenantAccountContextPerson.findMany({
      where: { tenantId: tx.tenantId, personId },
      orderBy: [{ contextId: 'asc' }, { roleCode: 'asc' }],
      select: MEMBER_SELECT,
    });
  }

  async insertMember(
    tx: TenantTransaction,
    row: Omit<MembershipRow, 'status' | 'endedAt'> & {
      readonly status?: string;
      readonly endedAt?: Date | null;
      readonly lastChangeId: string;
    },
  ): Promise<void> {
    await tenantClient(tx).tenantAccountContextPerson.create({
      data: {
        tenantId: tx.tenantId,
        contextId: row.contextId,
        personId: row.personId,
        roleCode: row.roleCode,
        status: row.status ?? 'active',
        startedAt: row.startedAt,
        endedAt: row.endedAt ?? null,
        lastChangeId: row.lastChangeId,
      },
    });
  }

  async updateMember(
    tx: TenantTransaction,
    key: { readonly contextId: string; readonly personId: string; readonly roleCode: string },
    data: {
      readonly status: 'active' | 'ended';
      readonly startedAt?: Date;
      readonly endedAt: Date | null;
      readonly lastChangeId: string;
    },
  ): Promise<void> {
    await tenantClient(tx).tenantAccountContextPerson.update({
      where: { tenantId_contextId_personId_roleCode: { tenantId: tx.tenantId, ...key } },
      data,
    });
  }

  // --- Product memberships ------------------------------------------------------

  async productsOfContexts(
    tx: TenantTransaction,
    contextIds: readonly string[],
  ): Promise<ContextProductRow[]> {
    if (contextIds.length === 0) return [];
    return tenantClient(tx).tenantAccountContextProduct.findMany({
      where: { tenantId: tx.tenantId, contextId: { in: [...new Set(contextIds)] } },
      orderBy: [{ contextId: 'asc' }, { productKey: 'asc' }],
      select: { contextId: true, productKey: true, origin: true },
    });
  }

  /** Adds missing product memberships (never deletes, Q10); returns how many were added. */
  async addProducts(
    tx: TenantTransaction,
    contextId: string,
    rows: readonly { readonly productKey: string; readonly origin: string }[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const res = await tenantClient(tx).tenantAccountContextProduct.createMany({
      data: rows.map((r) => ({
        tenantId: tx.tenantId,
        contextId,
        productKey: r.productKey,
        origin: r.origin,
      })),
      skipDuplicates: true,
    });
    return res.count;
  }

  // --- Lines --------------------------------------------------------------------

  async setLineContext(
    tx: TenantTransaction,
    lineId: string,
    contextId: string | null,
  ): Promise<void> {
    await tenantClient(tx).tenantSubscription.update({
      where: { tenantId_id: { tenantId: tx.tenantId, id: lineId } },
      data: { contextId },
    });
  }

  async linesOfContexts(
    tx: TenantTransaction,
    contextIds: readonly string[],
    take?: number,
  ): Promise<
    { id: string; contextId: string | null; companyId: string; productKey: string; state: string }[]
  > {
    if (contextIds.length === 0) return [];
    return tenantClient(tx).tenantSubscription.findMany({
      where: { tenantId: tx.tenantId, contextId: { in: [...new Set(contextIds)] } },
      orderBy: [{ contextId: 'asc' }, { id: 'asc' }],
      select: { id: true, contextId: true, companyId: true, productKey: true, state: true },
      ...(take ? { take } : {}),
    });
  }

  // --- Change records and value history -----------------------------------------

  insertChange(tx: TenantTransaction, change: ChangeWrite): Promise<string> {
    return insertContextChange(tx, change);
  }

  valueHistory(
    tx: TenantTransaction,
    input: {
      readonly entityKind: 'account_context' | 'subscription';
      readonly entityId: string;
      readonly changeId: string;
      readonly effectiveAt: Date;
      readonly actor?: SecurityActor;
      readonly changes: readonly ValueChange[];
    },
  ): Promise<number> {
    return recordValueHistory(tx, input);
  }

  // --- Data-quality issues (tenant_identity_conflicts, interim until M10L) --------

  static issueKey(kind: string, identity: string): string {
    return createHash('sha256').update(`${kind}|${identity}`).digest('hex');
  }

  async recordIssue(tx: TenantTransaction, issue: ContextIssueWrite): Promise<void> {
    const conflictKey = AccountContextStore.issueKey(issue.kind, issue.identity);
    const canonicalIds = [...new Set(issue.canonicalIds)].sort();
    const externalRefs = [...new Set(issue.externalRefs)].sort();
    await tenantClient(tx).tenantIdentityConflict.upsert({
      where: { tenantId_conflictKey: { tenantId: tx.tenantId, conflictKey } },
      create: {
        tenantId: tx.tenantId,
        id: randomUUID(),
        kind: issue.kind,
        entityKind: 'account_context',
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

  async resolveIssue(
    tx: TenantTransaction,
    kind: IdentityConflictKind,
    identity: string,
  ): Promise<void> {
    const now = new Date();
    await tenantClient(tx).tenantIdentityConflict.updateMany({
      where: {
        tenantId: tx.tenantId,
        conflictKey: AccountContextStore.issueKey(kind, identity),
        state: 'open',
      },
      data: { state: 'resolved', resolvedAt: now, updatedAt: now },
    });
  }
}
