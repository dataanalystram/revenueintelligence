import { randomUUID } from 'node:crypto';
import {
  AccountContextMembershipWriter,
  AccountContextMergeParticipant,
  AccountContextReadModel,
  AccountContextSourceSync,
  AccountContextWriter,
  type AccountContextObservation,
  type ContextProvenance,
} from '../../src/modules/context';
import {
  CanonicalAdoptionService,
  IntegrityVerificationService,
  ModuleSettingsService,
  RegistryService,
} from '../../src/modules/governance';
import type { TenantContext } from '../../src/modules/tenancy';
import type { ContextHarness } from './context';
import { authz } from './security';

/**
 * M10E test helpers (AccountContext): a tenant at canonical 0.5 (new
 * tenants adopt it at provisioning) with module `account_context` enabled,
 * synthetic products, a published `context_type` registry, the writers and
 * read model of the harness app, source provenance and owner-side
 * read-backs. Synthetic types, dimensions and values only (no customer
 * schema).
 */

export const AC_REASON = 'test_correction';

export const acServices = (c: ContextHarness) => ({
  writer: c.app.get(AccountContextWriter, { strict: false }),
  members: c.app.get(AccountContextMembershipWriter, { strict: false }),
  read: c.app.get(AccountContextReadModel, { strict: false }),
  merge: c.app.get(AccountContextMergeParticipant, { strict: false }),
  sourceSync: c.app.get(AccountContextSourceSync, { strict: false }),
  registry: c.app.get(RegistryService),
  modules: c.app.get(ModuleSettingsService),
  adoption: c.app.get(CanonicalAdoptionService),
  integrity: c.app.get(IntegrityVerificationService),
});

/** Synthetic products seeded for every context tenant (`legacy` is retired). */
export const AC_PRODUCTS = [
  { key: 'core', active: true },
  { key: 'analytics', active: true },
  { key: 'reporting', active: true },
  { key: 'legacy', active: false },
] as const;

const internalOps = { sensitivity: 'internal', categories: ['operational'] } as const;

/** A `code` dimension `region` (emea / amer / apac). */
export const regionDim = (over: Record<string, unknown> = {}) => ({
  key: 'region',
  type: 'code',
  required: true,
  codes: ['emea', 'amer', 'apac'],
  ...internalOps,
  ...over,
});

/** A required `product_key` dimension `product`. */
export const productDim = (over: Record<string, unknown> = {}) => ({
  key: 'product',
  type: 'product_key',
  required: true,
  sensitivity: 'internal',
  categories: ['commercial'],
  ...over,
});

/** An optional confidential `string` dimension `segment`. */
export const segmentDim = (over: Record<string, unknown> = {}) => ({
  key: 'segment',
  type: 'string',
  required: false,
  sensitivity: 'confidential',
  categories: ['commercial'],
  ...over,
});

/**
 * The default TEST context types:
 * - `product_region` (product × region, optional confidential segment;
 *   roles csm / champion; explicit products allowed) — the E3 pressure shape;
 * - `deal_desk` (region only; roles buyer; no explicit products).
 */
export function defaultContextTypes(extra: Record<string, unknown>[] = []) {
  return {
    schema_version: 1,
    types: [
      {
        key: 'product_region',
        title: 'Product in a region',
        description: 'One product of the account in one region',
        dimensions: [productDim(), regionDim(), segmentDim()],
        member_roles: ['csm', 'champion'],
        allow_products: true,
      },
      {
        key: 'deal_desk',
        title: 'Deal desk',
        description: 'A regional deal desk of the account',
        dimensions: [regionDim()],
        member_roles: ['buyer'],
      },
      ...extra,
    ],
  };
}

/** The tenant's latest registry version of a kind (0 = none). */
export async function registryVersionOf(
  c: ContextHarness,
  t: TenantContext,
  kind: string,
): Promise<number> {
  const [row] = await c.sql<{ v: number | null }>(
    `SELECT max(version)::int AS v FROM tenant_registry_versions WHERE tenant_id = $1 AND kind = $2`,
    [t.tenantId, kind],
  );
  return row?.v ?? 0;
}

/** Dry run → reviewed hash → publish of a `context_type` document on the current base version. */
export async function publishContextTypes(
  c: ContextHarness,
  t: TenantContext,
  document: unknown = defaultContextTypes(),
) {
  const s = acServices(c);
  const dry = await s.registry.dryRun(t, 'context_type', document);
  if (!dry.valid) throw new Error(`context_type registry invalid: ${JSON.stringify(dry.issues)}`);
  return s.registry.publish(await authz(t, 'config.registry.publish'), 'context_type', {
    document,
    expectedBaseVersion: await registryVersionOf(c, t, 'context_type'),
    expectedContentHash: dry.contentHash!,
  });
}

