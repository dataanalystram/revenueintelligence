import { randomUUID } from 'node:crypto';
import {
  CustomRecordWriter,
  CustomRelationshipWriter,
  ExtensionMergeParticipant,
  ExtensionReadModel,
  ExtensionUseGuard,
  ExtensionValueWriter,
  type ExtensionProvenance,
} from '../../src/modules/extension';
import { ExtensionStore } from '../../src/modules/extension/infrastructure/extension.store';
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
 * M10D test helpers (extension framework): a tenant at 0.4 with module
 * `extension` enabled and a published extension registry, the writers and
 * read models of the harness app, source provenance, and owner-side
 * read-backs. Synthetic definitions and values only (no customer schema).
 */

export const REASON = 'test_correction';

export const services = (c: ContextHarness) => ({
  values: c.app.get(ExtensionValueWriter),
  records: c.app.get(CustomRecordWriter),
  relationships: c.app.get(CustomRelationshipWriter),
  merge: c.app.get(ExtensionMergeParticipant),
  read: c.app.get(ExtensionReadModel),
  guard: c.app.get(ExtensionUseGuard),
  store: c.app.get(ExtensionStore, { strict: false }),
  registry: c.app.get(RegistryService),
  modules: c.app.get(ModuleSettingsService),
  adoption: c.app.get(CanonicalAdoptionService),
  integrity: c.app.get(IntegrityVerificationService),
});

const cls = { sensitivity: 'internal', categories: ['commercial'] } as const;

/** A field definition on `account` (internal / commercial, display + analytics) unless overridden. */
export const field = (
  key: string,
  valueType: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  key,
  target: 'account',
  display_name: `Test ${key}`,
  description: `Synthetic test field ${key}`,
  value_type: valueType,
  ...cls,
  allowed_uses: ['display', 'analytics'],
  ...over,
});

/**
 * The default TEST registry: one account field per value type (13), a
 * restricted field, a confidential field, an analytics-only field, a person
 * field with value history (personal), a `site` custom object (required
 * account parent, natural key) with two fields, an `asset` object (optional
 * parent) and three relationships (many_to_one site → person, one_to_one
 * site → account, many_to_many site ↔ asset).
 */
