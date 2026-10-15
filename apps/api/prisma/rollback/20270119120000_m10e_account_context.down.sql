-- Down-script for 20270119120000_m10e_account_context (Milestone 10E, ADR
-- 0031). Development and staging only: production policy is forward-fix
-- (tenant-level rollback = adoption back to 0.4 and/or module disable, which
-- keeps account-context data). Run with the owner credentials, before the M10D
-- down-script:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20270119120000_m10e_account_context.down.sql
--
-- Refuses (and changes nothing) while data the M10D schema cannot hold exists:
-- any context_type registry version or entry, account context, person or
-- product membership, subscription line with a context, or authority version
-- naming an account_context connection; any account_context entity-index row
-- or source reference; any change record of kind account_context /
-- account_context_person; any value history of an M10E field or of an
-- account_context entity; any identity conflict of an M10E kind or entity
-- kind; any extension value, reference value or relationship end naming an
-- account context; any extension definition targeting account_context; any
-- tenant module setting or setting event of module account_context; any
-- adoption of 0.5 (including new tenants provisioned at 0.5); or audit events
-- naming an M10E capability or action.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM tenant_registry_versions WHERE kind = 'context_type';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % context_type registry versions exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_registry_entries WHERE kind = 'context_type';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % context_type registry entries exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_registry_entries WHERE kind = 'extension' AND definition ->> 'target' = 'account_context';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % extension definitions target account_context', n; END IF;
  SELECT count(*) INTO n FROM tenant_account_contexts;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % account contexts exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_account_context_persons;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % account-context person memberships exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_account_context_products;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % account-context product memberships exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_subscriptions WHERE context_id IS NOT NULL;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % subscription lines carry an account context', n; END IF;
  SELECT count(*) INTO n FROM tenant_source_authority_versions WHERE account_context_connection_id IS NOT NULL;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % authority versions name an account_context connection', n; END IF;
  SELECT count(*) INTO n FROM tenant_entity_index WHERE kind = 'account_context';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % account_context entity-index rows exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_source_references WHERE entity_kind = 'account_context';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % account_context source references exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_context_changes WHERE entity_kind IN ('account_context', 'account_context_person');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % change records use M10E kinds', n; END IF;
  SELECT count(*) INTO n FROM tenant_value_history
   WHERE entity_kind = 'account_context' OR (entity_kind = 'subscription' AND field = 'context_id');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % value history rows of M10E fields exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_identity_conflicts
   WHERE kind IN ('account_context_merge_collision', 'account_context_company_mismatch',
                  'account_context_human_override_disagrees', 'account_context_reference_unresolved')
      OR entity_kind = 'account_context';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % identity conflicts of M10E kinds exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_extension_values WHERE target_kind = 'account_context' OR value_ref_kind = 'account_context';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % extension values name an account context', n; END IF;
  SELECT count(*) INTO n FROM tenant_custom_relationships WHERE from_kind = 'account_context' OR to_kind = 'account_context';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % custom relationships name an account context', n; END IF;
  SELECT count(*) INTO n FROM tenant_module_settings WHERE module_key = 'account_context';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % tenant settings of module account_context exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_module_setting_events WHERE module_key = 'account_context';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % setting events of module account_context exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_canonical_adoptions WHERE version = '0.5' OR previous_version = '0.5';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % adoptions of canonical 0.5 exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_audit_events
   WHERE capability IN ('data.account_context.read')
      OR action IN ('account_context.write', 'account_context.retire', 'account_context.member.set',
                    'account_context.line.assign', 'account_context.release', 'account_context.read');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % audit events use M10E capabilities or actions', n; END IF;
END
$$;

DROP TRIGGER "tenant_subscriptions_context_guard" ON "tenant_subscriptions";
ALTER TABLE "tenant_subscriptions" DROP CONSTRAINT "tenant_subscriptions_tenant_id_context_id_fkey";
DROP INDEX "tenant_subscriptions_tenant_id_context_id_idx";
ALTER TABLE "tenant_subscriptions" DROP COLUMN "context_id";
ALTER TABLE "tenant_source_authority_versions" DROP CONSTRAINT "tenant_source_authority_versions_tenant_id_account_context_fkey";
ALTER TABLE "tenant_source_authority_versions" DROP COLUMN "account_context_connection_id";
DROP TABLE "tenant_account_context_products";
DROP TABLE "tenant_account_context_persons";
DROP TABLE "tenant_account_contexts";
DROP FUNCTION "app_line_context_guard"();
DROP FUNCTION "app_account_context_guard"();
DROP FUNCTION "app_account_context_person_guard"();
DROP FUNCTION "app_account_context_product_guard"();

ALTER TABLE "tenant_entity_index" DROP CONSTRAINT "tenant_entity_index_kind_valid";
ALTER TABLE "tenant_entity_index"
  ADD CONSTRAINT "tenant_entity_index_kind_valid" CHECK ("kind" IN ('company', 'person', 'product', 'subscription', 'person_affiliation', 'custom_record'));
