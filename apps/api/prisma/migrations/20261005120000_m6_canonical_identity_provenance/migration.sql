-- Milestone 6 (ADR 0014): canonical identity, external references and provenance.
--
-- Platform ids stay canonical; external ids are references. Company names and
-- person emails become nullable (no placeholders); email is no longer unique,
-- because email is not identity. New tables follow the tenancy rules of
-- ADR 0008: tenant_id, forced RLS, tenant-scoped keys (schema guard).

-- ---------------------------------------------------------------------------
-- 1. Canonical records
-- ---------------------------------------------------------------------------
DROP INDEX "persons_tenant_id_primary_email_key";
CREATE INDEX "persons_tenant_id_primary_email_idx" ON "persons"("tenant_id", "primary_email");

ALTER TABLE "persons" ADD COLUMN     "merged_into_id" UUID,
ADD COLUMN     "record_state" TEXT NOT NULL DEFAULT 'active',
ALTER COLUMN "primary_email" DROP NOT NULL;

ALTER TABLE "companies" ADD COLUMN     "merged_into_id" UUID,
ADD COLUMN     "record_state" TEXT NOT NULL DEFAULT 'active',
ALTER COLUMN "name" DROP NOT NULL;

ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_merged_into_id_fkey" FOREIGN KEY ("tenant_id", "merged_into_id") REFERENCES "companies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "persons" ADD CONSTRAINT "persons_tenant_id_merged_into_id_fkey" FOREIGN KEY ("tenant_id", "merged_into_id") REFERENCES "persons"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_name_not_blank" CHECK ("name" IS NULL OR length(btrim("name")) > 0),
  ADD CONSTRAINT "companies_record_state_valid" CHECK ("record_state" IN ('active', 'inactive', 'merged')),
  ADD CONSTRAINT "companies_merged_consistent" CHECK (("record_state" = 'merged') = ("merged_into_id" IS NOT NULL)),
  ADD CONSTRAINT "companies_not_merged_into_self" CHECK ("merged_into_id" IS NULL OR "merged_into_id" <> "id");

ALTER TABLE "persons"
  ADD CONSTRAINT "persons_record_state_valid" CHECK ("record_state" IN ('active', 'inactive', 'merged')),
  ADD CONSTRAINT "persons_merged_consistent" CHECK (("record_state" = 'merged') = ("merged_into_id" IS NOT NULL)),
  ADD CONSTRAINT "persons_not_merged_into_self" CHECK ("merged_into_id" IS NULL OR "merged_into_id" <> "id");

-- ---------------------------------------------------------------------------
-- 2. External references: identity plus source state. `created_at` becomes
--    `first_seen_at` (same meaning, data kept).
-- ---------------------------------------------------------------------------
ALTER TABLE "company_external_refs" RENAME COLUMN "created_at" TO "first_seen_at";
ALTER TABLE "person_external_refs" RENAME COLUMN "created_at" TO "first_seen_at";

ALTER TABLE "company_external_refs" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3),
ADD COLUMN     "field_hash" TEXT,
ADD COLUMN     "last_change_id" UUID,
ADD COLUMN     "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "merged_into_external_id" TEXT,
ADD COLUMN     "source_created_at" TIMESTAMPTZ(3),
ADD COLUMN     "source_updated_at" TIMESTAMPTZ(3),
ADD COLUMN     "state" TEXT NOT NULL DEFAULT 'active';

ALTER TABLE "person_external_refs" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3),
ADD COLUMN     "field_hash" TEXT,
ADD COLUMN     "last_change_id" UUID,
ADD COLUMN     "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "merged_into_external_id" TEXT,
ADD COLUMN     "source_created_at" TIMESTAMPTZ(3),
ADD COLUMN     "source_updated_at" TIMESTAMPTZ(3),
ADD COLUMN     "state" TEXT NOT NULL DEFAULT 'active';

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_external_refs', 'person_external_refs'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ("state" IN (''active'', ''deleted'', ''merged''))', t, t || '_state_valid');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (("state" = ''merged'') = ("merged_into_external_id" IS NOT NULL))', t, t || '_merged_consistent');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ("state" <> ''deleted'' OR "deleted_at" IS NOT NULL)', t, t || '_deleted_has_time');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ("field_hash" IS NULL OR "field_hash" ~ ''^[0-9a-f]{64}$'')', t, t || '_field_hash_format');
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Provenance, source relationships, identity conflicts
-- ---------------------------------------------------------------------------
CREATE TABLE "tenant_context_changes" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "entity_kind" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "change_type" TEXT NOT NULL,
    "changed_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_system" TEXT NOT NULL,
    "source_object_type" TEXT NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "receipt_delivery_key" TEXT,
    "checkpoint_id" UUID,
    "source_updated_at" TIMESTAMPTZ(3),
    "ingested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adapter" TEXT NOT NULL,
    "adapter_version" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,

    CONSTRAINT "tenant_context_changes_pkey" PRIMARY KEY ("tenant_id","id")
);

