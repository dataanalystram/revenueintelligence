-- Down-script for 20270202120000_m10f_commercial (Milestone 10F, ADR 0032).
-- Development and staging only: production policy is forward-fix (tenant-level
-- rollback = adoption back to 0.5 and/or module disable, which keeps commercial
-- data). Run with the owner credentials, before the M10E hardening #90
-- down-script (it is the newest migration, so its down-script runs first):
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20270202120000_m10f_commercial.down.sql
--
-- Refuses (and changes nothing) while data the pre-M10F schema cannot hold
-- exists: any price offer, contract or entitlement; any subscription line with
-- an agreement_ref, contract, price offer or predecessor; any authority version
-- naming a price_offer / contract / entitlement connection; any entity-index
-- row or source reference of an M10F kind; any change record of an M10F entity
-- kind; any value history of an M10F field or entity; any identity conflict of
-- an M10F kind or entity kind; any extension value, reference value or
-- relationship end naming an M10F kind; any extension definition naming one;
-- any capability grant of data.commercial.read_confidential (active or
-- revoked); any tenant module setting or setting event of module commercial;
-- any adoption of 0.6 (including new tenants provisioned at 0.6); or audit
-- events naming a policy-v8 capability or an M10F action. Otherwise it restores
-- the M10E + #83 + #90 schema exactly (CHECKs, module row, 0.5 current,
-- privilege matrix).

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM tenant_price_offers;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % price offers exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_contracts;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % contracts exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_entitlements;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % entitlements exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_subscriptions
   WHERE agreement_ref_system IS NOT NULL OR agreement_ref_object_type IS NOT NULL OR agreement_ref_external_id IS NOT NULL
      OR contract_id IS NOT NULL OR price_offer_id IS NOT NULL OR supersedes_line_id IS NOT NULL;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % subscription lines carry commercial references', n; END IF;
  SELECT count(*) INTO n FROM tenant_source_authority_versions
   WHERE price_offer_connection_id IS NOT NULL OR contract_connection_id IS NOT NULL OR entitlement_connection_id IS NOT NULL;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % authority versions name a commercial connection', n; END IF;
  SELECT count(*) INTO n FROM tenant_entity_index WHERE kind IN ('price_offer', 'contract', 'entitlement');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % commercial entity-index rows exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_source_references WHERE entity_kind IN ('price_offer', 'contract', 'entitlement');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % commercial source references exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_context_changes WHERE entity_kind IN ('price_offer', 'contract', 'entitlement');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % change records use M10F kinds', n; END IF;
  SELECT count(*) INTO n FROM tenant_value_history
   WHERE entity_kind IN ('price_offer', 'contract', 'entitlement')
      OR (entity_kind = 'subscription' AND field IN ('contract_id', 'price_offer_id'));
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % value history rows of M10F fields exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_identity_conflicts
   WHERE kind IN ('contract_reference_unresolved', 'price_offer_reference_unresolved', 'contract_company_mismatch',
                  'price_offer_product_mismatch', 'contract_link_cycle_refused', 'contract_link_cross_account',
                  'contract_duplicate_source', 'commercial_human_override_disagrees')
      OR entity_kind IN ('price_offer', 'contract', 'entitlement');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % identity conflicts of M10F kinds exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_extension_values
   WHERE target_kind IN ('price_offer', 'contract', 'entitlement') OR value_ref_kind IN ('price_offer', 'contract', 'entitlement');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % extension values name a commercial entity', n; END IF;
  SELECT count(*) INTO n FROM tenant_custom_relationships
   WHERE from_kind IN ('price_offer', 'contract', 'entitlement') OR to_kind IN ('price_offer', 'contract', 'entitlement');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % custom relationships name a commercial entity', n; END IF;
  SELECT count(*) INTO n FROM tenant_registry_entries WHERE kind = 'extension'
    AND (definition ->> 'target' IN ('price_offer', 'contract', 'entitlement')
         OR definition ->> 'from' IN ('price_offer', 'contract', 'entitlement')
         OR definition ->> 'to' IN ('price_offer', 'contract', 'entitlement')
         OR COALESCE(definition #> '{constraints,reference_to}', '[]'::jsonb) ?| ARRAY['price_offer', 'contract', 'entitlement']);
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % extension definitions name a commercial entity', n; END IF;
  SELECT count(*) INTO n FROM tenant_capability_grants WHERE capability = 'data.commercial.read_confidential';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % data.commercial.read_confidential grants exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_module_settings WHERE module_key = 'commercial';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % tenant settings of module commercial exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_module_setting_events WHERE module_key = 'commercial';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % setting events of module commercial exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_canonical_adoptions WHERE version = '0.6' OR previous_version = '0.6';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % adoptions of canonical 0.6 exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_audit_events
   WHERE capability IN ('data.commercial.read', 'data.commercial.read_confidential')
      OR action IN ('commercial.price_offer.write', 'commercial.contract.write', 'commercial.contract.link',
                    'commercial.entitlement.write', 'commercial.line.reference', 'commercial.release', 'commercial.read');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % audit events use policy-v8 capabilities or M10F actions', n; END IF;
END
$$;

DROP TRIGGER "tenant_subscriptions_contract_guard" ON "tenant_subscriptions";
DROP TRIGGER "tenant_subscriptions_price_offer_guard" ON "tenant_subscriptions";
DROP TRIGGER "tenant_subscriptions_lineage_guard" ON "tenant_subscriptions";
DROP TRIGGER "tenant_subscriptions_lineage_account_guard" ON "tenant_subscriptions";
DROP TRIGGER "tenant_account_contexts_contract_guard" ON "tenant_account_contexts";
ALTER TABLE "tenant_subscriptions"
  DROP CONSTRAINT "tenant_subscriptions_agreement_ref_all_or_none",
  DROP CONSTRAINT "tenant_subscriptions_agreement_ref_format",
  DROP CONSTRAINT "tenant_subscriptions_not_superseding_self",
  DROP CONSTRAINT "tenant_subscriptions_agreement_ref_system_fkey",
  DROP CONSTRAINT "tenant_subscriptions_tenant_id_contract_id_fkey",
  DROP CONSTRAINT "tenant_subscriptions_tenant_id_price_offer_id_fkey",
  DROP CONSTRAINT "tenant_subscriptions_tenant_id_supersedes_line_id_fkey";
DROP INDEX "tenant_subscriptions_tenant_id_contract_id_idx";
DROP INDEX "tenant_subscriptions_tenant_id_price_offer_id_idx";
DROP INDEX "tenant_subscriptions_tenant_id_supersedes_line_id_idx";
DROP INDEX "tenant_subscriptions_agreement_ref_idx";
ALTER TABLE "tenant_subscriptions"
  DROP COLUMN "agreement_ref_system",
  DROP COLUMN "agreement_ref_object_type",
  DROP COLUMN "agreement_ref_external_id",
  DROP COLUMN "contract_id",
  DROP COLUMN "price_offer_id",
  DROP COLUMN "supersedes_line_id";
ALTER TABLE "tenant_source_authority_versions"
  DROP CONSTRAINT "tenant_source_authority_versions_tenant_id_price_offer_fkey",
  DROP CONSTRAINT "tenant_source_authority_versions_tenant_id_contract_fkey",
  DROP CONSTRAINT "tenant_source_authority_versions_tenant_id_entitlement_fkey";
ALTER TABLE "tenant_source_authority_versions"
  DROP COLUMN "price_offer_connection_id",
  DROP COLUMN "contract_connection_id",
  DROP COLUMN "entitlement_connection_id";
DROP TABLE "tenant_entitlements";
DROP TABLE "tenant_contracts";
DROP TABLE "tenant_price_offers";
DROP FUNCTION "app_price_offer_guard"();
DROP FUNCTION "app_commercial_touch"();
DROP FUNCTION "app_contract_graph_guard"();
DROP FUNCTION "app_contract_link_account_guard"();
DROP FUNCTION "app_contract_context_guard"();
DROP FUNCTION "app_line_contract_guard"();
DROP FUNCTION "app_line_price_offer_guard"();
DROP FUNCTION "app_line_lineage_guard"();
DROP FUNCTION "app_line_lineage_account_guard"();

ALTER TABLE "tenant_entity_index" DROP CONSTRAINT "tenant_entity_index_kind_valid";
ALTER TABLE "tenant_entity_index"
  ADD CONSTRAINT "tenant_entity_index_kind_valid" CHECK ("kind" IN ('company', 'person', 'product', 'subscription', 'person_affiliation', 'custom_record', 'account_context'));
ALTER TABLE "tenant_source_references" DROP CONSTRAINT "tenant_source_references_entity_kind_valid";
ALTER TABLE "tenant_source_references"
  ADD CONSTRAINT "tenant_source_references_entity_kind_valid" CHECK ("entity_kind" IN ('product', 'person_affiliation', 'custom_record', 'account_context'));
ALTER TABLE "tenant_context_changes" DROP CONSTRAINT "tenant_context_changes_entity_kind_valid";
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'custom_relationship', 'account_context', 'account_context_person'));
ALTER TABLE "tenant_value_history" DROP CONSTRAINT "tenant_value_history_field_valid";
ALTER TABLE "tenant_value_history"
  ADD CONSTRAINT "tenant_value_history_field_valid" CHECK (("entity_kind", "field") IN (('company', 'name'), ('company', 'parent_company_id'), ('subscription', 'state'), ('subscription', 'starts_at'), ('subscription', 'ends_at'), ('subscription', 'product_key'), ('subscription', 'quantity'), ('subscription', 'context_id'), ('person_affiliation', 'status'), ('person_affiliation', 'starts_at'), ('person_affiliation', 'ends_at'), ('person_affiliation', 'role_codes'), ('account_context', 'owner_ref'), ('account_context', 'status'))
    OR ("field" ~ '^ext:[a-z][a-z0-9_]{0,62}$' AND "entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context')));
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_kind_valid" CHECK ("kind" IN ('shared_email', 'merge_across_systems', 'ambiguous_primary_company', 'hierarchy_cycle_refused', 'hierarchy_depth_exceeded', 'hierarchy_parent_merged', 'hierarchy_parent_unresolved', 'hierarchy_human_override_disagrees', 'affiliation_endpoint_unresolved', 'extension_value_conflict', 'extension_human_override_disagrees', 'extension_reference_unresolved', 'custom_record_parent_unresolved', 'custom_relationship_endpoint_unresolved', 'account_context_merge_collision', 'account_context_company_mismatch', 'account_context_human_override_disagrees', 'account_context_reference_unresolved'));
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_entity_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context'));
ALTER TABLE "tenant_extension_values" DROP CONSTRAINT "tenant_extension_values_target_kind_valid";
ALTER TABLE "tenant_extension_values"
  ADD CONSTRAINT "tenant_extension_values_target_kind_valid" CHECK ("target_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context'));
ALTER TABLE "tenant_extension_values" DROP CONSTRAINT "tenant_extension_values_ref_kind_valid";
ALTER TABLE "tenant_extension_values"
  ADD CONSTRAINT "tenant_extension_values_ref_kind_valid" CHECK ("value_ref_kind" IS NULL OR "value_ref_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context'));
ALTER TABLE "tenant_custom_relationships" DROP CONSTRAINT "tenant_custom_relationships_from_kind_valid";
ALTER TABLE "tenant_custom_relationships"
  ADD CONSTRAINT "tenant_custom_relationships_from_kind_valid" CHECK ("from_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context'));
ALTER TABLE "tenant_custom_relationships" DROP CONSTRAINT "tenant_custom_relationships_to_kind_valid";
ALTER TABLE "tenant_custom_relationships"
  ADD CONSTRAINT "tenant_custom_relationships_to_kind_valid" CHECK ("to_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context'));

ALTER TABLE "canonical_modules" NO FORCE ROW LEVEL SECURITY;
UPDATE "canonical_modules" SET "available" = false, "minimum_canonical_version" = NULL WHERE "module_key" = 'commercial';
ALTER TABLE "canonical_modules" FORCE ROW LEVEL SECURITY;

ALTER TABLE "canonical_model_versions" NO FORCE ROW LEVEL SECURITY;
DELETE FROM "canonical_model_versions" WHERE "version" = '0.6';
UPDATE "canonical_model_versions" SET "status" = 'current' WHERE "version" = '0.5';
ALTER TABLE "canonical_model_versions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry', 'config.canonical.adopt', 'config.module.change', 'config.registry.publish', 'config.data_policy.publish', 'config.mapping.draft', 'config.mapping.retire', 'security.integrity.run', 'canonical.evidence.link', 'data.provenance.read', 'data.account_structure.read', 'data.extension.read', 'data.account_context.read', 'data.account_context.read_confidential', 'security.capability.grant')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied', 'canonical.adopt', 'module.enable', 'module.disable', 'module.configure', 'registry.publish', 'data_policy.publish', 'mapping.draft.save', 'mapping.draft.validate', 'mapping.draft.discard', 'mapping.retire', 'integrity.verify', 'provenance.read', 'evidence.link', 'source_reference.observe', 'account.hierarchy.set', 'account.hierarchy.clear', 'account.hierarchy.release', 'person.affiliation.add', 'person.affiliation.end', 'person.affiliation.release', 'account_structure.read', 'extension.value.set', 'extension.value.clear', 'extension.value.release', 'extension.record.create', 'extension.record.update', 'extension.record.retire', 'extension.record.reactivate', 'extension.relationship.add', 'extension.relationship.end', 'extension.read', 'account_context.write', 'account_context.retire', 'account_context.member.set', 'account_context.line.assign', 'account_context.release', 'account_context.read', 'capability.grant', 'capability.revoke'));

ALTER TABLE "tenant_capability_grants" DROP CONSTRAINT "tenant_capability_grants_capability_grantable";
ALTER TABLE "tenant_capability_grants"
  ADD CONSTRAINT "tenant_capability_grants_capability_grantable" CHECK ("capability" IN ('data.account_context.read_confidential'));

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270202120000_m10f_commercial';

COMMIT;