ALTER TABLE "tenant_source_references" DROP CONSTRAINT "tenant_source_references_entity_kind_valid";
ALTER TABLE "tenant_source_references"
  ADD CONSTRAINT "tenant_source_references_entity_kind_valid" CHECK ("entity_kind" IN ('product', 'person_affiliation', 'custom_record'));
ALTER TABLE "tenant_context_changes" DROP CONSTRAINT "tenant_context_changes_entity_kind_valid";
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'custom_relationship'));
ALTER TABLE "tenant_value_history" DROP CONSTRAINT "tenant_value_history_field_valid";
ALTER TABLE "tenant_value_history"
  ADD CONSTRAINT "tenant_value_history_field_valid" CHECK (("entity_kind", "field") IN (('company', 'name'), ('company', 'parent_company_id'), ('subscription', 'state'), ('subscription', 'starts_at'), ('subscription', 'ends_at'), ('subscription', 'product_key'), ('subscription', 'quantity'), ('person_affiliation', 'status'), ('person_affiliation', 'starts_at'), ('person_affiliation', 'ends_at'), ('person_affiliation', 'role_codes'))
    OR ("field" ~ '^ext:[a-z][a-z0-9_]{0,62}$' AND "entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record')));
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_kind_valid" CHECK ("kind" IN ('shared_email', 'merge_across_systems', 'ambiguous_primary_company', 'hierarchy_cycle_refused', 'hierarchy_depth_exceeded', 'hierarchy_parent_merged', 'hierarchy_parent_unresolved', 'hierarchy_human_override_disagrees', 'affiliation_endpoint_unresolved', 'extension_value_conflict', 'extension_human_override_disagrees', 'extension_reference_unresolved', 'custom_record_parent_unresolved', 'custom_relationship_endpoint_unresolved'));
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_entity_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record'));
ALTER TABLE "tenant_extension_values" DROP CONSTRAINT "tenant_extension_values_target_kind_valid";
ALTER TABLE "tenant_extension_values"
  ADD CONSTRAINT "tenant_extension_values_target_kind_valid" CHECK ("target_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record'));
ALTER TABLE "tenant_extension_values" DROP CONSTRAINT "tenant_extension_values_ref_kind_valid";
ALTER TABLE "tenant_extension_values"
  ADD CONSTRAINT "tenant_extension_values_ref_kind_valid" CHECK ("value_ref_kind" IS NULL OR "value_ref_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record'));
ALTER TABLE "tenant_custom_relationships" DROP CONSTRAINT "tenant_custom_relationships_from_kind_valid";
ALTER TABLE "tenant_custom_relationships"
  ADD CONSTRAINT "tenant_custom_relationships_from_kind_valid" CHECK ("from_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record'));
ALTER TABLE "tenant_custom_relationships" DROP CONSTRAINT "tenant_custom_relationships_to_kind_valid";
ALTER TABLE "tenant_custom_relationships"
  ADD CONSTRAINT "tenant_custom_relationships_to_kind_valid" CHECK ("to_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record'));

ALTER TABLE "canonical_modules" NO FORCE ROW LEVEL SECURITY;
UPDATE "canonical_modules" SET "available" = false, "minimum_canonical_version" = NULL WHERE "module_key" = 'account_context';
ALTER TABLE "canonical_modules" FORCE ROW LEVEL SECURITY;

ALTER TABLE "canonical_model_versions" NO FORCE ROW LEVEL SECURITY;
DELETE FROM "canonical_model_versions" WHERE "version" = '0.5';
UPDATE "canonical_model_versions" SET "status" = 'current' WHERE "version" = '0.4';
ALTER TABLE "canonical_model_versions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry', 'config.canonical.adopt', 'config.module.change', 'config.registry.publish', 'config.data_policy.publish', 'config.mapping.draft', 'config.mapping.retire', 'security.integrity.run', 'canonical.evidence.link', 'data.provenance.read', 'data.account_structure.read', 'data.extension.read')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied', 'canonical.adopt', 'module.enable', 'module.disable', 'module.configure', 'registry.publish', 'data_policy.publish', 'mapping.draft.save', 'mapping.draft.validate', 'mapping.draft.discard', 'mapping.retire', 'integrity.verify', 'provenance.read', 'evidence.link', 'source_reference.observe', 'account.hierarchy.set', 'account.hierarchy.clear', 'account.hierarchy.release', 'person.affiliation.add', 'person.affiliation.end', 'person.affiliation.release', 'account_structure.read', 'extension.value.set', 'extension.value.clear', 'extension.value.release', 'extension.record.create', 'extension.record.update', 'extension.record.retire', 'extension.record.reactivate', 'extension.relationship.add', 'extension.relationship.end', 'extension.read'));

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270119120000_m10e_account_context';

COMMIT;
