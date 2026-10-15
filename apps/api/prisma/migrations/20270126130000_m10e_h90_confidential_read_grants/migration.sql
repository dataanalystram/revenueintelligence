-- M10E hardening #90 (ADR 0031 addendum, docs/tech-debt.md #90): confidential
-- AccountContext reads need their own capability (policy v7).
--   1. tenant_capability_grants: explicit, tenant-scoped grants of a closed list
--      of capabilities (only data.account_context.read_confidential) to one
--      operator id. One row per (tenant, grantee, capability); a revoke clears
--      `active` and a re-grant sets it again (history: the grant / revoke audit
--      events). No self-grant. Identity columns immutable; never deleted.
--   2. Audit capability / action CHECKs widened to policy v7
--      (data.account_context.read_confidential, security.capability.grant;
--      capability.grant, capability.revoke).
--   3. Forced RLS, tenant policy, tenant-id immutability and privileges
--      (SELECT / INSERT / UPDATE; no DELETE).
-- Additive only. No backfill: no operator is granted anything by migration.

-- ---------------------------------------------------------------------------
-- Prisma-generated structure
-- ---------------------------------------------------------------------------
-- CreateTable
CREATE TABLE "tenant_capability_grants" (
    "tenant_id" UUID NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL,
    "granted_by_kind" TEXT NOT NULL,
    "granted_by_id" TEXT NOT NULL,
    "granted_by_assurance" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_kind" TEXT,
    "revoked_by_id" TEXT,
    "revoked_by_assurance" TEXT,

    CONSTRAINT "tenant_capability_grants_pkey" PRIMARY KEY ("tenant_id","actor_kind","actor_id","capability")
);

-- AddForeignKey
ALTER TABLE "tenant_capability_grants" ADD CONSTRAINT "tenant_capability_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 1. Grant rules (closed capability list = GRANTABLE_CAPABILITIES in code)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_capability_grants"
  ADD CONSTRAINT "tenant_capability_grants_capability_grantable" CHECK ("capability" IN ('data.account_context.read_confidential')),
  ADD CONSTRAINT "tenant_capability_grants_grantee_operator" CHECK ("actor_kind" = 'operator'),
  ADD CONSTRAINT "tenant_capability_grants_actor_id_format" CHECK ("actor_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  ADD CONSTRAINT "tenant_capability_grants_granted_by_operator" CHECK ("granted_by_kind" = 'operator' AND "granted_by_assurance" = 'asserted' AND "granted_by_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  ADD CONSTRAINT "tenant_capability_grants_no_self_grant" CHECK ("granted_by_id" <> "actor_id"),
  ADD CONSTRAINT "tenant_capability_grants_revoked_by_operator" CHECK ("revoked_by_kind" IS NULL OR ("revoked_by_kind" = 'operator' AND "revoked_by_assurance" = 'asserted' AND "revoked_by_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$')),
  ADD CONSTRAINT "tenant_capability_grants_revocation_state" CHECK (("active" AND "revoked_at" IS NULL AND "revoked_by_kind" IS NULL AND "revoked_by_id" IS NULL AND "revoked_by_assurance" IS NULL) OR (NOT "active" AND "revoked_at" IS NOT NULL AND "revoked_by_kind" IS NOT NULL AND "revoked_by_id" IS NOT NULL AND "revoked_by_assurance" IS NOT NULL)),
  ADD CONSTRAINT "tenant_capability_grants_version_positive" CHECK ("version" > 0);

CREATE FUNCTION "app_capability_grant_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.actor_kind IS DISTINCT FROM OLD.actor_kind OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.capability IS DISTINCT FROM OLD.capability THEN
    RAISE EXCEPTION 'capability_grant_identity_immutable' USING ERRCODE = 'check_violation',
      DETAIL = format('grant of %s', OLD.capability);
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'capability_grant_version_not_incremented' USING ERRCODE = 'check_violation',
      DETAIL = format('grant of %s', OLD.capability);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_capability_grant_guard"() FROM PUBLIC;
CREATE TRIGGER "tenant_capability_grants_guard" BEFORE UPDATE ON "tenant_capability_grants"
  FOR EACH ROW EXECUTE FUNCTION app_capability_grant_guard();

-- ---------------------------------------------------------------------------
-- 2. Audit catalogues: policy v7 capabilities and actions
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry', 'config.canonical.adopt', 'config.module.change', 'config.registry.publish', 'config.data_policy.publish', 'config.mapping.draft', 'config.mapping.retire', 'security.integrity.run', 'canonical.evidence.link', 'data.provenance.read', 'data.account_structure.read', 'data.extension.read', 'data.account_context.read', 'data.account_context.read_confidential', 'security.capability.grant')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied', 'canonical.adopt', 'module.enable', 'module.disable', 'module.configure', 'registry.publish', 'data_policy.publish', 'mapping.draft.save', 'mapping.draft.validate', 'mapping.draft.discard', 'mapping.retire', 'integrity.verify', 'provenance.read', 'evidence.link', 'source_reference.observe', 'account.hierarchy.set', 'account.hierarchy.clear', 'account.hierarchy.release', 'person.affiliation.add', 'person.affiliation.end', 'person.affiliation.release', 'account_structure.read', 'extension.value.set', 'extension.value.clear', 'extension.value.release', 'extension.record.create', 'extension.record.update', 'extension.record.retire', 'extension.record.reactivate', 'extension.relationship.add', 'extension.relationship.end', 'extension.read', 'account_context.write', 'account_context.retire', 'account_context.member.set', 'account_context.line.assign', 'account_context.release', 'account_context.read', 'capability.grant', 'capability.revoke'));

-- ---------------------------------------------------------------------------
-- 3. Tenant isolation and privileges
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_capability_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_capability_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_capability_grants"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE TRIGGER "tenant_capability_grants_tenant_immutable" BEFORE UPDATE ON "tenant_capability_grants"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();
REVOKE ALL ON TABLE "tenant_capability_grants" FROM lip_app;
-- Grants are revoked (active = false), never deleted.
GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_capability_grants" TO lip_app;
