-- Milestone 8 (ADR 0019): connector-kind catalogue and tenant source connections.
--
-- * `connector_kinds` is platform reference data (no tenant), mirrored from
--   `domain/connector-kinds.ts`. The application role may only read it.
-- * Every source-system column references it by foreign key; the duplicated
--   CHECK lists are dropped. Stored values are unchanged (`sugar` stays
--   `sugar`); no data is rewritten.
-- * `tenant_source_connections`: one connection per tenant and kind, non-secret
--   configuration only, credential NAMES only.
-- * Provenance and run records gain the connection and mapping version.

-- ---------------------------------------------------------------------------
-- 1. Connector-kind catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE "connector_kinds" (
    "kind" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "has_adapter" BOOLEAN NOT NULL,

    CONSTRAINT "connector_kinds_pkey" PRIMARY KEY ("kind")
);

ALTER TABLE "connector_kinds"
  ADD CONSTRAINT "connector_kinds_kind_format" CHECK ("kind" ~ '^[a-z][a-z0-9_]{1,39}$'),
  ADD CONSTRAINT "connector_kinds_display_name_present" CHECK (length(btrim("display_name")) BETWEEN 1 AND 100);

INSERT INTO "connector_kinds" ("kind", "display_name", "has_adapter") VALUES
  ('hubspot', 'HubSpot', true),
  ('sugar', 'SugarCRM', true),
  ('gainsight_cs', 'Gainsight CS', false),
  ('gainsight_px', 'Gainsight PX', false),
  ('import', 'Operator import (CSV)', true);

-- Readable by everyone (platform data, no tenant); written only by migrations.
ALTER TABLE "connector_kinds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connector_kinds" FORCE ROW LEVEL SECURITY;
CREATE POLICY "connector_kinds_read" ON "connector_kinds" FOR SELECT USING (true);
-- The default privileges grant every new table to lip_app; this one is read-only.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "connector_kinds" FROM lip_app;
GRANT SELECT ON TABLE "connector_kinds" TO lip_app;