export function defaultDocument(): Record<string, unknown> {
  return {
    schema_version: 1,
    fields: [
      field('x_string', 'string', { constraints: { max_length: 20 }, history: 'value_history' }),
      field('x_text', 'text'),
      field('x_number', 'number', { constraints: { min: 0, max: 1000 } }),
      field('x_integer', 'integer'),
      field('x_boolean', 'boolean'),
      field('x_date', 'date'),
      field('x_datetime', 'datetime'),
      field('x_money', 'money'),
      field('x_enum', 'enum', {
        allowed_values: [
          { code: 'gold', label: 'Gold' },
          { code: 'silver', label: 'Silver' },
          { code: 'bronze', label: 'Bronze', status: 'retired' },
        ],
      }),
      field('x_multi', 'multi_enum', {
        allowed_values: [
          { code: 'a', label: 'A' },
          { code: 'b', label: 'B' },
          { code: 'c', label: 'C' },
        ],
      }),
      field('x_array', 'array', { constraints: { item_type: 'integer', max_items: 3 } }),
      field('x_json', 'json'),
      field('x_ref', 'reference', {
        constraints: { reference_to: ['account', 'custom_object:site'] },
      }),
      field('x_restricted', 'string', { sensitivity: 'restricted', categories: ['operational'] }),
      field('x_conf', 'string', { sensitivity: 'confidential', categories: ['commercial'] }),
      field('x_analytics', 'string', { allowed_uses: ['analytics'] }),
      field('p_note', 'string', {
        target: 'person',
        sensitivity: 'confidential',
        categories: ['personal'],
        history: 'value_history',
      }),
      field('site_code', 'string', {
        target: 'custom_object:site',
        sensitivity: 'internal',
        categories: ['operational'],
      }),
      field('site_size', 'integer', {
        target: 'custom_object:site',
        sensitivity: 'internal',
        categories: ['operational'],
      }),
      field('asset_tag', 'string', {
        target: 'custom_object:asset',
        sensitivity: 'internal',
        categories: ['operational'],
      }),
    ],
    objects: [
      {
        key: 'site',
        display_name: 'Site',
        description: 'Synthetic test object',
        record_identity: { natural_key: ['site_code'] },
        parent: { kind: 'account', required: true },
        sensitivity: 'internal',
        categories: ['operational'],
        allowed_uses: ['display', 'analytics'],
      },
      {
        key: 'asset',
        display_name: 'Asset',
        description: 'Synthetic test object without a required parent',
        parent: { kind: 'account', required: false },
        sensitivity: 'internal',
        categories: ['operational'],
        allowed_uses: ['display', 'analytics'],
      },
    ],
    relationships: [
      {
        key: 'site_contact',
        display_name: 'Site contact',
        description: 'Synthetic many-to-one relationship',
        from: 'custom_object:site',
        to: 'person',
        cardinality: 'many_to_one',
        role: 'primary',
        sensitivity: 'internal',
        categories: ['operational'],
      },
      {
        key: 'site_owner',
        display_name: 'Site owner',
        description: 'Synthetic one-to-one relationship',
        from: 'custom_object:site',
        to: 'account',
        cardinality: 'one_to_one',
        sensitivity: 'internal',
        categories: ['operational'],
      },
      {
        key: 'site_asset',
        display_name: 'Site asset',
        description: 'Synthetic many-to-many relationship',
        from: 'custom_object:site',
        to: 'custom_object:asset',
        cardinality: 'many_to_many',
        sensitivity: 'internal',
        categories: ['operational'],
      },
    ],
  };
}

/** The tenant's latest registry version of kind extension (0 = none). */
export async function registryVersion(c: ContextHarness, t: TenantContext): Promise<number> {
  const [row] = await c.sql<{ v: number | null }>(
    `SELECT max(version)::int AS v FROM tenant_registry_versions WHERE tenant_id = $1 AND kind = 'extension'`,
    [t.tenantId],
  );
  return row?.v ?? 0;
}

/** Dry run → reviewed hash → publish (the operator flow), on the current base version. */
export async function publishExtension(
  c: ContextHarness,
  t: TenantContext,
  document: unknown = defaultDocument(),
) {
  const s = services(c);
  const dry = await s.registry.dryRun(t, 'extension', document);
  if (!dry.valid) throw new Error(`extension registry invalid: ${JSON.stringify(dry.issues)}`);
  return s.registry.publish(await authz(t, 'config.registry.publish'), 'extension', {
    document,
    expectedBaseVersion: await registryVersion(c, t),
    expectedContentHash: dry.contentHash!,
  });
}

export async function enableExtension(c: ContextHarness, t: TenantContext): Promise<void> {
  const [row] = await c.sql<{ version: number }>(
    `SELECT version FROM tenant_module_settings WHERE tenant_id = $1 AND module_key = 'extension'`,
    [t.tenantId],
  );
  await services(c).modules.enable(await authz(t, 'config.module.change'), {
    module: 'extension',
    expectedVersion: row?.version ?? 0,
  });
}

/** A new tenant (0.4 at provisioning), module enabled, the registry published. */
export async function extensionTenant(
  c: ContextHarness,
  prefix: string,
  options: { portal?: number; document?: unknown; publish?: boolean } = {},
): Promise<TenantContext> {
  const t = await c.tenant(prefix, options.portal ?? 1001);
  await enableExtension(c, t);
  if (options.publish !== false) await publishExtension(c, t, options.document);
  return t;
}