async function moduleVersion(c: ContextHarness, t: TenantContext, module: string) {
  const [row] = await c.sql<{ version: number }>(
    `SELECT version FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = $2`,
    [t.tenantId, module],
  );
  return row?.version ?? 0;
}

export async function setModule(
  c: ContextHarness,
  t: TenantContext,
  module: 'account_context' | 'extension',
  enabled: boolean,
): Promise<void> {
  const s = acServices(c);
  const actx = await authz(t, 'config.module.change');
  const input = { module, expectedVersion: await moduleVersion(c, t, module) };
  if (enabled) await s.modules.enable(actx, input);
  else await s.modules.disable(actx, input);
}

/** Seeds synthetic products (owner SQL; the product catalogue is not the subject). */
export async function seedProducts(
  c: ContextHarness,
  t: TenantContext,
  products: readonly { key: string; active: boolean }[] = AC_PRODUCTS,
): Promise<void> {
  for (const p of products) {
    await c.sql(
      `INSERT INTO tenant_products (tenant_id, key, name, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now()) ON CONFLICT (tenant_id, key) DO NOTHING`,
      [t.tenantId, p.key, `Product ${p.key}`, p.active],
    );
  }
}

/**
 * A new tenant (0.5 at provisioning) with the synthetic products, module
 * `account_context` enabled and the context types published (unless
 * `publish: false`). `extension` also enables module `extension` first.
 */
export async function contextTenant(
  c: ContextHarness,
  prefix: string,
  options: {
    portal?: number;
    document?: unknown;
    publish?: boolean;
    enable?: boolean;
  } = {},
): Promise<TenantContext> {
  const t = await c.tenant(prefix, options.portal ?? 1001);
  await seedProducts(c, t);
  if (options.enable !== false) await setModule(c, t, 'account_context', true);
  if (options.enable !== false && options.publish !== false) {
    await publishContextTypes(c, t, options.document);
  }
  return t;
}

/** A subscription line of `companyId` (owner SQL; the line writer is not the subject): id returned. */
export async function insertLine(
  c: ContextHarness,
  t: TenantContext,
  companyId: string,
  productKey = 'core',
): Promise<string> {
  const id = randomUUID();
  await c.sql(
    `INSERT INTO tenant_subscriptions (tenant_id, id, company_id, product_key, state, source_system,
                                       source_object_type, source_record_id, observed_at)
     VALUES ($1, $2, $3, $4, 'active', 'hubspot', 'line_items', $5, now())`,
    [t.tenantId, id, companyId, productKey, `line-${id}`],
  );
  return id;
}

/** Source provenance of a TEST context observation (identifiers only). */
export function contextProvenance(
  recordId: string,
  over: Partial<ContextProvenance> = {},
): ContextProvenance {
  return {
    source: { system: 'hubspot', objectType: 'relationships', id: recordId },
    cause: 'backfill',
    adapter: 'hubspot',
    adapterVersion: '1',
    correlationId: randomUUID(),
    ...over,
  };
}

/** One source observation through `AccountContextWriter.observeSource` (present unless stated). */
export async function observeContext(
  c: ContextHarness,
  t: TenantContext,
  input: {
    companyId: string;
    record: string;
    dimensions: Record<string, unknown>;
    type?: string;
  } & Partial<
    Omit<
      AccountContextObservation,
      'companyId' | 'typeKey' | 'ref' | 'dimensions' | 'observedAt' | 'provenance'
    >
  >,
) {
  const { companyId, record, dimensions, type, ...rest } = input;
  return acServices(c).writer.observeSource(await authz(t, 'canonical.source_sync'), {
    companyId,
    typeKey: type ?? 'product_region',
    ref: { system: 'hubspot', objectType: 'relationships', id: record },
    presence: 'present',
    dimensions,
    observedAt: new Date(),
    provenance: contextProvenance(record),
    ...rest,
  });
}

export type ContextRow = {
  readonly id: string;
  readonly company_id: string;
  readonly type_key: string;
  readonly natural_key_hash: string;
  readonly dimensions: Record<string, unknown>;
  readonly name: string;
  readonly status: string;
  readonly owner_ref: string | null;
  readonly renewal_date: string | null;
  readonly record_state: string;
  readonly merged_into_id: string | null;
  readonly last_change_id: string | null;
};

/** Stored contexts (owner read-back), oldest first. */
export const contextsOf = (c: ContextHarness, t: TenantContext, companyId?: string) =>
  c.sql<ContextRow>(
    `SELECT x.id::text, x.company_id::text, e.key AS type_key, x.natural_key_hash, x.dimensions, x.name,
            x.status, x.owner_ref, x.renewal_date::text, x.record_state, x.merged_into_id::text,
            x.last_change_id::text
       FROM tenant_account_contexts x
       JOIN tenant_registry_entries e ON e.tenant_id = x.tenant_id AND e.id = x.context_type_id
      WHERE x.tenant_id = $1 AND ($2::uuid IS NULL OR x.company_id = $2::uuid)
      ORDER BY x.created_at, x.id`,
    [t.tenantId, companyId ?? null],
  );

