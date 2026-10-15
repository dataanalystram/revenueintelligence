-- Down-script for 20270112120000_m10d_extension_framework (Milestone 10D, ADR
-- 0030). Development and staging only: production policy is forward-fix
-- (tenant-level rollback = adoption back to 0.3 and/or module disable, which
-- keeps extension data). Run with the owner credentials, before the M10C
-- down-script:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20270112120000_m10d_extension_framework.down.sql
--
-- Refuses (and changes nothing) while data the M10C schema cannot hold exists:
-- any extension registry version or entry, extension value, collection item,
-- custom record or custom relationship; any custom_record source reference or
-- entity-index row; any change record of kind custom_record /
-- custom_relationship or naming an ext:<key> field; any value history of an
-- extension field; any identity conflict of an M10D kind or entity kind; any
-- tenant module setting or setting event of module extension; any adoption of
-- 0.4 (including new tenants provisioned at 0.4); any mapping version or draft
-- document above the M10C 256 KiB cap; or audit events naming an M10D
-- capability or action.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM tenant_registry_versions WHERE kind = 'extension';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % extension registry versions exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_registry_entries WHERE kind = 'extension';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % extension registry entries exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_extension_values;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % extension values exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_extension_value_items;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % extension value items exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_custom_records;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % custom records exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_custom_relationships;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % custom relationships exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_entity_index WHERE kind = 'custom_record';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % custom_record entity-index rows exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_source_references WHERE entity_kind = 'custom_record';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % custom_record source references exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_context_changes
   WHERE entity_kind IN ('custom_record', 'custom_relationship')
      OR array_to_string(changed_fields, ',') ~ '(^|,)ext:';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % change records use M10D kinds or ext: fields', n; END IF;
  SELECT count(*) INTO n FROM tenant_value_history WHERE field LIKE 'ext:%' OR entity_kind = 'custom_record';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % value history rows of extension fields exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_identity_conflicts
   WHERE kind IN ('extension_value_conflict', 'extension_human_override_disagrees', 'extension_reference_unresolved',
                  'custom_record_parent_unresolved', 'custom_relationship_endpoint_unresolved')
      OR entity_kind NOT IN ('company', 'person');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % identity conflicts of M10D kinds exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_module_settings WHERE module_key = 'extension';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % tenant settings of module extension exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_module_setting_events WHERE module_key = 'extension';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % setting events of module extension exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_canonical_adoptions WHERE version = '0.4' OR previous_version = '0.4';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % adoptions of canonical 0.4 exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_source_mapping_versions WHERE octet_length(document::text) > 262144;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % mapping versions exceed the 256 KiB document cap', n; END IF;
  SELECT count(*) INTO n FROM tenant_source_mapping_drafts WHERE octet_length(document::text) > 262144;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % mapping drafts exceed the 256 KiB document cap', n; END IF;
  SELECT count(*) INTO n FROM tenant_audit_events
   WHERE capability IN ('data.extension.read')
      OR action IN ('extension.value.set', 'extension.value.clear', 'extension.value.release',
                    'extension.record.create', 'extension.record.update', 'extension.record.retire',
                    'extension.record.reactivate', 'extension.relationship.add', 'extension.relationship.end',
                    'extension.read');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % audit events use M10D capabilities or actions', n; END IF;
END
$$;

DROP TABLE "tenant_extension_value_items";
DROP TABLE "tenant_extension_values";
DROP TABLE "tenant_custom_relationships";
DROP TABLE "tenant_custom_records";
DROP FUNCTION "app_extension_value_guard"();
DROP FUNCTION "app_custom_record_guard"();
DROP FUNCTION "app_custom_relationship_guard"();
DROP FUNCTION "app_jsonb_depth"(jsonb);
DROP INDEX "tenant_registry_entries_tenant_id_kind_id_key";

ALTER TABLE "tenant_registry_versions" DROP CONSTRAINT "tenant_registry_versions_document_object";
ALTER TABLE "tenant_registry_versions"
  ADD CONSTRAINT "tenant_registry_versions_document_object" CHECK (jsonb_typeof("document") = 'object' AND octet_length("document"::text) <= 262144);

