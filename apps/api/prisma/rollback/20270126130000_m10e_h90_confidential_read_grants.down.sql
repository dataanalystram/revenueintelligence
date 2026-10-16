-- Down-script for 20270126130000_m10e_h90_confidential_read_grants (M10E
-- hardening #90, ADR 0031 addendum). Development and staging only:
-- production policy is forward-fix (revoke grants instead). Run with the owner
-- credentials, before the M10E down-script:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20270126130000_m10e_h90_confidential_read_grants.down.sql
--
-- Refuses (and changes nothing) while any capability grant row (active or
-- revoked) exists, or any audit event names a policy-v7 capability or action.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM tenant_capability_grants;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % capability grants exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_audit_events
    WHERE capability IN ('data.account_context.read_confidential', 'security.capability.grant')
       OR action IN ('capability.grant', 'capability.revoke');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % audit events use policy-v7 capabilities or actions', n; END IF;
END
$$;

DROP TABLE "tenant_capability_grants";
DROP FUNCTION "app_capability_grant_guard"();

ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry', 'config.canonical.adopt', 'config.module.change', 'config.registry.publish', 'config.data_policy.publish', 'config.mapping.draft', 'config.mapping.retire', 'security.integrity.run', 'canonical.evidence.link', 'data.provenance.read', 'data.account_structure.read', 'data.extension.read', 'data.account_context.read')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied', 'canonical.adopt', 'module.enable', 'module.disable', 'module.configure', 'registry.publish', 'data_policy.publish', 'mapping.draft.save', 'mapping.draft.validate', 'mapping.draft.discard', 'mapping.retire', 'integrity.verify', 'provenance.read', 'evidence.link', 'source_reference.observe', 'account.hierarchy.set', 'account.hierarchy.clear', 'account.hierarchy.release', 'person.affiliation.add', 'person.affiliation.end', 'person.affiliation.release', 'account_structure.read', 'extension.value.set', 'extension.value.clear', 'extension.value.release', 'extension.record.create', 'extension.record.update', 'extension.record.retire', 'extension.record.reactivate', 'extension.relationship.add', 'extension.relationship.end', 'extension.read', 'account_context.write', 'account_context.retire', 'account_context.member.set', 'account_context.line.assign', 'account_context.release', 'account_context.read'));

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270126130000_m10e_h90_confidential_read_grants';

COMMIT;
