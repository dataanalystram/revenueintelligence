-- Milestone 8 (ADR 0019 §5, ADR 0020): schema snapshots, versioned mappings,
-- source authority and per-account ownership gaps.
--
-- * Snapshots, mapping versions and authority versions are immutable (a
--   correction is a new version); mapping versions reference the snapshot
--   they were validated against and the authority version.
-- * Provenance and run records reference the mapping version that produced
--   them (composite FK; NULL for code-mapped connections and history).
-- * Every tenant gets authority version 1: profiles → its HubSpot connection
--   where one exists; subscription facts → its `import` connection (keeps M7
--   coverage behaviour for CSV imports).


CREATE TABLE "tenant_source_schema_snapshots" (
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "source_version" TEXT,
    "document" JSONB NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "captured_by" TEXT NOT NULL,

    CONSTRAINT "tenant_source_schema_snapshots_pkey" PRIMARY KEY ("tenant_id","connection_id","hash")
);

CREATE TABLE "tenant_source_mapping_versions" (
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "base_version" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "schema_snapshot_hash" TEXT NOT NULL,
    "authority_version" INTEGER NOT NULL,
    "validation" JSONB NOT NULL DEFAULT '{}',
    "published_by" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_source_mapping_versions_pkey" PRIMARY KEY ("tenant_id","connection_id","version")
);

CREATE TABLE "tenant_source_authority_versions" (
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "base_version" INTEGER NOT NULL,
    "account_profile_connection_id" UUID,
    "person_profile_connection_id" UUID,
    "subscription_lines_connection_id" UUID,
    "subscription_state_connection_id" UUID,
    "subscription_terms_connection_id" UUID,
    "content_hash" TEXT NOT NULL,
    "published_by" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_source_authority_versions_pkey" PRIMARY KEY ("tenant_id","version")
);

CREATE TABLE "tenant_ownership_gaps" (
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "source_object_type" TEXT NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "company_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "checkpoint_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_ownership_gaps_pkey" PRIMARY KEY ("tenant_id","connection_id","source_object_type","source_record_id")
);

CREATE INDEX "tenant_source_schema_snapshots_tenant_id_connection_id_capt_idx" ON "tenant_source_schema_snapshots"("tenant_id", "connection_id", "captured_at");

CREATE INDEX "tenant_ownership_gaps_tenant_id_company_id_idx" ON "tenant_ownership_gaps"("tenant_id", "company_id");