-- ---------------------------------------------------------------------------
-- 2. Source-system CHECK lists → foreign keys (values unchanged)
-- ---------------------------------------------------------------------------
ALTER TABLE "company_external_refs" DROP CONSTRAINT "company_external_refs_system_valid";
ALTER TABLE "person_external_refs" DROP CONSTRAINT "person_external_refs_system_valid";
ALTER TABLE "tenant_context_changes" DROP CONSTRAINT "tenant_context_changes_system_valid";
ALTER TABLE "tenant_source_relationships" DROP CONSTRAINT "tenant_source_relationships_system_valid";
ALTER TABLE "tenant_sync_checkpoints" DROP CONSTRAINT "tenant_sync_checkpoints_system_valid";
ALTER TABLE "tenant_subscriptions" DROP CONSTRAINT "tenant_subscriptions_source_system_valid";
-- The dead-letter subject CHECK also validated the system; keep the rest of it.
ALTER TABLE "tenant_dead_letters"
  DROP CONSTRAINT "tenant_dead_letters_subject_format",
  ADD CONSTRAINT "tenant_dead_letters_subject_format" CHECK (
    ("subject_kind" IS NULL OR "subject_kind" IN ('company', 'person')) AND
    ("subject_external_id" IS NULL OR "subject_external_id" ~ '^[A-Za-z0-9_.-]{1,255}$'));

ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_source_system_fkey" FOREIGN KEY ("source_system") REFERENCES "connector_kinds"("kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "company_external_refs" ADD CONSTRAINT "company_external_refs_system_fkey" FOREIGN KEY ("system") REFERENCES "connector_kinds"("kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "person_external_refs" ADD CONSTRAINT "person_external_refs_system_fkey" FOREIGN KEY ("system") REFERENCES "connector_kinds"("kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_context_changes" ADD CONSTRAINT "tenant_context_changes_source_system_fkey" FOREIGN KEY ("source_system") REFERENCES "connector_kinds"("kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_source_relationships" ADD CONSTRAINT "tenant_source_relationships_system_fkey" FOREIGN KEY ("system") REFERENCES "connector_kinds"("kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_dead_letters" ADD CONSTRAINT "tenant_dead_letters_subject_system_fkey" FOREIGN KEY ("subject_system") REFERENCES "connector_kinds"("kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_sync_checkpoints" ADD CONSTRAINT "tenant_sync_checkpoints_system_fkey" FOREIGN KEY ("system") REFERENCES "connector_kinds"("kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- External references, relationships and dead-letter subjects never named
-- `import` before M8 (an operator file is not a system of record): keep that.
ALTER TABLE "company_external_refs" ADD CONSTRAINT "company_external_refs_system_not_import" CHECK ("system" <> 'import');
ALTER TABLE "person_external_refs" ADD CONSTRAINT "person_external_refs_system_not_import" CHECK ("system" <> 'import');
ALTER TABLE "tenant_source_relationships" ADD CONSTRAINT "tenant_source_relationships_system_not_import" CHECK ("system" <> 'import');
ALTER TABLE "tenant_dead_letters" ADD CONSTRAINT "tenant_dead_letters_subject_system_not_import" CHECK ("subject_system" IS NULL OR "subject_system" <> 'import');

-- ---------------------------------------------------------------------------
-- 3. Tenant source connections
-- ---------------------------------------------------------------------------
-- True when a JSON document holds an object key that looks like a secret, at
-- any depth. Keys are compared lower-cased with separators removed.
CREATE FUNCTION "app_jsonb_has_secret_like_key"(doc jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF jsonb_typeof(doc) = 'object' THEN
    FOR k, v IN SELECT * FROM jsonb_each(doc) LOOP
      IF regexp_replace(lower(k), '[^a-z0-9]', '', 'g')
           ~ '(secret|password|passwd|passphrase|token|apikey|privatekey|accesskey|credential|bearer|authorization|cookie)' THEN
        RETURN true;
      END IF;
      IF app_jsonb_has_secret_like_key(v) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(doc) = 'array' THEN
    FOR v IN SELECT * FROM jsonb_array_elements(doc) LOOP
      IF app_jsonb_has_secret_like_key(v) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;
GRANT EXECUTE ON FUNCTION "app_jsonb_has_secret_like_key"(jsonb) TO lip_app;

CREATE TABLE "tenant_source_connections" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'disabled',
    "mapping_mode" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "credential_name" TEXT,
    "last_test_code" TEXT,
    "last_tested_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_source_connections_pkey" PRIMARY KEY ("tenant_id","id")
);

CREATE UNIQUE INDEX "tenant_source_connections_tenant_id_kind_key" ON "tenant_source_connections"("tenant_id", "kind");
ALTER TABLE "tenant_source_connections" ADD CONSTRAINT "tenant_source_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_source_connections" ADD CONSTRAINT "tenant_source_connections_kind_fkey" FOREIGN KEY ("kind") REFERENCES "connector_kinds"("kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A credential name must be registered for this tenant and kind (values stay in the SecretProvider).
ALTER TABLE "tenant_source_connections" ADD CONSTRAINT "tenant_source_connections_tenant_id_kind_credential_name_fkey" FOREIGN KEY ("tenant_id", "kind", "credential_name") REFERENCES "tenant_credential_refs"("tenant_id", "system", "name") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_source_connections"
  ADD CONSTRAINT "tenant_source_connections_label_valid" CHECK (length(btrim("label")) BETWEEN 1 AND 100 AND "label" !~ '[[:cntrl:]]'),
  ADD CONSTRAINT "tenant_source_connections_status_valid" CHECK ("status" IN ('enabled', 'disabled')),
  ADD CONSTRAINT "tenant_source_connections_mapping_mode_valid" CHECK ("mapping_mode" IN ('versioned', 'code')),
  ADD CONSTRAINT "tenant_source_connections_config_object" CHECK (jsonb_typeof("config") = 'object' AND octet_length("config"::text) <= 8192),
  ADD CONSTRAINT "tenant_source_connections_config_no_secrets" CHECK (NOT app_jsonb_has_secret_like_key("config")),
  ADD CONSTRAINT "tenant_source_connections_credential_name_format" CHECK ("credential_name" IS NULL OR "credential_name" ~ '^[a-z][a-z0-9_]{1,62}$'),
  ADD CONSTRAINT "tenant_source_connections_test_code_format" CHECK ("last_test_code" IS NULL OR "last_test_code" ~ '^[a-z0-9_]{1,64}$'),
  ADD CONSTRAINT "tenant_source_connections_test_consistent" CHECK (("last_test_code" IS NULL) = ("last_tested_at" IS NULL));

ALTER TABLE "tenant_source_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_source_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_source_connections"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE TRIGGER "tenant_source_connections_tenant_immutable" BEFORE UPDATE ON "tenant_source_connections"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();

-- ---------------------------------------------------------------------------
-- 4. Provenance and run records: connection and mapping version (ADR 0020)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_context_changes" ADD COLUMN     "mapping_version" INTEGER,
ADD COLUMN     "source_connection_id" UUID;

ALTER TABLE "tenant_sync_checkpoints" ADD COLUMN     "mapping_version" INTEGER,
ADD COLUMN     "quality" JSONB,
ADD COLUMN     "source_connection_id" UUID;

ALTER TABLE "tenant_context_changes" ADD CONSTRAINT "tenant_context_changes_tenant_id_source_connection_id_fkey" FOREIGN KEY ("tenant_id", "source_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_sync_checkpoints" ADD CONSTRAINT "tenant_sync_checkpoints_tenant_id_source_connection_id_fkey" FOREIGN KEY ("tenant_id", "source_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_mapping_version_valid" CHECK ("mapping_version" IS NULL OR ("mapping_version" >= 1 AND "source_connection_id" IS NOT NULL));
ALTER TABLE "tenant_sync_checkpoints"
  ADD CONSTRAINT "tenant_sync_checkpoints_mapping_version_valid" CHECK ("mapping_version" IS NULL OR ("mapping_version" >= 1 AND "source_connection_id" IS NOT NULL)),
  ADD CONSTRAINT "tenant_sync_checkpoints_quality_object" CHECK ("quality" IS NULL OR (jsonb_typeof("quality") = 'object' AND octet_length("quality"::text) <= 16384));

-- ---------------------------------------------------------------------------
-- 5. Backfill: every tenant gets its `import` connection; tenants with a
--    configured HubSpot integration get their `hubspot` connection. Existing
--    M7 import runs are linked to the import connection. History is not
--    otherwise rewritten (pre-M8 provenance keeps a NULL connection).
-- ---------------------------------------------------------------------------
INSERT INTO "tenant_source_connections" ("tenant_id", "id", "kind", "label", "status", "mapping_mode")
SELECT t."id", gen_random_uuid(), 'import', 'Operator import (CSV)', 'enabled', 'code'
  FROM "tenants" t;

INSERT INTO "tenant_source_connections" ("tenant_id", "id", "kind", "label", "status", "mapping_mode")
SELECT i."tenant_id", gen_random_uuid(), 'hubspot', 'HubSpot', 'enabled', 'code'
  FROM "tenant_integrations" i
 WHERE i."system" = 'hubspot' AND i."access" <> 'disabled';

UPDATE "tenant_sync_checkpoints" c
   SET "source_connection_id" = s."id"
  FROM "tenant_source_connections" s
 WHERE s."tenant_id" = c."tenant_id" AND s."kind" = 'import' AND c."system" = 'import';

DO $$
DECLARE
  tenants_count bigint;
  import_count bigint;
  unlinked bigint;
BEGIN
  SELECT count(*) INTO tenants_count FROM "tenants";
  SELECT count(*) INTO import_count FROM "tenant_source_connections" WHERE "kind" = 'import';
  IF import_count <> tenants_count THEN
    RAISE EXCEPTION 'import connection backfill incomplete: % of % tenants', import_count, tenants_count;
  END IF;
  SELECT count(*) INTO unlinked FROM "tenant_sync_checkpoints"
   WHERE "system" = 'import' AND "source_connection_id" IS NULL;
  IF unlinked <> 0 THEN
    RAISE EXCEPTION 'import runs not linked to their connection: %', unlinked;
  END IF;
END
$$;
