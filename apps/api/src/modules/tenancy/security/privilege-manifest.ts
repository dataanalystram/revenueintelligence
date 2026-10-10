/**
 * The application role's exact table privileges (M10A1 plan §8). The schema
 * guard compares every table and every privilege (`SELECT`, `INSERT`, `UPDATE`,
 * `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`) of `lip_app` with this
 * manifest; a new table without an entry fails. `TRUNCATE`, `REFERENCES` and
 * `TRIGGER` are never granted.
 */
export const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;
export type TablePrivilege = (typeof TABLE_PRIVILEGES)[number];

const NONE: readonly TablePrivilege[] = [];
const READ: readonly TablePrivilege[] = ['SELECT'];
/** Append-only: rows are inserted and read, never changed (plan §7). */
const APPEND: readonly TablePrivilege[] = ['SELECT', 'INSERT'];
/** Inserted and updated in place, never deleted. */
const APPEND_UPDATE: readonly TablePrivilege[] = ['SELECT', 'INSERT', 'UPDATE'];
const DML: readonly TablePrivilege[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

export const PRIVILEGE_MANIFEST: Readonly<Record<string, readonly TablePrivilege[]>> = {
  _prisma_migrations: NONE,
  connector_kinds: READ,
  // Written only by the owner-path purges.
  tenant_audit_anchors: READ,
  tenant_source_profile_purges: READ,
  tenant_audit_events: APPEND,
  tenant_context_changes: APPEND,
  tenant_eligibility_snapshots: APPEND,
  tenant_product_models: APPEND,
  tenant_source_authority_versions: APPEND,
  tenant_source_mapping_versions: APPEND,
  tenant_source_profile_findings: APPEND,
  tenant_source_profiles: APPEND,
  tenant_source_schema_snapshots: APPEND,
  // Catalogue rows retire, never disappear; profile runs move through states.
  tenant_products: APPEND_UPDATE,
  tenant_source_profile_runs: APPEND_UPDATE,
  companies: DML,
  company_external_refs: DML,
  person_external_refs: DML,
  persons: DML,
  tenant_credential_refs: DML,
  tenant_dead_letters: DML,
  tenant_flow_settings: DML,
  tenant_identity_conflicts: DML,
  tenant_integrations: DML,
  tenant_lead_source_mappings: DML,
  tenant_oauth_states: DML,
  tenant_oauth_tokens: DML,
  tenant_ownership_gaps: DML,
  tenant_policies: DML,
  tenant_qualification_config: DML,
  tenant_source_connections: DML,
  tenant_source_relationships: DML,
  tenant_subscriptions: DML,
  tenant_sync_checkpoints: DML,
  tenant_webhook_receipts: DML,
  tenants: DML,
};

/**
 * Owner-function allow-list (plan §8): the only SECURITY DEFINER function, and
 * the only function not owned by the schema owner.
 */
export const SECURITY_DEFINER_FUNCTIONS = ['app_route_oauth_account'] as const;