export async function contextOf(
  c: ContextHarness,
  t: TenantContext,
  id: string,
): Promise<ContextRow> {
  const row = (await contextsOf(c, t)).find((r) => r.id === id);
  if (!row) throw new Error(`no context ${id}`);
  return row;
}

export type MemberDbRow = {
  readonly context_id: string;
  readonly person_id: string;
  readonly role_code: string;
  readonly status: string;
  readonly started_at: Date;
  readonly ended_at: Date | null;
  readonly last_change_id: string | null;
};

export const membersOf = (c: ContextHarness, t: TenantContext, contextId?: string) =>
  c.sql<MemberDbRow>(
    `SELECT context_id::text, person_id::text, role_code, status, started_at, ended_at, last_change_id::text
       FROM tenant_account_context_persons
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR context_id = $2::uuid)
      ORDER BY started_at, person_id, role_code`,
    [t.tenantId, contextId ?? null],
  );

export const contextProductsOf = (c: ContextHarness, t: TenantContext, contextId?: string) =>
  c.sql<{ context_id: string; product_key: string; origin: string }>(
    `SELECT context_id::text, product_key, origin FROM tenant_account_context_products
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR context_id = $2::uuid)
      ORDER BY context_id, product_key`,
    [t.tenantId, contextId ?? null],
  );

export const lineContextOf = async (c: ContextHarness, t: TenantContext, lineId: string) => {
  const [row] = await c.sql<{ context_id: string | null; company_id: string }>(
    `SELECT context_id::text, company_id::text FROM tenant_subscriptions WHERE tenant_id = $1 AND id = $2`,
    [t.tenantId, lineId],
  );
  if (!row) throw new Error(`no line ${lineId}`);
  return row;
};

/** The M10E data-quality issues of a tenant (interim store), oldest first. */
export const acIssuesOf = (c: ContextHarness, t: TenantContext, kind?: string) =>
  c.sql<{
    kind: string;
    entity_kind: string;
    state: string;
    canonical_ids: string[];
    external_refs: string[];
  }>(
    `SELECT kind, entity_kind, state, canonical_ids::text[] AS canonical_ids, external_refs
       FROM tenant_identity_conflicts
      WHERE tenant_id = $1 AND kind LIKE 'account_context_%' AND ($2::text IS NULL OR kind = $2)
      ORDER BY created_at, conflict_key`,
    [t.tenantId, kind ?? null],
  );

export type AcHistoryRow = {
  readonly entity_kind: string;
  readonly entity_id: string;
  readonly field: string;
  readonly old_value: unknown;
  readonly new_value: unknown;
  readonly change_id: string;
  readonly actor_kind: string;
};

/** Value history of account contexts (owner_ref / status) or of line `context_id`. */
export const acHistoryOf = (
  c: ContextHarness,
  t: TenantContext,
  entityKind: 'account_context' | 'subscription',
  entityId?: string,
) =>
  c.sql<AcHistoryRow>(
    `SELECT entity_kind, entity_id::text, field, old_value, new_value, change_id::text, actor_kind
       FROM tenant_value_history
      WHERE tenant_id = $1 AND entity_kind = $2 AND ($3::uuid IS NULL OR entity_id = $3::uuid)
        AND (entity_kind <> 'subscription' OR field = 'context_id')
      ORDER BY recorded_at, effective_at, field`,
    [t.tenantId, entityKind, entityId ?? null],
  );

export type AcChangeRow = {
  readonly id: string;
  readonly entity_kind: string;
  readonly entity_id: string;
  readonly change_type: string;
  readonly changed_fields: string[];
  readonly source_system: string;
  readonly source_object_type: string;
  readonly origin: string | null;
  readonly actor_kind: string | null;
  readonly canonical_version: string | null;
};

/** Change records of an entity (any kind), oldest first. */
export const acChangesOf = (c: ContextHarness, t: TenantContext, entityId: string) =>
  c.sql<AcChangeRow>(
    `SELECT id::text, entity_kind, entity_id::text, change_type, changed_fields, source_system,
            source_object_type, origin, actor_kind, canonical_version
       FROM tenant_context_changes
      WHERE tenant_id = $1 AND entity_id::text = $2
      ORDER BY ingested_at, id`,
    [t.tenantId, entityId],
  );

/** Change records of one kind (e.g. `account_context_person`), oldest first. */
export const acChangesOfKind = (c: ContextHarness, t: TenantContext, entityKind: string) =>
  c.sql<AcChangeRow>(
    `SELECT id::text, entity_kind, entity_id::text, change_type, changed_fields, source_system,
            source_object_type, origin, actor_kind, canonical_version
       FROM tenant_context_changes
      WHERE tenant_id = $1 AND entity_kind = $2
      ORDER BY ingested_at, id`,
    [t.tenantId, entityKind],
  );
