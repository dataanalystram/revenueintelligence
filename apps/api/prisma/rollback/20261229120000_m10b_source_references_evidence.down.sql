-- Down-script for 20261229120000_m10b_source_references_evidence (Milestone 10B,
-- ADR 0028). Development and staging only: production policy is forward-fix
-- (tenant-level rollback = adoption back to 0.1). Run with the owner
-- credentials, before the M10A2 down-scripts:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261229120000_m10b_source_references_evidence.down.sql
--
-- Refuses (and changes nothing) while data the M10A2 schema cannot hold
-- exists: an observed source reference, a reference that has changed since the
-- backfill (last_change_id set or not active), any evidence link, any change
-- record of entity kind product (or with entity_key), any adoption of 0.2
-- (including new tenants provisioned at 0.2), or audit events naming an M10B
-- capability or action. The declared-reference backfill is derived from the
-- product models and is dropped.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM tenant_source_references WHERE origin <> 'declared';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % observed source references exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_source_references WHERE last_change_id IS NOT NULL OR state <> 'active';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % source references changed after the backfill', n; END IF;
  SELECT count(*) INTO n FROM tenant_evidence_links;
  SELECT count(*) INTO n FROM tenant_context_changes WHERE entity_kind = 'product' OR entity_key IS NOT NULL OR entity_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % product change records exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_canonical_adoptions WHERE version = '0.2' OR previous_version = '0.2';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % adoptions of canonical 0.2 exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_audit_events
   WHERE capability IN ('canonical.evidence.link', 'data.provenance.read')
      OR action IN ('provenance.read', 'evidence.link', 'source_reference.observe');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % audit events use M10B capabilities or actions', n; END IF;
END
$$;

DROP VIEW "source_reference_index";
DROP TABLE "tenant_evidence_links";
DROP TABLE "tenant_source_references";
DROP FUNCTION "app_source_reference_identity_immutable"();

DROP INDEX "tenant_context_changes_tenant_id_entity_kind_entity_key_ing_idx";
ALTER TABLE "tenant_context_changes"
  DROP CONSTRAINT "tenant_context_changes_entity_kind_valid",
  DROP CONSTRAINT "tenant_context_changes_one_identity",
  DROP CONSTRAINT "tenant_context_changes_key_only_for_products",
  DROP COLUMN "entity_key",
  ALTER COLUMN "entity_id" SET NOT NULL;
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription'));

ALTER TABLE "canonical_model_versions" NO FORCE ROW LEVEL SECURITY;
DELETE FROM "canonical_model_versions" WHERE "version" = '0.2';
UPDATE "canonical_model_versions" SET "status" = 'current' WHERE "version" = '0.1';
ALTER TABLE "canonical_model_versions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry', 'config.canonical.adopt', 'config.module.change', 'config.registry.publish', 'config.data_policy.publish', 'config.mapping.draft', 'config.mapping.retire', 'security.integrity.run')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied', 'canonical.adopt', 'module.enable', 'module.disable', 'module.configure', 'registry.publish', 'data_policy.publish', 'mapping.draft.save', 'mapping.draft.validate', 'mapping.draft.discard', 'mapping.retire', 'integrity.verify'));

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261229120000_m10b_source_references_evidence';

COMMIT;
