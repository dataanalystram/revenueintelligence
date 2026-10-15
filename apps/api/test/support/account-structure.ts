import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  personFields,
  type ExternalRef,
  type SourceAffiliation,
  type SourceCompanyLink,
  type SourceObservation,
} from '../../src/modules/domain';
import type { IngestResult } from '../../src/modules/context';
import type { TenantContext } from '../../src/modules/tenancy';
import type { ContextHarness } from './context';
import { authz } from './security';

/**
 * M10C test helpers (account hierarchy, person–account affiliation): source
 * observations through the real single writer (`ContextIngestionService`),
 * raw SQL as the application role (forced RLS), and owner-side read-backs.
 * Identifiers and synthetic values only.
 */

export const hs = (id: string): ExternalRef => ({
  system: 'hubspot',
  objectType: 'companies',
  id,
});
export const contact = (id: string): ExternalRef => ({
  system: 'hubspot',
  objectType: 'contacts',
  id,
});

export const ingestMeta = () => ({ cause: 'webhook' as const, correlationId: randomUUID() });

/** A link as the HubSpot association reader states it (`primary` = the primary company). */
export const link = (companyId: string, primary = false): SourceCompanyLink => ({
  company: hs(companyId),
  typeId: primary ? 1 : 279,
  category: 'standard',
  primary,
});

export async function ingest(
  c: ContextHarness,
  t: TenantContext,
  observation: SourceObservation,
): Promise<IngestResult> {
  return c.ingestion.ingest(await authz(t, 'canonical.source_sync'), observation, ingestMeta());
}

/**
 * One present company observation. `parent`: undefined = not stated (unmapped
 * or not authoritative), null = explicitly empty (clear), a string = the
 * parent's HubSpot company id.
 */
export async function observeCompany(
  c: ContextHarness,
  t: TenantContext,
  id: string,
  options: { parent?: string | null; name?: string; observedAt?: Date } = {},
): Promise<IngestResult> {
  return ingest(c, t, {
    kind: 'company',
    presence: 'present',
    ref: hs(id),
    observedAt: options.observedAt ?? new Date(),
    fields: { name: options.name ?? `Company ${id}` },
    ...(options.parent === undefined
      ? {}
      : {
          parent:
            options.parent === null
              ? { kind: 'clear' as const }
              : { kind: 'set' as const, ref: hs(options.parent) },
        }),
  });
}

/** One present person observation (HubSpot contact) with its company links / affiliations. */
export async function observePerson(
  c: ContextHarness,
  t: TenantContext,
  id: string,
  options: {
    links?: readonly SourceCompanyLink[];
    affiliations?: readonly SourceAffiliation[];
    email?: string;
    firstName?: string;
    lastName?: string;
    jobTitle?: string;
    observedAt?: Date;
  } = {},
): Promise<IngestResult> {
  return ingest(c, t, {
    kind: 'person',
    presence: 'present',
    ref: contact(id),
    observedAt: options.observedAt ?? new Date(),
    fields: personFields({
      email: options.email ?? `p${id}@school.example`,
      ...(options.firstName ? { firstName: options.firstName } : {}),
      ...(options.lastName ? { lastName: options.lastName } : {}),
      ...(options.jobTitle ? { jobTitle: options.jobTitle } : {}),
    }),
    ...(options.links ? { companyLinks: options.links } : {}),
    ...(options.affiliations ? { affiliations: options.affiliations } : {}),
  });
}

/** Canonical company id of a HubSpot company reference (following no merges). */
export async function companyIdOf(
  c: ContextHarness,
  t: TenantContext,
  id: string,
): Promise<string> {
  const [row] = await c.sql<{ company_id: string }>(
    `SELECT company_id::text FROM company_external_refs
      WHERE tenant_id = $1 AND system = 'hubspot' AND object_type = 'companies' AND external_id = $2`,
    [t.tenantId, id],
  );
  if (!row) throw new Error(`no company for hubspot:companies:${id}`);
  return row.company_id;
}