ALTER TABLE "tenant_source_mapping_versions" DROP CONSTRAINT "tenant_source_mapping_versions_document_object";
ALTER TABLE "tenant_source_mapping_versions"
  ADD CONSTRAINT "tenant_source_mapping_versions_document_object" CHECK (jsonb_typeof("document") = 'object' AND octet_length("document"::text) <= 262144);
ALTER TABLE "tenant_source_mapping_drafts" DROP CONSTRAINT "tenant_source_mapping_drafts_document_object";
ALTER TABLE "tenant_source_mapping_drafts"
  ADD CONSTRAINT "tenant_source_mapping_drafts_document_object" CHECK (jsonb_typeof("document") = 'object' AND octet_length("document"::text) <= 262144);

ALTER TABLE "tenant_entity_index" DROP CONSTRAINT "tenant_entity_index_kind_valid";
ALTER TABLE "tenant_entity_index"
  ADD CONSTRAINT "tenant_entity_index_kind_valid" CHECK ("kind" IN ('company', 'person', 'product', 'subscription', 'person_affiliation'));
ALTER TABLE "tenant_source_references" DROP CONSTRAINT "tenant_source_references_entity_kind_valid";
ALTER TABLE "tenant_source_references"
  ADD CONSTRAINT "tenant_source_references_entity_kind_valid" CHECK ("entity_kind" IN ('product', 'person_affiliation'));
ALTER TABLE "tenant_context_changes" DROP CONSTRAINT "tenant_context_changes_entity_kind_valid";
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation'));
ALTER TABLE "tenant_context_changes" DROP CONSTRAINT "tenant_context_changes_fields_format";
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_fields_format" CHECK (array_to_string("changed_fields", ',') ~ '^([A-Za-z][A-Za-z0-9_]{0,63}(,|$))*$');
ALTER TABLE "tenant_value_history" DROP CONSTRAINT "tenant_value_history_field_valid";
ALTER TABLE "tenant_value_history"
  ADD CONSTRAINT "tenant_value_history_field_valid" CHECK (("entity_kind", "field") IN (('company', 'name'), ('company', 'parent_company_id'), ('subscription', 'state'), ('subscription', 'starts_at'), ('subscription', 'ends_at'), ('subscription', 'product_key'), ('subscription', 'quantity'), ('person_affiliation', 'status'), ('person_affiliation', 'starts_at'), ('person_affiliation', 'ends_at'), ('person_affiliation', 'role_codes')));
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_kind_valid" CHECK ("kind" IN ('shared_email', 'merge_across_systems', 'ambiguous_primary_company', 'hierarchy_cycle_refused', 'hierarchy_depth_exceeded', 'hierarchy_parent_merged', 'hierarchy_parent_unresolved', 'hierarchy_human_override_disagrees', 'affiliation_endpoint_unresolved'));
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_entity_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person'));

ALTER TABLE "canonical_modules" NO FORCE ROW LEVEL SECURITY;
UPDATE "canonical_modules" SET "available" = false, "minimum_canonical_version" = NULL WHERE "module_key" = 'extension';
ALTER TABLE "canonical_modules" FORCE ROW LEVEL SECURITY;

ALTER TABLE "canonical_model_versions" NO FORCE ROW LEVEL SECURITY;
DELETE FROM "canonical_model_versions" WHERE "version" = '0.4';
UPDATE "canonical_model_versions" SET "status" = 'current' WHERE "version" = '0.3';
ALTER TABLE "canonical_model_versions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry', 'config.canonical.adopt', 'config.module.change', 'config.registry.publish', 'config.data_policy.publish', 'config.mapping.draft', 'config.mapping.retire', 'security.integrity.run', 'canonical.evidence.link', 'data.provenance.read', 'data.account_structure.read')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied', 'canonical.adopt', 'module.enable', 'module.disable', 'module.configure', 'registry.publish', 'data_policy.publish', 'mapping.draft.save', 'mapping.draft.validate', 'mapping.draft.discard', 'mapping.retire', 'integrity.verify', 'provenance.read', 'evidence.link', 'source_reference.observe', 'account.hierarchy.set', 'account.hierarchy.clear', 'account.hierarchy.release', 'person.affiliation.add', 'person.affiliation.end', 'person.affiliation.release', 'account_structure.read'));

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270112120000_m10d_extension_framework';

COMMIT;
