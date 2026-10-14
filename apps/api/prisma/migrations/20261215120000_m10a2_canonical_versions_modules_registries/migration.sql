-- Milestone 10A2 (ADR 0027), migration 1 of 2: canonical versions, tenant
-- adoption, module enablement and governed versioned registries.
--   1. canonical_model_versions (platform reference table; `0.1` seeded; the
--      pre-freeze CHECK refuses any MAJOR >= 1 until a freeze migration).
--   2. tenant_canonical_adoptions (append-only) + one `baseline` row per tenant.
--   3. canonical_modules (platform reference; nine keys, all unavailable),
--      tenant_module_settings (never deleted), tenant_module_setting_events
--      (append-only).
--   4. tenant_registry_versions (append-only) and tenant_registry_entries
--      (projection; never deleted).
--   5. Audit capability/action CHECKs widened to the policy-v2 catalogues.
-- Additive only: no existing row is rewritten; backfills insert into new tables.

-- ---------------------------------------------------------------------------
-- Prisma-generated structure
-- ---------------------------------------------------------------------------
-- CreateTable
CREATE TABLE "canonical_model_versions" (
    "version" TEXT NOT NULL,
    "major" SMALLINT NOT NULL,
    "minor" SMALLINT NOT NULL,
    "status" TEXT NOT NULL,
    "released_at" TIMESTAMPTZ(3) NOT NULL,
    "catalogue_hash" TEXT NOT NULL,
    "adr" TEXT NOT NULL,

    CONSTRAINT "canonical_model_versions_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "tenant_canonical_adoptions" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "version" TEXT NOT NULL,
    "previous_version" TEXT,
    "reason" TEXT NOT NULL,
    "adopted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_assurance" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "audit_event_id" UUID,
    "migration_run_id" UUID,

    CONSTRAINT "tenant_canonical_adoptions_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "canonical_modules" (
    "module_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT false,
    "minimum_canonical_version" TEXT,
    "depends_on" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "config_schema_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "canonical_modules_pkey" PRIMARY KEY ("module_key")
);

-- CreateTable
CREATE TABLE "tenant_module_settings" (
    "tenant_id" UUID NOT NULL,
    "module_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_kind" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "updated_by_assurance" TEXT NOT NULL,

    CONSTRAINT "tenant_module_settings_pkey" PRIMARY KEY ("tenant_id","module_key")
);

-- CreateTable
CREATE TABLE "tenant_module_setting_events" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "module_key" TEXT NOT NULL,
    "from_enabled" BOOLEAN,
    "to_enabled" BOOLEAN NOT NULL,
    "from_config_hash" TEXT,
    "to_config_hash" TEXT NOT NULL,
    "base_version" INTEGER NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_assurance" TEXT NOT NULL,
    "reason_code" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "audit_event_id" UUID NOT NULL,

    CONSTRAINT "tenant_module_setting_events_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant_registry_versions" (
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "base_version" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "document_schema_version" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "canonical_version_min" TEXT NOT NULL,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_assurance" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "audit_event_id" UUID NOT NULL,

    CONSTRAINT "tenant_registry_versions_pkey" PRIMARY KEY ("tenant_id","kind","version")
);

-- CreateTable
CREATE TABLE "tenant_registry_entries" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "definition" JSONB NOT NULL,
    "introduced_in" INTEGER NOT NULL,
    "last_changed_in" INTEGER NOT NULL,
    "sensitivity" TEXT,
    "categories" TEXT[],
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_registry_entries_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "canonical_model_versions_major_minor_key" ON "canonical_model_versions"("major", "minor");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_canonical_adoptions_tenant_id_seq_key" ON "tenant_canonical_adoptions"("tenant_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_module_setting_events_tenant_id_module_key_seq_key" ON "tenant_module_setting_events"("tenant_id", "module_key", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_registry_entries_tenant_id_kind_key_key" ON "tenant_registry_entries"("tenant_id", "kind", "key");