/** Canonical person id of a HubSpot contact reference. */
export async function personIdOf(c: ContextHarness, t: TenantContext, id: string): Promise<string> {
  const [row] = await c.sql<{ person_id: string }>(
    `SELECT person_id::text FROM person_external_refs
      WHERE tenant_id = $1 AND system = 'hubspot' AND object_type = 'contacts' AND external_id = $2`,
    [t.tenantId, id],
  );
  if (!row) throw new Error(`no person for hubspot:contacts:${id}`);
  return row.person_id;
}

/** Observes the companies (no parents) and returns their canonical ids by HubSpot id. */
export async function companies(
  c: ContextHarness,
  t: TenantContext,
  ids: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const r = await observeCompany(c, t, id);
    out[id] = r.entityId!;
  }
  return out;
}

/**
 * A chain `ids[0] ← ids[1] ← …` written through the source path (each id's
 * parent is the previous one); returns the canonical ids in order.
 */
export async function chain(
  c: ContextHarness,
  t: TenantContext,
  ids: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const [i, id] of ids.entries()) {
    const r = await observeCompany(c, t, id, i === 0 ? {} : { parent: ids[i - 1]! });
    out.push(r.entityId!);
  }
  return out;
}

export type ParentRow = {
  readonly parent_company_id: string | null;
  readonly parent_company_origin: string | null;
  readonly record_state: string;
  readonly name: string | null;
};

export async function parentOf(
  c: ContextHarness,
  t: TenantContext,
  companyId: string,
): Promise<ParentRow> {
  const [row] = await c.sql<ParentRow>(
    `SELECT parent_company_id::text, parent_company_origin, record_state, name FROM companies
      WHERE tenant_id = $1 AND id = $2`,
    [t.tenantId, companyId],
  );
  if (!row) throw new Error(`no company ${companyId}`);
  return row;
}

export type IssueRow = {
  readonly kind: string;
  readonly entity_kind: string;
  readonly state: string;
  readonly canonical_ids: string[];
  readonly external_refs: string[];
};

/** The M10C data-quality issues of a tenant (interim store), oldest first. */
export const issuesOf = (c: ContextHarness, t: TenantContext, kind?: string) =>
  c.sql<IssueRow>(
    `SELECT kind, entity_kind, state, canonical_ids::text[] AS canonical_ids, external_refs FROM tenant_identity_conflicts
      WHERE tenant_id = $1 AND kind NOT IN ('shared_email', 'merge_across_systems', 'ambiguous_primary_company')
        AND ($2::text IS NULL OR kind = $2)
      ORDER BY created_at, conflict_key`,
    [t.tenantId, kind ?? null],
  );

export type HistoryRow = {
  readonly entity_id: string;
  readonly field: string;
  readonly values_recorded: boolean;
  readonly old_value: unknown;
  readonly new_value: unknown;
  readonly change_id: string;
  readonly actor_kind: string;
};

export const historyOf = (
  c: ContextHarness,
  t: TenantContext,
  entityKind: 'company' | 'person_affiliation',
  entityId?: string,
) =>
  c.sql<HistoryRow>(
    `SELECT entity_id::text, field, values_recorded, old_value, new_value, change_id::text, actor_kind
       FROM tenant_value_history
      WHERE tenant_id = $1 AND entity_kind = $2 AND ($3::uuid IS NULL OR entity_id = $3::uuid)
        AND (entity_kind <> 'company' OR field = 'parent_company_id')
      ORDER BY recorded_at, effective_at, field`,
    [t.tenantId, entityKind, entityId ?? null],
  );