/** The tenant's `import` connection (every tenant has one): a valid owning connection id. */
export async function importConnectionId(c: ContextHarness, t: TenantContext): Promise<string> {
  const [row] = await c.sql<{ id: string }>(
    `SELECT id::text FROM tenant_source_connections WHERE tenant_id = $1 AND kind = 'import' LIMIT 1`,
    [t.tenantId],
  );
  if (!row) throw new Error('no import connection');
  return row.id;
}

/** Source provenance of a TEST observation (identifiers only). */
export function sourceProvenance(
  recordId: string,
  over: Partial<ExtensionProvenance> = {},
): ExtensionProvenance {
  return {
    source: { system: 'hubspot', objectType: 'companies', id: recordId },
    cause: 'backfill',
    adapter: 'hubspot',
    adapterVersion: '1',
    correlationId: randomUUID(),
    origin: 'source_provided',
    ...over,
  };
}

export type ValueRow = {
  readonly id: string;
  readonly key: string;
  readonly target_kind: string;
  readonly target_id: string | null;
  readonly target_key: string | null;
  readonly value_type: string;
  readonly value_state: string;
  readonly value_text: string | null;
  readonly value_number: string | null;
  readonly value_bool: boolean | null;
  readonly value_date: string | null;
  readonly value_ts: Date | null;
  readonly value_money_minor: string | null;
  readonly value_currency: string | null;
  readonly value_enum: string | null;
  readonly value_item_count: number | null;
  readonly value_json: unknown;
  readonly value_ref_kind: string | null;
  readonly value_ref_id: string | null;
  readonly value_ref_key: string | null;
  readonly origin: string;
  readonly source_connection_id: string | null;
  readonly source_object_type: string | null;
  readonly source_record_id: string | null;
  readonly field_hash: string | null;
  readonly registry_version: number;
  readonly released_at: Date | null;
  readonly last_change_id: string | null;
  readonly updated_at: Date;
};