-- AddForeignKey
ALTER TABLE "tenant_canonical_adoptions" ADD CONSTRAINT "tenant_canonical_adoptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_canonical_adoptions" ADD CONSTRAINT "tenant_canonical_adoptions_version_fkey" FOREIGN KEY ("version") REFERENCES "canonical_model_versions"("version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_canonical_adoptions" ADD CONSTRAINT "tenant_canonical_adoptions_previous_version_fkey" FOREIGN KEY ("previous_version") REFERENCES "canonical_model_versions"("version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_canonical_adoptions" ADD CONSTRAINT "tenant_canonical_adoptions_tenant_id_audit_event_id_fkey" FOREIGN KEY ("tenant_id", "audit_event_id") REFERENCES "tenant_audit_events"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "canonical_modules" ADD CONSTRAINT "canonical_modules_minimum_canonical_version_fkey" FOREIGN KEY ("minimum_canonical_version") REFERENCES "canonical_model_versions"("version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_module_settings" ADD CONSTRAINT "tenant_module_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_module_settings" ADD CONSTRAINT "tenant_module_settings_module_key_fkey" FOREIGN KEY ("module_key") REFERENCES "canonical_modules"("module_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_module_setting_events" ADD CONSTRAINT "tenant_module_setting_events_tenant_id_module_key_fkey" FOREIGN KEY ("tenant_id", "module_key") REFERENCES "tenant_module_settings"("tenant_id", "module_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_module_setting_events" ADD CONSTRAINT "tenant_module_setting_events_tenant_id_audit_event_id_fkey" FOREIGN KEY ("tenant_id", "audit_event_id") REFERENCES "tenant_audit_events"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_registry_versions" ADD CONSTRAINT "tenant_registry_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_registry_versions" ADD CONSTRAINT "tenant_registry_versions_canonical_version_min_fkey" FOREIGN KEY ("canonical_version_min") REFERENCES "canonical_model_versions"("version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_registry_versions" ADD CONSTRAINT "tenant_registry_versions_tenant_id_audit_event_id_fkey" FOREIGN KEY ("tenant_id", "audit_event_id") REFERENCES "tenant_audit_events"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_registry_entries" ADD CONSTRAINT "tenant_registry_entries_tenant_id_kind_introduced_in_fkey" FOREIGN KEY ("tenant_id", "kind", "introduced_in") REFERENCES "tenant_registry_versions"("tenant_id", "kind", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_registry_entries" ADD CONSTRAINT "tenant_registry_entries_tenant_id_kind_last_changed_in_fkey" FOREIGN KEY ("tenant_id", "kind", "last_changed_in") REFERENCES "tenant_registry_versions"("tenant_id", "kind", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 1. Canonical model versions (platform reference table)
-- ---------------------------------------------------------------------------
ALTER TABLE "canonical_model_versions"
  ADD CONSTRAINT "canonical_model_versions_version_format" CHECK ("version" ~ '^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,3})$'),
  ADD CONSTRAINT "canonical_model_versions_parts" CHECK ("version" = "major"::text || '.' || "minor"::text AND "major" >= 0 AND "minor" >= 0),
  ADD CONSTRAINT "canonical_model_versions_status_valid" CHECK ("status" IN ('current', 'supported', 'deprecated', 'unsupported')),
  ADD CONSTRAINT "canonical_model_versions_catalogue_hash_format" CHECK ("catalogue_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "canonical_model_versions_adr_format" CHECK ("adr" ~ '^[0-9]{4}$'),
  -- D1: no 1.0 before the freeze. Only a future freeze migration with its ADR may drop this.
  ADD CONSTRAINT "canonical_model_versions_pre_freeze" CHECK ("major" < 1);

-- Exactly one `current` version (a trigger: Prisma does not model partial indexes).
CREATE FUNCTION "app_canonical_single_current"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'current' AND EXISTS (
       SELECT 1 FROM "canonical_model_versions" v WHERE v."status" = 'current' AND v."version" <> NEW."version") THEN
    RAISE EXCEPTION 'only one canonical model version can be current' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "canonical_model_versions_single_current" BEFORE INSERT OR UPDATE ON "canonical_model_versions"
  FOR EACH ROW EXECUTE FUNCTION app_canonical_single_current();

INSERT INTO "canonical_model_versions" ("version", "major", "minor", "status", "released_at", "catalogue_hash", "adr")
VALUES ('0.1', 0, 1, 'current', '2026-12-15T12:00:00Z', '2fd4f7e575633de7cac4aea394a71c73adc9b73e5e18b67c0b0ee404572faf5b', '0027');

ALTER TABLE "canonical_model_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_model_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "canonical_model_versions_read" ON "canonical_model_versions" FOR SELECT USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "canonical_model_versions" FROM lip_app;
GRANT SELECT ON TABLE "canonical_model_versions" TO lip_app;

-- ---------------------------------------------------------------------------
-- 2. Tenant canonical adoption (append-only; dense seq per tenant)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_canonical_adoptions"
  ADD CONSTRAINT "tenant_canonical_adoptions_seq_positive" CHECK ("seq" > 0),
  ADD CONSTRAINT "tenant_canonical_adoptions_previous_only_after_first" CHECK (("seq" = 1) = ("previous_version" IS NULL)),
  ADD CONSTRAINT "tenant_canonical_adoptions_reason_valid" CHECK ("reason" IN ('baseline', 'new_tenant', 'operator_adoption', 'rollback')),
  ADD CONSTRAINT "tenant_canonical_adoptions_first_reason" CHECK (("seq" = 1) = ("reason" IN ('baseline', 'new_tenant'))),
  -- Q4: only the migration's baseline rows have no audit event.
  ADD CONSTRAINT "tenant_canonical_adoptions_audit_required" CHECK (("audit_event_id" IS NULL) = ("reason" = 'baseline')),
  ADD CONSTRAINT "tenant_canonical_adoptions_actor_kind_valid" CHECK ("actor_kind" IN ('source_sync', 'system', 'operator', 'human_user', 'ai')),
  ADD CONSTRAINT "tenant_canonical_adoptions_actor_id_format" CHECK ("actor_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  ADD CONSTRAINT "tenant_canonical_adoptions_actor_assurance_valid" CHECK ("actor_assurance" IN ('system', 'asserted', 'authenticated')),
  ADD CONSTRAINT "tenant_canonical_adoptions_operator_asserted" CHECK ("actor_kind" <> 'operator' OR "actor_assurance" = 'asserted');

-- The chain is dense and linked: seq = previous + 1, previous_version = the
-- version of the row before.
CREATE FUNCTION "app_adoption_chain"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head record;
BEGIN
  SELECT a."seq", a."version" INTO head FROM "tenant_canonical_adoptions" a
   WHERE a."tenant_id" = NEW."tenant_id" ORDER BY a."seq" DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW."seq" <> 1 THEN
      RAISE EXCEPTION 'adoption chain must start at seq 1' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."seq" <> head."seq" + 1 OR NEW."previous_version" IS DISTINCT FROM head."version" THEN
    RAISE EXCEPTION 'adoption chain broken (expected seq %, previous %)', head."seq" + 1, head."version"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tenant_canonical_adoptions_chain" BEFORE INSERT ON "tenant_canonical_adoptions"
  FOR EACH ROW EXECUTE FUNCTION app_adoption_chain();

-- Baseline (Q4): one `0.1` row per existing tenant, written before RLS is
-- enabled; actor system:migration:m10a2; no audit event (a migration must not
-- forge hash-chain entries).
INSERT INTO "tenant_canonical_adoptions"
  ("tenant_id", "id", "seq", "version", "previous_version", "reason", "adopted_at",
   "actor_kind", "actor_id", "actor_assurance", "correlation_id")
SELECT t."id", gen_random_uuid(), 1, '0.1', NULL, 'baseline', CURRENT_TIMESTAMP,
       'system', 'system:migration:m10a2', 'system', gen_random_uuid()
  FROM "tenants" t;

DO $$
DECLARE
  tenants_n int;
  baseline_n int;
BEGIN
  SELECT count(*) INTO tenants_n FROM "tenants";
  SELECT count(*) INTO baseline_n FROM "tenant_canonical_adoptions" WHERE "reason" = 'baseline' AND "version" = '0.1';
  IF tenants_n <> baseline_n THEN
    RAISE EXCEPTION 'M10A2 baseline adoption count mismatch: % tenants, % baseline rows', tenants_n, baseline_n;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Modules: catalogue (platform reference), tenant settings, setting events
-- ---------------------------------------------------------------------------
ALTER TABLE "canonical_modules"
  ADD CONSTRAINT "canonical_modules_key_valid" CHECK ("module_key" IN ('account_context', 'commercial', 'signals', 'opportunities', 'decision_chain', 'value', 'engagement', 'extension', 'data_quality')),
  ADD CONSTRAINT "canonical_modules_available_has_minimum" CHECK ("available" = ("minimum_canonical_version" IS NOT NULL)),
  ADD CONSTRAINT "canonical_modules_depends_on_valid" CHECK ("depends_on" IS NOT NULL AND "depends_on" <@ ARRAY['account_context', 'commercial', 'signals', 'opportunities', 'decision_chain', 'value', 'engagement', 'extension', 'data_quality']::text[] AND NOT ("module_key" = ANY ("depends_on"))),
  ADD CONSTRAINT "canonical_modules_title_format" CHECK (length("title") BETWEEN 1 AND 100),
  ADD CONSTRAINT "canonical_modules_config_schema_positive" CHECK ("config_schema_version" > 0);

INSERT INTO "canonical_modules" ("module_key", "title", "available", "minimum_canonical_version", "depends_on", "config_schema_version") VALUES
  ('account_context', 'Account context', false, NULL, ARRAY[]::text[], 1),
  ('commercial', 'Commercial', false, NULL, ARRAY[]::text[], 1),
  ('signals', 'Signals', false, NULL, ARRAY['account_context']::text[], 1),
  ('opportunities', 'Opportunities', false, NULL, ARRAY['commercial']::text[], 1),
  ('decision_chain', 'Decision chain', false, NULL, ARRAY['opportunities']::text[], 1),
  ('value', 'Value', false, NULL, ARRAY['commercial']::text[], 1),
  ('engagement', 'Engagement', false, NULL, ARRAY[]::text[], 1),
  ('extension', 'Extensions', false, NULL, ARRAY[]::text[], 1),
  ('data_quality', 'Data quality', false, NULL, ARRAY[]::text[], 1);

ALTER TABLE "canonical_modules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_modules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "canonical_modules_read" ON "canonical_modules" FOR SELECT USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "canonical_modules" FROM lip_app;
GRANT SELECT ON TABLE "canonical_modules" TO lip_app;

ALTER TABLE "tenant_module_settings"
  ADD CONSTRAINT "tenant_module_settings_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "tenant_module_settings_config_object" CHECK (jsonb_typeof("config") = 'object' AND octet_length("config"::text) <= 4096),
  ADD CONSTRAINT "tenant_module_settings_config_no_secrets" CHECK (NOT app_jsonb_has_secret_like_key("config")),
  ADD CONSTRAINT "tenant_module_settings_actor_kind_valid" CHECK ("updated_by_kind" IN ('source_sync', 'system', 'operator', 'human_user', 'ai')),
  ADD CONSTRAINT "tenant_module_settings_actor_id_format" CHECK ("updated_by_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  ADD CONSTRAINT "tenant_module_settings_actor_assurance_valid" CHECK ("updated_by_assurance" IN ('system', 'asserted', 'authenticated')),
  ADD CONSTRAINT "tenant_module_settings_operator_asserted" CHECK ("updated_by_kind" <> 'operator' OR "updated_by_assurance" = 'asserted');

ALTER TABLE "tenant_module_setting_events"
  ADD CONSTRAINT "tenant_module_setting_events_seq_positive" CHECK ("seq" > 0),
  ADD CONSTRAINT "tenant_module_setting_events_base_version" CHECK ("base_version" >= 0),
  ADD CONSTRAINT "tenant_module_setting_events_hash_format" CHECK (("from_config_hash" IS NULL OR "from_config_hash" ~ '^[0-9a-f]{64}$') AND "to_config_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_module_setting_events_reason_format" CHECK ("reason_code" IS NULL OR "reason_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD CONSTRAINT "tenant_module_setting_events_actor_kind_valid" CHECK ("actor_kind" IN ('source_sync', 'system', 'operator', 'human_user', 'ai')),
  ADD CONSTRAINT "tenant_module_setting_events_actor_id_format" CHECK ("actor_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  ADD CONSTRAINT "tenant_module_setting_events_actor_assurance_valid" CHECK ("actor_assurance" IN ('system', 'asserted', 'authenticated')),
  ADD CONSTRAINT "tenant_module_setting_events_operator_asserted" CHECK ("actor_kind" <> 'operator' OR "actor_assurance" = 'asserted');

-- ---------------------------------------------------------------------------
-- 4. Governed versioned registries
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_registry_versions"
  ADD CONSTRAINT "tenant_registry_versions_kind_valid" CHECK ("kind" IN ('data_policy', 'signal_type', 'metric', 'action_type', 'context_type', 'extension')),
  ADD CONSTRAINT "tenant_registry_versions_version_positive" CHECK ("version" > 0 AND "base_version" = "version" - 1),
  ADD CONSTRAINT "tenant_registry_versions_document_object" CHECK (jsonb_typeof("document") = 'object' AND octet_length("document"::text) <= 262144),
  ADD CONSTRAINT "tenant_registry_versions_document_no_secrets" CHECK (NOT app_jsonb_has_secret_like_key("document")),
  ADD CONSTRAINT "tenant_registry_versions_schema_version_positive" CHECK ("document_schema_version" > 0),
  ADD CONSTRAINT "tenant_registry_versions_content_hash_format" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_registry_versions_actor_kind_valid" CHECK ("actor_kind" IN ('source_sync', 'system', 'operator', 'human_user', 'ai')),
  ADD CONSTRAINT "tenant_registry_versions_actor_id_format" CHECK ("actor_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  ADD CONSTRAINT "tenant_registry_versions_actor_assurance_valid" CHECK ("actor_assurance" IN ('system', 'asserted', 'authenticated')),
  ADD CONSTRAINT "tenant_registry_versions_operator_asserted" CHECK ("actor_kind" <> 'operator' OR "actor_assurance" = 'asserted');

ALTER TABLE "tenant_registry_entries"
  ADD CONSTRAINT "tenant_registry_entries_kind_valid" CHECK ("kind" IN ('data_policy', 'signal_type', 'metric', 'action_type', 'context_type', 'extension')),
  ADD CONSTRAINT "tenant_registry_entries_key_format" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,62}$'),
  ADD CONSTRAINT "tenant_registry_entries_status_valid" CHECK ("status" IN ('active', 'retired', 'promoted')),
  ADD CONSTRAINT "tenant_registry_entries_definition_object" CHECK (jsonb_typeof("definition") = 'object' AND octet_length("definition"::text) <= 65536),
  ADD CONSTRAINT "tenant_registry_entries_definition_no_secrets" CHECK (NOT app_jsonb_has_secret_like_key("definition")),
  ADD CONSTRAINT "tenant_registry_entries_versions_ordered" CHECK ("introduced_in" <= "last_changed_in"),
  ADD CONSTRAINT "tenant_registry_entries_classification_pair" CHECK (("sensitivity" IS NULL) = ("categories" IS NULL)),
  ADD CONSTRAINT "tenant_registry_entries_sensitivity_valid" CHECK ("sensitivity" IS NULL OR "sensitivity" IN ('public', 'internal', 'confidential', 'restricted')),
  ADD CONSTRAINT "tenant_registry_entries_categories_valid" CHECK ("categories" IS NULL OR (cardinality("categories") > 0 AND "categories" <@ ARRAY['personal', 'financial', 'communication', 'operational', 'commercial', 'security']::text[])),
  -- F3 floors: personal, financial, security and communication need at least confidential.
  ADD CONSTRAINT "tenant_registry_entries_floor" CHECK ("categories" IS NULL OR NOT ("categories" && ARRAY['personal', 'financial', 'communication', 'security']::text[]) OR "sensitivity" IN ('confidential', 'restricted'));

-- ---------------------------------------------------------------------------
-- 5. Tenant isolation and append-only protection for the new tenant tables
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_canonical_adoptions', 'tenant_module_settings', 'tenant_module_setting_events',
                           'tenant_registry_versions', 'tenant_registry_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change()',
      t || '_tenant_immutable', t);
  END LOOP;
END
$$;

CREATE TRIGGER "tenant_canonical_adoptions_append_only" BEFORE UPDATE OR DELETE ON "tenant_canonical_adoptions"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('canonical adoptions are append-only');
CREATE TRIGGER "tenant_module_setting_events_append_only" BEFORE UPDATE OR DELETE ON "tenant_module_setting_events"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('module setting events are append-only');
CREATE TRIGGER "tenant_registry_versions_append_only" BEFORE UPDATE OR DELETE ON "tenant_registry_versions"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('registry versions are append-only');
-- F4 / X1: settings and projected entries are never physically deleted.
CREATE TRIGGER "tenant_module_settings_no_delete" BEFORE DELETE ON "tenant_module_settings"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('module settings are never deleted');
CREATE TRIGGER "tenant_registry_entries_no_delete" BEFORE DELETE ON "tenant_registry_entries"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('registry entries are never deleted');

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_canonical_adoptions" FROM lip_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_module_setting_events" FROM lip_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_registry_versions" FROM lip_app;
REVOKE DELETE, TRUNCATE ON TABLE "tenant_module_settings" FROM lip_app;
REVOKE DELETE, TRUNCATE ON TABLE "tenant_registry_entries" FROM lip_app;

-- ---------------------------------------------------------------------------
-- 6. Audit catalogues: policy v2 capabilities and the M10A2 actions
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry', 'config.canonical.adopt', 'config.module.change', 'config.registry.publish', 'config.data_policy.publish', 'config.mapping.draft', 'config.mapping.retire', 'security.integrity.run')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied', 'canonical.adopt', 'module.enable', 'module.disable', 'module.configure', 'registry.publish', 'data_policy.publish', 'mapping.draft.save', 'mapping.draft.validate', 'mapping.draft.discard', 'mapping.retire', 'integrity.verify'));