export type ChangeRow = {
  readonly id: string;
  readonly entity_id: string;
  readonly change_type: string;
  readonly changed_fields: string[];
  readonly source_system: string;
  readonly source_object_type: string;
  readonly source_record_id: string;
  readonly cause: string;
  readonly origin: string | null;
  readonly actor_kind: string | null;
  readonly actor_id: string | null;
  readonly canonical_version: string | null;
  readonly correlation_id: string;
};

/** Change records of the account structure: parent changes of companies, or affiliation records. */
export const structureChangesOf = (
  c: ContextHarness,
  t: TenantContext,
  entityKind: 'company' | 'person_affiliation',
  entityId?: string,
) =>
  c.sql<ChangeRow>(
    `SELECT id::text, entity_id::text, change_type, changed_fields, source_system, source_object_type, source_record_id,
            cause, origin, actor_kind, actor_id, canonical_version, correlation_id::text
       FROM tenant_context_changes
      WHERE tenant_id = $1 AND entity_kind = $2 AND ($3::uuid IS NULL OR entity_id = $3::uuid)
        AND (entity_kind <> 'company' OR changed_fields && ARRAY['parentCompanyId', 'parentCompanyOrigin'])
      ORDER BY ingested_at, id`,
    [t.tenantId, entityKind, entityId ?? null],
  );

export type AuditRow = {
  readonly action: string;
  readonly outcome: string;
  readonly capability: string;
  readonly reason_code: string | null;
  readonly target_kind: string | null;
  readonly target_ref: string | null;
  readonly actor_kind: string;
  readonly details: Record<string, unknown>;
};

export const auditOf = (c: ContextHarness, t: TenantContext, action?: string) =>
  c.sql<AuditRow>(
    `SELECT action, outcome, capability, reason_code, target_kind, target_ref, actor_kind, details
       FROM tenant_audit_events WHERE tenant_id = $1 AND ($2::text IS NULL OR action = $2) ORDER BY seq`,
    [t.tenantId, action ?? null],
  );

export type AffiliationDbRow = {
  readonly id: string;
  readonly person_id: string;
  readonly company_id: string;
  readonly status: string;
  readonly role_codes: string[];
  readonly starts_at: Date | null;
  readonly ends_at: Date | null;
  readonly ended_at: Date | null;
  readonly end_reason: string | null;
  readonly merged_into_id: string | null;
  readonly origin: string;
  readonly last_change_id: string | null;
};

export const affiliationsOf = (c: ContextHarness, t: TenantContext, personId?: string) =>
  c.sql<AffiliationDbRow>(
    `SELECT id::text, person_id::text, company_id::text, status, role_codes, starts_at, ends_at, ended_at, end_reason,
            merged_into_id::text, origin, last_change_id::text
       FROM tenant_person_affiliations
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR person_id = $2::uuid)
      ORDER BY created_at, id`,
    [t.tenantId, personId ?? null],
  );

/**
 * Runs `work` on a fresh connection as the application login with the
 * tenant bound, inside one transaction that is rolled back (default) or
 * committed. Raw SQL, no application code: the database is the boundary.
 */
export async function asApp<T>(
  c: ContextHarness,
  t: TenantContext,
  work: (client: Client) => Promise<T>,
  options: { commit?: boolean } = {},
): Promise<T> {
  const client = new Client({ connectionString: c.appUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [t.tenantId]);
    const out = await work(client);
    await client.query(options.commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** An open app-role session with the tenant bound (concurrency tests); the caller ends it. */
export async function appSession(c: ContextHarness, t: TenantContext): Promise<Client> {
  const client = new Client({ connectionString: c.appUrl });
  await client.connect();
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [t.tenantId]);
  return client;
}

/** Inserts a company row directly as the app role (no writer): id returned. */
export async function insertCompanyRow(
  client: Client,
  t: TenantContext,
  parentId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO companies (id, tenant_id, name, created_at, updated_at, parent_company_id)
     VALUES ($1, $2, NULL, now(), now(), $3)`,
    [id, t.tenantId, parentId],
  );
  return id;
}
