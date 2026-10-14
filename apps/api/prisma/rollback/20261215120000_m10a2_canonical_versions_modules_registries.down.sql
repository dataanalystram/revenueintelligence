-- Rollback of 20261215120000_m10a2_canonical_versions_modules_registries
-- (dev/staging only). Refuses while data M10A1 cannot hold exists: operator
-- adoptions or rollbacks, module settings and their events, registry versions,
-- or audit events naming an M10A2 capability or action. Baseline and
-- new-tenant adoption rows are derived and dropped with the table. Run after
-- the rollback of 20261215130000_m10a2_entity_index_history_lifecycle_integrity.
BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM tenant_canonical_adoptions WHERE reason NOT IN ('baseline', 'new_tenant');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % operator adoptions exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_module_settings;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % module settings exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_registry_versions;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % registry versions exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_audit_events
   WHERE capability NOT IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry') OR action NOT IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % audit events use M10A2 capabilities or actions', n; END IF;
END
$$;

ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied'));

DROP TABLE "tenant_registry_entries";
DROP TABLE "tenant_registry_versions";
DROP TABLE "tenant_module_setting_events";
DROP TABLE "tenant_module_settings";
DROP TABLE "canonical_modules";
DROP TABLE "tenant_canonical_adoptions";
DROP TABLE "canonical_model_versions";
DROP FUNCTION "app_adoption_chain"();
DROP FUNCTION "app_adoption_refuse_app_baseline"();
DROP FUNCTION "app_canonical_single_current"();

DELETE FROM "_prisma_migrations" WHERE migration_name = '20261215120000_m10a2_canonical_versions_modules_registries';

COMMIT;