CREATE TABLE "tenant_source_relationships" (
    "tenant_id" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "from_object_type" TEXT NOT NULL,
    "from_external_id" TEXT NOT NULL,
    "to_object_type" TEXT NOT NULL,
    "to_external_id" TEXT NOT NULL,
    "association_type_id" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'active',
    "source_observed_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_source_relationships_pkey" PRIMARY KEY ("tenant_id","system","from_object_type","from_external_id","to_object_type","to_external_id","association_type_id")
);

CREATE TABLE "tenant_identity_conflicts" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "entity_kind" TEXT NOT NULL,
    "conflict_key" TEXT NOT NULL,
    "canonical_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "external_refs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "state" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "tenant_identity_conflicts_pkey" PRIMARY KEY ("tenant_id","id")
);

CREATE INDEX "tenant_context_changes_tenant_id_entity_kind_entity_id_inge_idx" ON "tenant_context_changes"("tenant_id", "entity_kind", "entity_id", "ingested_at");
CREATE INDEX "tenant_context_changes_tenant_id_ingested_at_idx" ON "tenant_context_changes"("tenant_id", "ingested_at");
CREATE INDEX "tenant_source_relationships_tenant_id_system_to_object_type_idx" ON "tenant_source_relationships"("tenant_id", "system", "to_object_type", "to_external_id");
CREATE UNIQUE INDEX "tenant_identity_conflicts_tenant_id_conflict_key_key" ON "tenant_identity_conflicts"("tenant_id", "conflict_key");

ALTER TABLE "tenant_context_changes" ADD CONSTRAINT "tenant_context_changes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_source_relationships" ADD CONSTRAINT "tenant_source_relationships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_identity_conflicts" ADD CONSTRAINT "tenant_identity_conflicts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Identifiers and codes only: no column can hold a property value.
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person')),
  ADD CONSTRAINT "tenant_context_changes_change_type_valid" CHECK ("change_type" IN ('created', 'updated', 'state_changed', 'merged', 'ref_added', 'relationship_changed')),
  ADD CONSTRAINT "tenant_context_changes_cause_valid" CHECK ("cause" IN ('webhook', 'backfill', 'reconciliation', 'replay', 'resync')),
  ADD CONSTRAINT "tenant_context_changes_system_valid" CHECK ("source_system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px')),
  ADD CONSTRAINT "tenant_context_changes_object_type_format" CHECK ("source_object_type" ~ '^[A-Za-z0-9_]{1,100}$'),
  ADD CONSTRAINT "tenant_context_changes_record_id_format" CHECK ("source_record_id" ~ '^[A-Za-z0-9_.-]{1,255}$'),
  ADD CONSTRAINT "tenant_context_changes_fields_format" CHECK (array_to_string("changed_fields", ',') ~ '^([A-Za-z][A-Za-z0-9_]{0,63}(,|$))*$'),
  ADD CONSTRAINT "tenant_context_changes_delivery_key_format" CHECK ("receipt_delivery_key" IS NULL OR "receipt_delivery_key" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_context_changes_adapter_format" CHECK ("adapter" ~ '^[a-z0-9_]{1,32}$' AND "adapter_version" ~ '^[a-z0-9.-]{1,32}$');

ALTER TABLE "tenant_source_relationships"
  ADD CONSTRAINT "tenant_source_relationships_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px')),
  ADD CONSTRAINT "tenant_source_relationships_ids_format" CHECK ("from_external_id" ~ '^[A-Za-z0-9_.-]{1,255}$' AND "to_external_id" ~ '^[A-Za-z0-9_.-]{1,255}$'),
  ADD CONSTRAINT "tenant_source_relationships_types_format" CHECK ("from_object_type" ~ '^[A-Za-z0-9_]{1,100}$' AND "to_object_type" ~ '^[A-Za-z0-9_]{1,100}$'),
  ADD CONSTRAINT "tenant_source_relationships_category_valid" CHECK ("category" IN ('standard', 'user_defined', 'integrator_defined', 'other')),
  ADD CONSTRAINT "tenant_source_relationships_state_valid" CHECK ("state" IN ('active', 'removed'));

ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_kind_valid" CHECK ("kind" IN ('shared_email', 'merge_across_systems', 'ambiguous_primary_company')),
  ADD CONSTRAINT "tenant_identity_conflicts_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person')),
  ADD CONSTRAINT "tenant_identity_conflicts_key_format" CHECK ("conflict_key" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_identity_conflicts_ids_format" CHECK (array_to_string("canonical_ids", ',') ~ '^([0-9a-f-]{36}(,|$))*$'),
  ADD CONSTRAINT "tenant_identity_conflicts_refs_format" CHECK (array_to_string("external_refs", ',') ~ '^([a-z_]+:[A-Za-z0-9_]+:[A-Za-z0-9_.-]+(,|$))*$'),
  ADD CONSTRAINT "tenant_identity_conflicts_state_valid" CHECK ("state" IN ('open', 'resolved'));

-- ---------------------------------------------------------------------------
-- 4. Row-level security, exactly as for every other tenant-owned table
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_context_changes', 'tenant_source_relationships', 'tenant_identity_conflicts'] LOOP
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