/** Stored values (owner read-back), keyed by field key. */
export async function valuesOf(
  c: ContextHarness,
  t: TenantContext,
  targetId?: string,
): Promise<Record<string, ValueRow>> {
  const rows = await c.sql<ValueRow>(
    `SELECT v.id::text, e.key, v.target_kind, v.target_id::text, v.target_key, v.value_type, v.value_state,
            v.value_text, v.value_number::text, v.value_bool, v.value_date::text, v.value_ts,
            v.value_money_minor::text, v.value_currency, v.value_enum, v.value_item_count, v.value_json,
            v.value_ref_kind, v.value_ref_id::text, v.value_ref_key, v.origin, v.source_connection_id::text,
            v.source_object_type, v.source_record_id, v.field_hash, v.registry_version, v.released_at,
            v.last_change_id::text, v.updated_at
       FROM tenant_extension_values v
       JOIN tenant_registry_entries e ON e.tenant_id = v.tenant_id AND e.id = v.field_id
      WHERE v.tenant_id = $1 AND ($2::text IS NULL OR v.target_id::text = $2 OR v.target_key = $2)
      ORDER BY e.key`,
    [t.tenantId, targetId ?? null],
  );
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

export async function itemsOf(c: ContextHarness, t: TenantContext, valueId: string) {
  return c.sql<{
    ordinal: number;
    item_type: string;
    item_text: string | null;
    item_number: string | null;
    item_date: string | null;
    item_enum: string | null;
  }>(
    `SELECT ordinal, item_type, item_text, item_number::text, item_date::text, item_enum
       FROM tenant_extension_value_items WHERE tenant_id = $1 AND value_id = $2 ORDER BY ordinal`,
    [t.tenantId, valueId],
  );
}

/** The registry entry id of a definition key. */
export async function entryId(c: ContextHarness, t: TenantContext, key: string): Promise<string> {
  const [row] = await c.sql<{ id: string }>(
    `SELECT id::text FROM tenant_registry_entries WHERE tenant_id = $1 AND kind = 'extension' AND key = $2`,
    [t.tenantId, key],
  );
  if (!row) throw new Error(`no extension entry ${key}`);
  return row.id;
}

export type ExtChangeRow = {
  readonly id: string;
  readonly entity_kind: string;
  readonly entity_id: string;
  readonly change_type: string;
  readonly changed_fields: string[];
  readonly source_system: string;
  readonly source_object_type: string;
  readonly source_record_id: string;
  readonly origin: string | null;
  readonly actor_kind: string | null;
  readonly canonical_version: string | null;
};

/** Change records of an entity (or of a kind), oldest first. */
export const changesOf = (c: ContextHarness, t: TenantContext, entityId: string) =>
  c.sql<ExtChangeRow>(
    `SELECT id::text, entity_kind, entity_id::text, change_type, changed_fields, source_system, source_object_type,
            source_record_id, origin, actor_kind, canonical_version
       FROM tenant_context_changes
      WHERE tenant_id = $1 AND entity_id::text = $2
      ORDER BY ingested_at, id`,
    [t.tenantId, entityId],
  );

/** Extension changes only (an `ext:` token, or a custom record / relationship kind). */
export const extChangesOf = async (c: ContextHarness, t: TenantContext, entityId: string) =>
  (await changesOf(c, t, entityId)).filter(
    (r) =>
      r.entity_kind === 'custom_record' ||
      r.entity_kind === 'custom_relationship' ||
      r.changed_fields.some((f) => f.startsWith('ext:')),
  );

/** The M10D data-quality issues of a tenant (interim store). */
export const extIssuesOf = (c: ContextHarness, t: TenantContext, kind?: string) =>
  c.sql<{
    kind: string;
    entity_kind: string;
    state: string;
    canonical_ids: string[];
    external_refs: string[];
  }>(
    `SELECT kind, entity_kind, state, canonical_ids::text[] AS canonical_ids, external_refs FROM tenant_identity_conflicts
      WHERE tenant_id = $1 AND (kind LIKE 'extension_%' OR kind LIKE 'custom_%') AND ($2::text IS NULL OR kind = $2)
      ORDER BY created_at, conflict_key`,
    [t.tenantId, kind ?? null],
  );

export type RecordRow = {
  readonly id: string;
  readonly object_key: string;
  readonly parent_kind: string | null;
  readonly parent_id: string | null;
  readonly natural_key_hash: string | null;
  readonly record_state: string;
  readonly merged_into_id: string | null;
  readonly origin: string;
  readonly last_change_id: string | null;
};

export const recordsOf = (c: ContextHarness, t: TenantContext) =>
  c.sql<RecordRow>(
    `SELECT r.id::text, e.key AS object_key, r.parent_kind, r.parent_id::text, r.natural_key_hash, r.record_state,
            r.merged_into_id::text, r.origin, r.last_change_id::text
       FROM tenant_custom_records r
       JOIN tenant_registry_entries e ON e.tenant_id = r.tenant_id AND e.id = r.object_id
      WHERE r.tenant_id = $1 ORDER BY r.created_at, r.id`,
    [t.tenantId],
  );

export type EdgeRow = {
  readonly id: string;
  readonly rel_key: string;
  readonly from_kind: string;
  readonly from_id: string | null;
  readonly to_kind: string;
  readonly to_id: string | null;
  readonly role_code: string | null;
  readonly state: string;
  readonly end_reason: string | null;
  readonly origin: string;
  readonly source_connection_id: string | null;
};

export const edgesOf = (c: ContextHarness, t: TenantContext) =>
  c.sql<EdgeRow>(
    `SELECT r.id::text, e.key AS rel_key, r.from_kind, r.from_id::text, r.to_kind, r.to_id::text, r.role_code,
            r.state, r.end_reason, r.origin, r.source_connection_id::text
       FROM tenant_custom_relationships r
       JOIN tenant_registry_entries e ON e.tenant_id = r.tenant_id AND e.id = r.rel_def_id
      WHERE r.tenant_id = $1 ORDER BY r.created_at, r.id`,
    [t.tenantId],
  );
