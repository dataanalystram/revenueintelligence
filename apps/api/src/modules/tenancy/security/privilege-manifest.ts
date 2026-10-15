/**
 * The application role's exact table privileges (M10A1 plan §8). The schema
 * guard compares every table and every privilege (`SELECT`, `INSERT`, `UPDATE`,
 * `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`) of `lip_app` with this
 * manifest (views included); a new table or view without an entry fails. `TRUNCATE`, `REFERENCES` and
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
  // M10A2: platform reference tables and the trigger-maintained entity index.
  canonical_model_versions: READ,
  canonical_modules: READ,
  tenant_entity_index: READ,
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
  tenant_canonical_adoptions: APPEND,
  tenant_module_setting_events: APPEND,
  tenant_registry_versions: APPEND,
  tenant_value_history: APPEND,
  tenant_source_mapping_lifecycle: APPEND,
  // M10A2: read-only view of the current lifecycle state (security invoker).
  tenant_source_mapping_states: READ,
  tenant_integrity_runs: APPEND,
  // M10B: evidence links are append-only (plus the app_refuse_change trigger).
  tenant_evidence_links: APPEND,
  // M10B: read-only security-invoker view over every source-reference store.
  source_reference_index: READ,
  // M10C: read-only security-invoker views over the account structure.
  account_hierarchy_paths: READ,
  person_affiliation_index: READ,
  // Catalogue rows retire, never disappear; profile runs move through states.
  tenant_products: APPEND_UPDATE,
  tenant_source_profile_runs: APPEND_UPDATE,
  // M10A2: module settings and registry entries are never deleted (F4, X1).
  tenant_module_settings: APPEND_UPDATE,
  tenant_registry_entries: APPEND_UPDATE,
  // M10B: source references change state, never disappear (E5 §2).
  tenant_source_references: APPEND_UPDATE,
  // M10C: affiliations end, never disappear (plan §3.1).
  tenant_person_affiliations: APPEND_UPDATE,
  // M10D: values (explicit empty), records (retire) and edges (end) never disappear.
  tenant_extension_values: APPEND_UPDATE,
  tenant_custom_records: APPEND_UPDATE,
  tenant_custom_relationships: APPEND_UPDATE,
  // M10D hardening #83 (Q14): owners are claimed and released in place, never deleted.
  tenant_custom_object_owners: APPEND_UPDATE,
  // M10D (Q26): collection items are replaced on change — the only M10D DELETE grant.
  tenant_extension_value_items: ['SELECT', 'INSERT', 'DELETE'],
  // M10E: contexts retire / merge, memberships end, product memberships stay (no DELETE).
  tenant_account_contexts: APPEND_UPDATE,
  tenant_account_context_persons: APPEND_UPDATE,
  tenant_account_context_products: APPEND_UPDATE,
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
  tenant_source_mapping_drafts: DML,
  tenant_webhook_receipts: DML,
  tenants: DML,
};

/**
 * Owner-function allow-list (M10A1 plan §8; M10A2 plan §7): the SECURITY
 * DEFINER functions. `app_route_oauth_account` is owned by lip_webhook_router,
 * the entity-index functions by lip_entity_indexer.
 */
export const SECURITY_DEFINER_FUNCTIONS = [
  'app_entity_index_add',
  'app_entity_index_remove',
  'app_route_oauth_account',
] as const;