ALTER TABLE "tenant_context_changes" ADD CONSTRAINT "tenant_context_changes_tenant_id_source_connection_id_mapp_fkey" FOREIGN KEY ("tenant_id", "source_connection_id", "mapping_version") REFERENCES "tenant_source_mapping_versions"("tenant_id", "connection_id", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_sync_checkpoints" ADD CONSTRAINT "tenant_sync_checkpoints_tenant_id_source_connection_id_map_fkey" FOREIGN KEY ("tenant_id", "source_connection_id", "mapping_version") REFERENCES "tenant_source_mapping_versions"("tenant_id", "connection_id", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_source_schema_snapshots" ADD CONSTRAINT "tenant_source_schema_snapshots_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_source_mapping_versions" ADD CONSTRAINT "tenant_source_mapping_versions_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_source_mapping_versions" ADD CONSTRAINT "tenant_source_mapping_versions_tenant_id_connection_id_sch_fkey" FOREIGN KEY ("tenant_id", "connection_id", "schema_snapshot_hash") REFERENCES "tenant_source_schema_snapshots"("tenant_id", "connection_id", "hash") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_source_mapping_versions" ADD CONSTRAINT "tenant_source_mapping_versions_tenant_id_authority_version_fkey" FOREIGN KEY ("tenant_id", "authority_version") REFERENCES "tenant_source_authority_versions"("tenant_id", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_source_authority_versions" ADD CONSTRAINT "tenant_source_authority_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_source_authority_versions" ADD CONSTRAINT "tenant_source_authority_versions_tenant_id_account_profile_fkey" FOREIGN KEY ("tenant_id", "account_profile_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_source_authority_versions" ADD CONSTRAINT "tenant_source_authority_versions_tenant_id_person_profile__fkey" FOREIGN KEY ("tenant_id", "person_profile_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_source_authority_versions" ADD CONSTRAINT "tenant_source_authority_versions_tenant_id_subscription_li_fkey" FOREIGN KEY ("tenant_id", "subscription_lines_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_source_authority_versions" ADD CONSTRAINT "tenant_source_authority_versions_tenant_id_subscription_st_fkey" FOREIGN KEY ("tenant_id", "subscription_state_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_source_authority_versions" ADD CONSTRAINT "tenant_source_authority_versions_tenant_id_subscription_te_fkey" FOREIGN KEY ("tenant_id", "subscription_terms_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_ownership_gaps" ADD CONSTRAINT "tenant_ownership_gaps_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_ownership_gaps" ADD CONSTRAINT "tenant_ownership_gaps_tenant_id_company_id_fkey" FOREIGN KEY ("tenant_id", "company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Value rules (identifiers, hashes and codes only; no free text)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_source_schema_snapshots"
  ADD CONSTRAINT "tenant_source_schema_snapshots_hash_format" CHECK ("hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_source_schema_snapshots_document_object" CHECK (jsonb_typeof("document") = 'object' AND octet_length("document"::text) <= 2097152),
  ADD CONSTRAINT "tenant_source_schema_snapshots_no_secrets" CHECK (NOT app_jsonb_has_secret_like_key("document")),
  ADD CONSTRAINT "tenant_source_schema_snapshots_source_version_format" CHECK ("source_version" IS NULL OR "source_version" ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  ADD CONSTRAINT "tenant_source_schema_snapshots_captured_by_format" CHECK ("captured_by" ~ '^[A-Za-z0-9_.:@-]{1,128}$');

ALTER TABLE "tenant_source_mapping_versions"
  ADD CONSTRAINT "tenant_source_mapping_versions_version_valid" CHECK ("version" >= 1 AND "base_version" = "version" - 1),
  ADD CONSTRAINT "tenant_source_mapping_versions_hash_format" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_source_mapping_versions_document_object" CHECK (jsonb_typeof("document") = 'object' AND octet_length("document"::text) <= 262144),
  ADD CONSTRAINT "tenant_source_mapping_versions_no_secrets" CHECK (NOT app_jsonb_has_secret_like_key("document")),
  ADD CONSTRAINT "tenant_source_mapping_versions_validation_object" CHECK (jsonb_typeof("validation") = 'object' AND octet_length("validation"::text) <= 16384),
  ADD CONSTRAINT "tenant_source_mapping_versions_published_by_format" CHECK ("published_by" ~ '^[A-Za-z0-9_.:@-]{1,128}$');

ALTER TABLE "tenant_source_authority_versions"
  ADD CONSTRAINT "tenant_source_authority_versions_version_valid" CHECK ("version" >= 1 AND "base_version" = "version" - 1),
  ADD CONSTRAINT "tenant_source_authority_versions_hash_format" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_source_authority_versions_published_by_format" CHECK ("published_by" ~ '^[A-Za-z0-9_.:@-]{1,128}$');

ALTER TABLE "tenant_ownership_gaps"
  ADD CONSTRAINT "tenant_ownership_gaps_reason_valid" CHECK ("reason" IN ('missing_product_reference', 'orphan_product_reference')),
  ADD CONSTRAINT "tenant_ownership_gaps_source_format" CHECK ("source_object_type" ~ '^[A-Za-z0-9_]{1,100}$' AND "source_record_id" ~ '^[A-Za-z0-9_.:-]{1,255}$');

-- ---------------------------------------------------------------------------
-- Immutability, row-level security, tenant immutability
-- ---------------------------------------------------------------------------
CREATE TRIGGER "tenant_source_schema_snapshots_immutable" BEFORE UPDATE OR DELETE ON "tenant_source_schema_snapshots"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('schema snapshots are immutable');
CREATE TRIGGER "tenant_source_mapping_versions_immutable" BEFORE UPDATE OR DELETE ON "tenant_source_mapping_versions"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('published mapping versions are immutable');
CREATE TRIGGER "tenant_source_authority_versions_immutable" BEFORE UPDATE OR DELETE ON "tenant_source_authority_versions"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('published authority versions are immutable');
-- Gaps are replaced per completed full run and repointed on account merges.
CREATE TRIGGER "tenant_ownership_gaps_tenant_immutable" BEFORE UPDATE ON "tenant_ownership_gaps"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_source_schema_snapshots', 'tenant_source_mapping_versions',
                           'tenant_source_authority_versions', 'tenant_ownership_gaps'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Default authority (version 1) for every tenant
-- ---------------------------------------------------------------------------
INSERT INTO "tenant_source_authority_versions" (
  "tenant_id", "version", "base_version",
  "account_profile_connection_id", "person_profile_connection_id",
  "subscription_lines_connection_id", "subscription_state_connection_id", "subscription_terms_connection_id",
  "content_hash", "published_by")
SELECT t."id", 1, 0, h."id", h."id", i."id", i."id", i."id",
       -- Same hash as the service: the five connection ids (or '-') joined by '|', in fact order.
       encode(sha256(convert_to(concat(coalesce(h."id"::text, '-'), '|', coalesce(h."id"::text, '-'), '|',
                                       i."id"::text, '|', i."id"::text, '|', i."id"::text), 'UTF8')), 'hex'),
       'migration:m8'
  FROM "tenants" t
  JOIN "tenant_source_connections" i ON i."tenant_id" = t."id" AND i."kind" = 'import'
  LEFT JOIN "tenant_source_connections" h ON h."tenant_id" = t."id" AND h."kind" = 'hubspot';

DO $$
DECLARE
  tenants_count bigint;
  seeded bigint;
BEGIN
  SELECT count(*) INTO tenants_count FROM "tenants";
  SELECT count(*) INTO seeded FROM "tenant_source_authority_versions";
  IF seeded <> tenants_count THEN
    RAISE EXCEPTION 'authority seed incomplete: % of % tenants', seeded, tenants_count;
  END IF;
END
$$;
