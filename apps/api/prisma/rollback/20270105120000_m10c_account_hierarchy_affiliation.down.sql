-- Down-script for 20270105120000_m10c_account_hierarchy_affiliation (Milestone
-- 10C, ADR 0029). Development and staging only: production policy is
-- forward-fix (tenant-level rollback = adoption back to 0.2, which keeps
-- parents and affiliations). Run with the owner credentials, before the M10B
-- down-script:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20270105120000_m10c_account_hierarchy_affiliation.down.sql
--
-- Refuses (and changes nothing) while data the M10B schema cannot hold
-- exists: any parent set (or a parent origin recorded, e.g. a sticky human
-- clear), any affiliation, any person_affiliation reference or change record,
-- any value history of an M10C field, any identity conflict of an M10C kind,
-- any authority version naming a hierarchy connection, any adoption of 0.3
-- (including new tenants provisioned at 0.3), or audit events naming an M10C
-- capability or action.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM companies WHERE parent_company_id IS NOT NULL OR parent_company_origin IS NOT NULL;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % companies carry a parent or parent origin', n; END IF;
  SELECT count(*) INTO n FROM tenant_person_affiliations;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % person affiliations exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_source_references WHERE entity_kind = 'person_affiliation';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % person_affiliation source references exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_context_changes WHERE entity_kind = 'person_affiliation';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % person_affiliation change records exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_value_history
   WHERE entity_kind = 'person_affiliation' OR (entity_kind = 'company' AND field = 'parent_company_id');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % value history rows of M10C fields exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_identity_conflicts
   WHERE kind NOT IN ('shared_email', 'merge_across_systems', 'ambiguous_primary_company');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % identity conflicts of M10C kinds exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_source_authority_versions WHERE account_hierarchy_connection_id IS NOT NULL;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % authority versions name an account_hierarchy connection', n; END IF;
  SELECT count(*) INTO n FROM tenant_canonical_adoptions WHERE version = '0.3' OR previous_version = '0.3';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % adoptions of canonical 0.3 exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_audit_events
   WHERE capability IN ('data.account_structure.read')
      OR action IN ('account.hierarchy.set', 'account.hierarchy.clear', 'account.hierarchy.release',
                    'person.affiliation.add', 'person.affiliation.end', 'account_structure.read');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % audit events use M10C capabilities or actions', n; END IF;
END
$$;

DROP VIEW "person_affiliation_index";
DROP VIEW "account_hierarchy_paths";
DROP TABLE "tenant_person_affiliations";
DROP FUNCTION "app_person_affiliation_guard"();

DROP TRIGGER "companies_hierarchy_guard" ON "companies";
DROP FUNCTION "app_company_hierarchy_guard"();
DROP FUNCTION "app_tenant_advisory_key"(uuid, text, text);
DROP INDEX "companies_tenant_parent_idx";
ALTER TABLE "companies"
  DROP CONSTRAINT "companies_tenant_id_parent_company_id_fkey",
  DROP CONSTRAINT "companies_parent_not_self",
  DROP CONSTRAINT "companies_parent_origin_valid",
  DROP COLUMN "parent_company_id",
  DROP COLUMN "parent_company_origin";

ALTER TABLE "tenant_source_authority_versions"
  DROP CONSTRAINT "tenant_source_authority_versions_tenant_id_account_hierarc_fkey",
  DROP COLUMN "account_hierarchy_connection_id";

ALTER TABLE "tenant_entity_index" DROP CONSTRAINT "tenant_entity_index_kind_valid";
ALTER TABLE "tenant_entity_index"
  ADD CONSTRAINT "tenant_entity_index_kind_valid" CHECK ("kind" IN ('company', 'person', 'product', 'subscription'));
ALTER TABLE "tenant_source_references" DROP CONSTRAINT "tenant_source_references_entity_kind_valid";
ALTER TABLE "tenant_source_references"
  ADD CONSTRAINT "tenant_source_references_entity_kind_valid" CHECK ("entity_kind" IN ('product'));
ALTER TABLE "tenant_context_changes" DROP CONSTRAINT "tenant_context_changes_entity_kind_valid";
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product'));
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_kind_valid" CHECK ("kind" IN ('shared_email', 'merge_across_systems', 'ambiguous_primary_company'));
ALTER TABLE "tenant_value_history" DROP CONSTRAINT "tenant_value_history_field_valid";
ALTER TABLE "tenant_value_history"
  ADD CONSTRAINT "tenant_value_history_field_valid" CHECK (("entity_kind", "field") IN (('company', 'name'), ('subscription', 'state'), ('subscription', 'starts_at'), ('subscription', 'ends_at'), ('subscription', 'product_key'), ('subscription', 'quantity')));

ALTER TABLE "canonical_model_versions" NO FORCE ROW LEVEL SECURITY;
DELETE FROM "canonical_model_versions" WHERE "version" = '0.3';
UPDATE "canonical_model_versions" SET "status" = 'current' WHERE "version" = '0.2';
ALTER TABLE "canonical_model_versions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry', 'config.canonical.adopt', 'config.module.change', 'config.registry.publish', 'config.data_policy.publish', 'config.mapping.draft', 'config.mapping.retire', 'security.integrity.run', 'canonical.evidence.link', 'data.provenance.read')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied', 'canonical.adopt', 'module.enable', 'module.disable', 'module.configure', 'registry.publish', 'data_policy.publish', 'mapping.draft.save', 'mapping.draft.validate', 'mapping.draft.discard', 'mapping.retire', 'integrity.verify', 'provenance.read', 'evidence.link', 'source_reference.observe'));

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270105120000_m10c_account_hierarchy_affiliation';

COMMIT;
