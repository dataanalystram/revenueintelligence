-- Milestone 10D (ADR 0030): extension framework foundation and canonical
-- version 0.4 (plan docs/milestones/M10D-extension-framework-plan.md).
--   1. tenant_registry_entries: unique (tenant_id, kind, id), the FK target of
--      the typed stores; the extension document cap (Q3); mapping version and
--      draft documents up to 1 MiB (Q4).
--   2. app_jsonb_depth(jsonb) (immutable, security invoker, fixed search_path).
--   3. tenant_extension_values, tenant_extension_value_items,
--      tenant_custom_records (entity-index kind custom_record) and
--      tenant_custom_relationships with typed CHECKs (Q6, Q7, Q9), identity
--      immutability, the relationship cardinality guard (Q27) and the
--      entity-index triggers.
--   4. Kind CHECKs widened: entity index, generic references, change records
--      (entity kinds; changed_fields accepts ext:<key>, Q24), value history
--      (ext:<key> on extension target kinds, Q23), identity conflicts (interim
--      data-quality kinds and entity kinds, plan §4.4).
--   5. canonical_model_versions: 0.3 -> supported, 0.4 current (ADR 0030);
--      canonical_modules: extension available at 0.4 (disabled for every tenant).
--   6. Audit capability / action CHECKs widened to policy v5.
--   7. Forced RLS, tenant policy, tenant-id immutability and privileges
--      (SELECT/INSERT/UPDATE; DELETE only on the items table, Q26).
-- Additive only. No backfill: no extension definition, value, record or
-- relationship is invented; data_policy entries keep NULL classification.

-- ---------------------------------------------------------------------------
-- Prisma-generated structure
-- ---------------------------------------------------------------------------
-- CreateTable
CREATE TABLE "tenant_extension_values" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "target_kind" TEXT NOT NULL,
    "target_id" UUID,
    "target_key" TEXT,
    "field_registry_kind" TEXT NOT NULL DEFAULT 'extension',
    "field_id" UUID NOT NULL,
    "value_type" TEXT NOT NULL,
    "value_state" TEXT NOT NULL,
    "value_text" TEXT,
    "value_number" DECIMAL,
    "value_bool" BOOLEAN,
    "value_date" DATE,
    "value_ts" TIMESTAMPTZ(3),
    "value_money_minor" BIGINT,
    "value_currency" CHAR(3),
    "value_enum" TEXT,
    "value_item_count" SMALLINT,
    "value_json" JSONB,
    "value_ref_kind" TEXT,
    "value_ref_id" UUID,
    "value_ref_key" TEXT,
    "origin" TEXT NOT NULL,
    "source_connection_id" UUID,
    "source_object_type" TEXT,
    "source_record_id" TEXT,
    "observed_at" TIMESTAMPTZ(3),
    "source_updated_at" TIMESTAMPTZ(3),
    "field_hash" TEXT,
    "registry_version" INTEGER NOT NULL,
    "released_at" TIMESTAMPTZ(3),
    "last_change_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_extension_values_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant_extension_value_items" (
    "tenant_id" UUID NOT NULL,
    "value_id" UUID NOT NULL,
    "ordinal" SMALLINT NOT NULL,
    "item_type" TEXT NOT NULL,
    "item_text" TEXT,
    "item_number" DECIMAL,
    "item_date" DATE,
    "item_enum" TEXT,

    CONSTRAINT "tenant_extension_value_items_pkey" PRIMARY KEY ("tenant_id","value_id","ordinal")
);

-- CreateTable
CREATE TABLE "tenant_custom_records" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "object_registry_kind" TEXT NOT NULL DEFAULT 'extension',
    "object_id" UUID NOT NULL,
    "parent_kind" TEXT,
    "parent_id" UUID,
    "parent_key" TEXT,
    "natural_key_hash" TEXT,
    "record_state" TEXT NOT NULL DEFAULT 'active',
    "merged_into_id" UUID,
    "origin" TEXT NOT NULL,
    "field_hash" TEXT,
    "last_change_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_custom_records_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant_custom_relationships" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rel_registry_kind" TEXT NOT NULL DEFAULT 'extension',
    "rel_def_id" UUID NOT NULL,
    "from_kind" TEXT NOT NULL,
    "from_id" UUID,
    "from_key" TEXT,
    "to_kind" TEXT NOT NULL,
    "to_id" UUID,
    "to_key" TEXT,
    "role_code" TEXT,
    "state" TEXT NOT NULL DEFAULT 'active',
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,
    "origin" TEXT NOT NULL,
    "source_connection_id" UUID,
    "source_object_type" TEXT,
    "source_record_id" TEXT,
    "last_change_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_custom_relationships_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE INDEX "tenant_extension_values_tenant_id_target_kind_target_id_idx" ON "tenant_extension_values"("tenant_id", "target_kind", "target_id");

-- CreateIndex
CREATE INDEX "tenant_extension_values_tenant_id_field_id_value_number_idx" ON "tenant_extension_values"("tenant_id", "field_id", "value_number");

-- CreateIndex
CREATE INDEX "tenant_extension_values_tenant_id_field_id_value_bool_idx" ON "tenant_extension_values"("tenant_id", "field_id", "value_bool");

-- CreateIndex
CREATE INDEX "tenant_extension_values_tenant_id_field_id_value_date_idx" ON "tenant_extension_values"("tenant_id", "field_id", "value_date");

-- CreateIndex
CREATE INDEX "tenant_extension_values_tenant_id_field_id_value_ts_idx" ON "tenant_extension_values"("tenant_id", "field_id", "value_ts");

-- CreateIndex
CREATE INDEX "tenant_extension_values_tenant_id_field_id_value_currency_v_idx" ON "tenant_extension_values"("tenant_id", "field_id", "value_currency", "value_money_minor");

-- CreateIndex
CREATE INDEX "tenant_extension_values_tenant_id_field_id_value_enum_idx" ON "tenant_extension_values"("tenant_id", "field_id", "value_enum");

-- CreateIndex
CREATE INDEX "tenant_extension_values_tenant_id_field_id_value_ref_kind_v_idx" ON "tenant_extension_values"("tenant_id", "field_id", "value_ref_kind", "value_ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_extension_values_tenant_id_target_kind_target_id_fie_key" ON "tenant_extension_values"("tenant_id", "target_kind", "target_id", "field_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_extension_values_tenant_id_target_kind_target_key_fi_key" ON "tenant_extension_values"("tenant_id", "target_kind", "target_key", "field_id");

-- CreateIndex
CREATE INDEX "tenant_extension_value_items_tenant_id_item_enum_idx" ON "tenant_extension_value_items"("tenant_id", "item_enum");

-- CreateIndex
CREATE INDEX "tenant_custom_records_tenant_id_object_id_record_state_idx" ON "tenant_custom_records"("tenant_id", "object_id", "record_state");

-- CreateIndex
CREATE INDEX "tenant_custom_records_tenant_id_parent_kind_parent_id_idx" ON "tenant_custom_records"("tenant_id", "parent_kind", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_custom_records_tenant_id_object_id_natural_key_hash_key" ON "tenant_custom_records"("tenant_id", "object_id", "natural_key_hash");

-- CreateIndex
CREATE INDEX "tenant_custom_relationships_tenant_id_rel_def_id_from_kind__idx" ON "tenant_custom_relationships"("tenant_id", "rel_def_id", "from_kind", "from_id", "state");

-- CreateIndex
CREATE INDEX "tenant_custom_relationships_tenant_id_rel_def_id_to_kind_to_idx" ON "tenant_custom_relationships"("tenant_id", "rel_def_id", "to_kind", "to_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_registry_entries_tenant_id_kind_id_key" ON "tenant_registry_entries"("tenant_id", "kind", "id");

-- AddForeignKey
ALTER TABLE "tenant_extension_values" ADD CONSTRAINT "tenant_extension_values_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_extension_values" ADD CONSTRAINT "tenant_extension_values_target_id_fkey" FOREIGN KEY ("tenant_id", "target_kind", "target_id") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_extension_values" ADD CONSTRAINT "tenant_extension_values_target_key_fkey" FOREIGN KEY ("tenant_id", "target_kind", "target_key") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_extension_values" ADD CONSTRAINT "tenant_extension_values_tenant_id_field_registry_kind_fiel_fkey" FOREIGN KEY ("tenant_id", "field_registry_kind", "field_id") REFERENCES "tenant_registry_entries"("tenant_id", "kind", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_extension_values" ADD CONSTRAINT "tenant_extension_values_tenant_id_field_registry_kind_regi_fkey" FOREIGN KEY ("tenant_id", "field_registry_kind", "registry_version") REFERENCES "tenant_registry_versions"("tenant_id", "kind", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
CREATE UNIQUE INDEX "mut_entity_index_kind_entity_id" ON "tenant_entity_index"("kind", "entity_id");
ALTER TABLE "tenant_extension_values" ADD CONSTRAINT "tenant_extension_values_ref_id_fkey" FOREIGN KEY ("value_ref_kind", "value_ref_id") REFERENCES "tenant_entity_index"("kind", "entity_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_extension_values" ADD CONSTRAINT "tenant_extension_values_ref_key_fkey" FOREIGN KEY ("tenant_id", "value_ref_kind", "value_ref_key") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_extension_values" ADD CONSTRAINT "tenant_extension_values_tenant_id_source_connection_id_fkey" FOREIGN KEY ("tenant_id", "source_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_extension_values" ADD CONSTRAINT "tenant_extension_values_tenant_id_last_change_id_fkey" FOREIGN KEY ("tenant_id", "last_change_id") REFERENCES "tenant_context_changes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_extension_value_items" ADD CONSTRAINT "tenant_extension_value_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_extension_value_items" ADD CONSTRAINT "tenant_extension_value_items_tenant_id_value_id_fkey" FOREIGN KEY ("tenant_id", "value_id") REFERENCES "tenant_extension_values"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_records" ADD CONSTRAINT "tenant_custom_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_records" ADD CONSTRAINT "tenant_custom_records_tenant_id_object_registry_kind_objec_fkey" FOREIGN KEY ("tenant_id", "object_registry_kind", "object_id") REFERENCES "tenant_registry_entries"("tenant_id", "kind", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_records" ADD CONSTRAINT "tenant_custom_records_parent_id_fkey" FOREIGN KEY ("tenant_id", "parent_kind", "parent_id") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_records" ADD CONSTRAINT "tenant_custom_records_parent_key_fkey" FOREIGN KEY ("tenant_id", "parent_kind", "parent_key") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_records" ADD CONSTRAINT "tenant_custom_records_tenant_id_merged_into_id_fkey" FOREIGN KEY ("tenant_id", "merged_into_id") REFERENCES "tenant_custom_records"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_records" ADD CONSTRAINT "tenant_custom_records_tenant_id_last_change_id_fkey" FOREIGN KEY ("tenant_id", "last_change_id") REFERENCES "tenant_context_changes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_relationships" ADD CONSTRAINT "tenant_custom_relationships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_relationships" ADD CONSTRAINT "tenant_custom_relationships_tenant_id_rel_registry_kind_re_fkey" FOREIGN KEY ("tenant_id", "rel_registry_kind", "rel_def_id") REFERENCES "tenant_registry_entries"("tenant_id", "kind", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_relationships" ADD CONSTRAINT "tenant_custom_relationships_from_id_fkey" FOREIGN KEY ("tenant_id", "from_kind", "from_id") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_relationships" ADD CONSTRAINT "tenant_custom_relationships_from_key_fkey" FOREIGN KEY ("tenant_id", "from_kind", "from_key") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_relationships" ADD CONSTRAINT "tenant_custom_relationships_to_id_fkey" FOREIGN KEY ("tenant_id", "to_kind", "to_id") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_relationships" ADD CONSTRAINT "tenant_custom_relationships_to_key_fkey" FOREIGN KEY ("tenant_id", "to_kind", "to_key") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_relationships" ADD CONSTRAINT "tenant_custom_relationships_tenant_id_source_connection_id_fkey" FOREIGN KEY ("tenant_id", "source_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_relationships" ADD CONSTRAINT "tenant_custom_relationships_tenant_id_last_change_id_fkey" FOREIGN KEY ("tenant_id", "last_change_id") REFERENCES "tenant_context_changes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 1. Registry and mapping document caps (Q3, Q4)
-- ---------------------------------------------------------------------------
-- Every other kind keeps the M10A2 256 KiB cap; the guardrail (default 2 MiB)
-- is enforced by the service, this is the fail-closed ceiling.
ALTER TABLE "tenant_registry_versions" DROP CONSTRAINT "tenant_registry_versions_document_object";
ALTER TABLE "tenant_registry_versions"
  ADD CONSTRAINT "tenant_registry_versions_document_object" CHECK (jsonb_typeof("document") = 'object'
    AND octet_length("document"::text) <= CASE WHEN "kind" = 'extension' THEN 8388608 ELSE 262144 END);

-- Q4: mapping documents (published versions and drafts) up to 1 MiB (MAPPING_LIMITS.documentBytes).
ALTER TABLE "tenant_source_mapping_versions" DROP CONSTRAINT "tenant_source_mapping_versions_document_object";
ALTER TABLE "tenant_source_mapping_versions"
  ADD CONSTRAINT "tenant_source_mapping_versions_document_object" CHECK (jsonb_typeof("document") = 'object' AND octet_length("document"::text) <= 1048576);
ALTER TABLE "tenant_source_mapping_drafts" DROP CONSTRAINT "tenant_source_mapping_drafts_document_object";
ALTER TABLE "tenant_source_mapping_drafts"
  ADD CONSTRAINT "tenant_source_mapping_drafts_document_object" CHECK (jsonb_typeof("document") = 'object' AND octet_length("document"::text) <= 1048576);

-- ---------------------------------------------------------------------------
-- 2. JSON nesting depth (plan §3.1): containers on the deepest path; a scalar is 0.
-- ---------------------------------------------------------------------------
-- The walk stops expanding past 17, so any document deeper than the CHECK
-- ceiling (16) is measured as > 16 without walking it whole.
CREATE FUNCTION "app_jsonb_depth"(doc jsonb) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH RECURSIVE walk (v, d) AS (
    SELECT doc, CASE WHEN jsonb_typeof(doc) IN ('object', 'array') THEN 1 ELSE 0 END
    UNION ALL
    SELECT c.v, w.d + CASE WHEN jsonb_typeof(c.v) IN ('object', 'array') THEN 1 ELSE 0 END
      FROM walk w
      CROSS JOIN LATERAL (
        SELECT e.value AS v FROM jsonb_each(CASE WHEN jsonb_typeof(w.v) = 'object' THEN w.v ELSE '{}'::jsonb END) e
        UNION ALL
        SELECT a.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.v) = 'array' THEN w.v ELSE '[]'::jsonb END) a
      ) c
     WHERE w.d <= 17 AND jsonb_typeof(c.v) IN ('object', 'array')
  )
  SELECT max(d) FROM walk
$$;

-- ---------------------------------------------------------------------------
-- 3a. Extension values (plan §3.1; Q6, Q7, Q9, Q10)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_extension_values"
  ADD CONSTRAINT "tenant_extension_values_target_kind_valid" CHECK ("target_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record')),
  ADD CONSTRAINT "tenant_extension_values_target_one_identity" CHECK (("target_id" IS NULL) <> ("target_key" IS NULL)),
  ADD CONSTRAINT "tenant_extension_values_target_key_only_for_products" CHECK (("target_key" IS NOT NULL) = ("target_kind" = 'product')),
  ADD CONSTRAINT "tenant_extension_values_field_registry_kind" CHECK ("field_registry_kind" = 'extension'),
  ADD CONSTRAINT "tenant_extension_values_value_type_valid" CHECK ("value_type" IN ('string', 'text', 'number', 'integer', 'boolean', 'date', 'datetime', 'money', 'enum', 'multi_enum', 'array', 'json', 'reference')),
  ADD CONSTRAINT "tenant_extension_values_value_state_valid" CHECK ("value_state" IN ('present', 'empty')),
  -- Exactly the column(s) of value_type when present; every value column NULL when empty.
  ADD CONSTRAINT "tenant_extension_values_typed" CHECK (
    CASE
      WHEN "value_state" = 'empty' THEN num_nonnulls("value_text", "value_number", "value_bool", "value_date", "value_ts", "value_money_minor", "value_currency", "value_enum", "value_item_count", "value_json", "value_ref_kind", "value_ref_id", "value_ref_key") = 0
      ELSE num_nonnulls("value_text", "value_number", "value_bool", "value_date", "value_ts", "value_money_minor", "value_currency", "value_enum", "value_item_count", "value_json", "value_ref_kind", "value_ref_id", "value_ref_key")
           = CASE WHEN "value_type" IN ('money', 'reference') THEN 2 ELSE 1 END
        AND CASE "value_type"
              WHEN 'string' THEN "value_text" IS NOT NULL
              WHEN 'text' THEN "value_text" IS NOT NULL
              WHEN 'number' THEN "value_number" IS NOT NULL
              WHEN 'integer' THEN "value_number" IS NOT NULL
              WHEN 'boolean' THEN "value_bool" IS NOT NULL
              WHEN 'date' THEN "value_date" IS NOT NULL
              WHEN 'datetime' THEN "value_ts" IS NOT NULL
              WHEN 'money' THEN "value_money_minor" IS NOT NULL AND "value_currency" IS NOT NULL
              WHEN 'enum' THEN "value_enum" IS NOT NULL
              WHEN 'multi_enum' THEN "value_item_count" IS NOT NULL
              WHEN 'array' THEN "value_item_count" IS NOT NULL
              WHEN 'json' THEN "value_json" IS NOT NULL
              WHEN 'reference' THEN "value_ref_kind" IS NOT NULL AND ("value_ref_id" IS NULL) <> ("value_ref_key" IS NULL)
              ELSE false
            END
    END),
  ADD CONSTRAINT "tenant_extension_values_text_length" CHECK ("value_text" IS NULL OR char_length("value_text") <= CASE WHEN "value_type" = 'text' THEN 32768 ELSE 1000 END),
  ADD CONSTRAINT "tenant_extension_values_integer_scale" CHECK ("value_type" <> 'integer' OR "value_number" IS NULL OR "value_number" = trunc("value_number")),
  ADD CONSTRAINT "tenant_extension_values_currency_format" CHECK ("value_currency" IS NULL OR "value_currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "tenant_extension_values_enum_format" CHECK ("value_enum" IS NULL OR "value_enum" ~ '^[a-z0-9_]{1,64}$'),
  ADD CONSTRAINT "tenant_extension_values_item_count_range" CHECK ("value_item_count" IS NULL OR "value_item_count" BETWEEN 1 AND 10000),
  ADD CONSTRAINT "tenant_extension_values_json_size" CHECK ("value_json" IS NULL OR (octet_length("value_json"::text) <= 65536 AND app_jsonb_depth("value_json") <= 16)),
  ADD CONSTRAINT "tenant_extension_values_json_no_secrets" CHECK ("value_json" IS NULL OR NOT app_jsonb_has_secret_like_key("value_json")),
  ADD CONSTRAINT "tenant_extension_values_ref_kind_valid" CHECK ("value_ref_kind" IS NULL OR "value_ref_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record')),
  ADD CONSTRAINT "tenant_extension_values_ref_key_only_for_products" CHECK ("value_ref_kind" IS NULL OR (("value_ref_key" IS NOT NULL) = ("value_ref_kind" = 'product'))),
  ADD CONSTRAINT "tenant_extension_values_origin_valid" CHECK ("origin" IN ('source_provided', 'human', 'migration')),
  ADD CONSTRAINT "tenant_extension_values_source_all_or_none" CHECK (num_nonnulls("source_connection_id", "source_object_type", "source_record_id") IN (0, 3)),
  ADD CONSTRAINT "tenant_extension_values_source_object_type_format" CHECK ("source_object_type" IS NULL OR "source_object_type" ~ '^[A-Za-z0-9_]{1,100}$'),
  ADD CONSTRAINT "tenant_extension_values_source_record_id_format" CHECK ("source_record_id" IS NULL OR "source_record_id" ~ '^[A-Za-z0-9_.:-]{1,255}$'),
  ADD CONSTRAINT "tenant_extension_values_field_hash_format" CHECK ("field_hash" IS NULL OR "field_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_extension_values_registry_version_positive" CHECK ("registry_version" > 0),
  -- A release hands a human value back to the source (Q16).
  ADD CONSTRAINT "tenant_extension_values_released" CHECK ("released_at" IS NULL OR "origin" = 'human');

-- Identity never changes (target, field, value type); updated_at moves with every update.
CREATE FUNCTION "app_extension_value_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.target_kind IS DISTINCT FROM OLD.target_kind OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.target_key IS DISTINCT FROM OLD.target_key OR NEW.field_registry_kind IS DISTINCT FROM OLD.field_registry_kind
     OR NEW.field_id IS DISTINCT FROM OLD.field_id OR NEW.value_type IS DISTINCT FROM OLD.value_type
     OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'extension_value_identity_immutable' USING ERRCODE = 'check_violation',
      DETAIL = format('extension value %s', OLD.id);
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_extension_value_guard"() FROM PUBLIC;
CREATE TRIGGER "tenant_extension_values_guard" BEFORE UPDATE ON "tenant_extension_values"
  FOR EACH ROW EXECUTE FUNCTION app_extension_value_guard();

-- ---------------------------------------------------------------------------
-- 3b. Collection items (plan §3.2; Q26: replace-on-change)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_extension_value_items"
  ADD CONSTRAINT "tenant_extension_value_items_ordinal_range" CHECK ("ordinal" BETWEEN 0 AND 9999),
  ADD CONSTRAINT "tenant_extension_value_items_item_type_valid" CHECK ("item_type" IN ('string', 'number', 'integer', 'date', 'enum')),
  ADD CONSTRAINT "tenant_extension_value_items_typed" CHECK (num_nonnulls("item_text", "item_number", "item_date", "item_enum") = 1
    AND CASE "item_type"
          WHEN 'string' THEN "item_text" IS NOT NULL
          WHEN 'number' THEN "item_number" IS NOT NULL
          WHEN 'integer' THEN "item_number" IS NOT NULL AND "item_number" = trunc("item_number")
          WHEN 'date' THEN "item_date" IS NOT NULL
          WHEN 'enum' THEN "item_enum" IS NOT NULL
          ELSE false
        END),
  ADD CONSTRAINT "tenant_extension_value_items_text_length" CHECK ("item_text" IS NULL OR char_length("item_text") <= 1000),
  ADD CONSTRAINT "tenant_extension_value_items_enum_format" CHECK ("item_enum" IS NULL OR "item_enum" ~ '^[a-z0-9_]{1,64}$');

-- ---------------------------------------------------------------------------
-- 3c. Custom records (plan §3.3; Q15, Q25, Q32)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_custom_records"
  ADD CONSTRAINT "tenant_custom_records_object_registry_kind" CHECK ("object_registry_kind" = 'extension'),
  ADD CONSTRAINT "tenant_custom_records_parent_kind_valid" CHECK ("parent_kind" IS NULL OR "parent_kind" IN ('company', 'person', 'subscription', 'product')),
  ADD CONSTRAINT "tenant_custom_records_parent_identity" CHECK (CASE WHEN "parent_kind" IS NULL THEN "parent_id" IS NULL AND "parent_key" IS NULL
    ELSE ("parent_id" IS NULL) <> ("parent_key" IS NULL) AND (("parent_key" IS NOT NULL) = ("parent_kind" = 'product')) END),
  ADD CONSTRAINT "tenant_custom_records_natural_key_hash_format" CHECK ("natural_key_hash" IS NULL OR "natural_key_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_custom_records_state_valid" CHECK ("record_state" IN ('active', 'inactive', 'retired', 'merged')),
  ADD CONSTRAINT "tenant_custom_records_merged_target" CHECK (("record_state" = 'merged') = ("merged_into_id" IS NOT NULL)),
  ADD CONSTRAINT "tenant_custom_records_not_merged_into_self" CHECK ("merged_into_id" IS NULL OR "merged_into_id" <> "id"),
  ADD CONSTRAINT "tenant_custom_records_origin_valid" CHECK ("origin" IN ('source_provided', 'human', 'migration')),
  ADD CONSTRAINT "tenant_custom_records_field_hash_format" CHECK ("field_hash" IS NULL OR "field_hash" ~ '^[0-9a-f]{64}$');

-- The object never changes; merged records are terminal; updated_at moves.
CREATE FUNCTION "app_custom_record_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.object_registry_kind IS DISTINCT FROM OLD.object_registry_kind OR NEW.object_id IS DISTINCT FROM OLD.object_id
     OR NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'custom_record_identity_immutable' USING ERRCODE = 'check_violation',
      DETAIL = format('custom record %s', OLD.id);
  END IF;
  IF OLD.record_state = 'merged' AND (NEW.record_state IS DISTINCT FROM OLD.record_state
     OR NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id) THEN
    RAISE EXCEPTION 'custom_record_terminal' USING ERRCODE = 'check_violation',
      DETAIL = format('custom record %s is merged', OLD.id);
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_custom_record_guard"() FROM PUBLIC;
CREATE TRIGGER "tenant_custom_records_guard" BEFORE UPDATE ON "tenant_custom_records"
  FOR EACH ROW EXECUTE FUNCTION app_custom_record_guard();

-- Entity index (the M10A2 generic functions; kind custom_record by id; allow-list unchanged).
CREATE TRIGGER "tenant_custom_records_entity_index_add" AFTER INSERT ON "tenant_custom_records"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_add('custom_record');
CREATE TRIGGER "tenant_custom_records_entity_index_remove" BEFORE DELETE ON "tenant_custom_records"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_remove('custom_record');
CREATE TRIGGER "tenant_custom_records_identity_immutable" BEFORE UPDATE OF "id" ON "tenant_custom_records"
  FOR EACH ROW EXECUTE FUNCTION app_entity_identity_immutable('id');

-- ---------------------------------------------------------------------------
-- 3d. Custom relationships (plan §3.4; Q25, Q27)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_custom_relationships"
  ADD CONSTRAINT "tenant_custom_relationships_rel_registry_kind" CHECK ("rel_registry_kind" = 'extension'),
  ADD CONSTRAINT "tenant_custom_relationships_from_kind_valid" CHECK ("from_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record')),
  ADD CONSTRAINT "tenant_custom_relationships_to_kind_valid" CHECK ("to_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record')),
  ADD CONSTRAINT "tenant_custom_relationships_from_one_identity" CHECK (("from_id" IS NULL) <> ("from_key" IS NULL) AND (("from_key" IS NOT NULL) = ("from_kind" = 'product'))),
  ADD CONSTRAINT "tenant_custom_relationships_to_one_identity" CHECK (("to_id" IS NULL) <> ("to_key" IS NULL) AND (("to_key" IS NOT NULL) = ("to_kind" = 'product'))),
  -- Canonical-to-canonical relationships are not extensions (plan §2.4).
  ADD CONSTRAINT "tenant_custom_relationships_custom_end" CHECK ("from_kind" = 'custom_record' OR "to_kind" = 'custom_record'),
  ADD CONSTRAINT "tenant_custom_relationships_not_self" CHECK (NOT ("from_kind" = "to_kind" AND "from_id" IS NOT DISTINCT FROM "to_id" AND "from_key" IS NOT DISTINCT FROM "to_key")),
  ADD CONSTRAINT "tenant_custom_relationships_role_format" CHECK ("role_code" IS NULL OR "role_code" ~ '^[a-z0-9_]{1,64}$'),
  ADD CONSTRAINT "tenant_custom_relationships_state_valid" CHECK ("state" IN ('active', 'ended')),
  ADD CONSTRAINT "tenant_custom_relationships_ended_at" CHECK (("state" = 'active') = ("ended_at" IS NULL)),
  ADD CONSTRAINT "tenant_custom_relationships_end_reason" CHECK (("state" = 'active') = ("end_reason" IS NULL)),
  ADD CONSTRAINT "tenant_custom_relationships_end_reason_valid" CHECK ("end_reason" IS NULL OR "end_reason" IN ('source_removed', 'operator', 'endpoint_merged')),
  ADD CONSTRAINT "tenant_custom_relationships_origin_valid" CHECK ("origin" IN ('source_provided', 'human', 'migration')),
  ADD CONSTRAINT "tenant_custom_relationships_source_all_or_none" CHECK (num_nonnulls("source_connection_id", "source_object_type", "source_record_id") IN (0, 3)),
  ADD CONSTRAINT "tenant_custom_relationships_source_object_type_format" CHECK ("source_object_type" IS NULL OR "source_object_type" ~ '^[A-Za-z0-9_]{1,100}$'),
  ADD CONSTRAINT "tenant_custom_relationships_source_record_id_format" CHECK ("source_record_id" IS NULL OR "source_record_id" ~ '^[A-Za-z0-9_.:-]{1,255}$');

-- Definition, ends and origin never change; ended edges are terminal; an edge
-- becoming active takes per-(definition, from) and, for one_to_one, per-(definition,
-- to) advisory locks (always in that order) and then refuses a second active edge
-- for the pair or a cardinality violation (Q27, the M10C D1 / D13 pattern).
CREATE FUNCTION "app_custom_relationship_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  cardinality text;
  from_ref text;
  to_ref text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.rel_registry_kind IS DISTINCT FROM OLD.rel_registry_kind
       OR NEW.rel_def_id IS DISTINCT FROM OLD.rel_def_id
       OR NEW.from_kind IS DISTINCT FROM OLD.from_kind OR NEW.from_id IS DISTINCT FROM OLD.from_id
       OR NEW.from_key IS DISTINCT FROM OLD.from_key OR NEW.to_kind IS DISTINCT FROM OLD.to_kind
       OR NEW.to_id IS DISTINCT FROM OLD.to_id OR NEW.to_key IS DISTINCT FROM OLD.to_key
       OR NEW.origin IS DISTINCT FROM OLD.origin THEN
      RAISE EXCEPTION 'custom_relationship_identity_immutable' USING ERRCODE = 'check_violation',
        DETAIL = format('custom relationship %s', OLD.id);
    END IF;
    IF OLD.state = 'ended' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
       OR NEW.end_reason IS DISTINCT FROM OLD.end_reason OR NEW.role_code IS DISTINCT FROM OLD.role_code) THEN
      RAISE EXCEPTION 'custom_relationship_terminal' USING ERRCODE = 'check_violation',
        DETAIL = format('custom relationship %s has ended', OLD.id);
    END IF;
    NEW.updated_at := CURRENT_TIMESTAMP;
  END IF;
  IF NEW.state = 'active' AND (TG_OP = 'INSERT' OR OLD.state <> 'active') THEN
    -- The existence checks below must see the previous lock holder's commit,
    -- which REPEATABLE READ cannot (the M10C review M1 precondition).
    IF current_setting('transaction_isolation') = 'repeatable read' THEN
      RAISE EXCEPTION 'custom_relationship_isolation_unsupported' USING ERRCODE = 'feature_not_supported',
        DETAIL = 'an active custom relationship needs READ COMMITTED or SERIALIZABLE';
    END IF;
    SELECT e.definition ->> 'cardinality' INTO cardinality FROM public.tenant_registry_entries e
     WHERE e.tenant_id = NEW.tenant_id AND e.kind = NEW.rel_registry_kind AND e.id = NEW.rel_def_id
       AND e.definition ->> 'kind' = 'custom_relationship';
    IF cardinality IS NULL OR cardinality NOT IN ('one_to_one', 'many_to_one', 'many_to_many') THEN
      RAISE EXCEPTION 'custom_relationship_definition_invalid' USING ERRCODE = 'check_violation',
        DETAIL = format('registry entry %s is not a custom relationship definition', NEW.rel_def_id);
    END IF;
    from_ref := NEW.from_kind || ':' || coalesce(NEW.from_id::text, NEW.from_key);
    to_ref := NEW.to_kind || ':' || coalesce(NEW.to_id::text, NEW.to_key);
    PERFORM pg_advisory_xact_lock(app_tenant_advisory_key(NEW.tenant_id, 'custom-relationship',
                                                          NEW.rel_def_id::text || '|from|' || from_ref));
    IF cardinality = 'one_to_one' THEN
      PERFORM pg_advisory_xact_lock(app_tenant_advisory_key(NEW.tenant_id, 'custom-relationship',
                                                            NEW.rel_def_id::text || '|to|' || to_ref));
    END IF;
    IF EXISTS (SELECT 1 FROM public.tenant_custom_relationships r
                WHERE r.tenant_id = NEW.tenant_id AND r.rel_def_id = NEW.rel_def_id AND r.state = 'active' AND r.id <> NEW.id
                  AND r.from_kind = NEW.from_kind AND r.from_id IS NOT DISTINCT FROM NEW.from_id AND r.from_key IS NOT DISTINCT FROM NEW.from_key
                  AND (cardinality <> 'many_to_many'
                       OR (r.to_kind = NEW.to_kind AND r.to_id IS NOT DISTINCT FROM NEW.to_id AND r.to_key IS NOT DISTINCT FROM NEW.to_key))) THEN
      RAISE EXCEPTION 'custom_relationship_cardinality' USING ERRCODE = 'unique_violation',
        DETAIL = format('definition %s (%s) already has an active edge from %s', NEW.rel_def_id, cardinality, from_ref);
    END IF;
    IF cardinality = 'one_to_one' AND EXISTS (SELECT 1 FROM public.tenant_custom_relationships r
                WHERE r.tenant_id = NEW.tenant_id AND r.rel_def_id = NEW.rel_def_id AND r.state = 'active' AND r.id <> NEW.id
                  AND r.to_kind = NEW.to_kind AND r.to_id IS NOT DISTINCT FROM NEW.to_id AND r.to_key IS NOT DISTINCT FROM NEW.to_key) THEN
      RAISE EXCEPTION 'custom_relationship_cardinality' USING ERRCODE = 'unique_violation',
        DETAIL = format('definition %s (one_to_one) already has an active edge to %s', NEW.rel_def_id, to_ref);
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_custom_relationship_guard"() FROM PUBLIC;
CREATE TRIGGER "tenant_custom_relationships_guard" BEFORE INSERT OR UPDATE ON "tenant_custom_relationships"
  FOR EACH ROW EXECUTE FUNCTION app_custom_relationship_guard();

-- ---------------------------------------------------------------------------
-- 4. Kind CHECKs (plan §4.4, §9, §11 step 4)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_entity_index" DROP CONSTRAINT "tenant_entity_index_kind_valid";
ALTER TABLE "tenant_entity_index"
  ADD CONSTRAINT "tenant_entity_index_kind_valid" CHECK ("kind" IN ('company', 'person', 'product', 'subscription', 'person_affiliation', 'custom_record'));

ALTER TABLE "tenant_source_references" DROP CONSTRAINT "tenant_source_references_entity_kind_valid";
ALTER TABLE "tenant_source_references"
  ADD CONSTRAINT "tenant_source_references_entity_kind_valid" CHECK ("entity_kind" IN ('product', 'person_affiliation', 'custom_record'));

ALTER TABLE "tenant_context_changes" DROP CONSTRAINT "tenant_context_changes_entity_kind_valid";
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'custom_relationship'));

-- Q24: change types are catalogue-hashed and not widened; changed_fields accepts ext:<key> tokens.
ALTER TABLE "tenant_context_changes" DROP CONSTRAINT "tenant_context_changes_fields_format";
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_fields_format" CHECK (array_to_string("changed_fields", ',') ~ '^(([A-Za-z][A-Za-z0-9_]{0,63}|ext:[a-z][a-z0-9_]{0,62})(,|$))*$');

-- Q23: extension fields (ext:<key>) on every extension target kind.
ALTER TABLE "tenant_value_history" DROP CONSTRAINT "tenant_value_history_field_valid";
ALTER TABLE "tenant_value_history"
  ADD CONSTRAINT "tenant_value_history_field_valid" CHECK (("entity_kind", "field") IN (('company', 'name'), ('company', 'parent_company_id'), ('subscription', 'state'), ('subscription', 'starts_at'), ('subscription', 'ends_at'), ('subscription', 'product_key'), ('subscription', 'quantity'), ('person_affiliation', 'status'), ('person_affiliation', 'starts_at'), ('person_affiliation', 'ends_at'), ('person_affiliation', 'role_codes'))
    OR ("field" ~ '^ext:[a-z][a-z0-9_]{0,62}$' AND "entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record')));

-- Interim data-quality kinds (plan §4.4) until M10L.
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_kind_valid" CHECK ("kind" IN ('shared_email', 'merge_across_systems', 'ambiguous_primary_company', 'hierarchy_cycle_refused', 'hierarchy_depth_exceeded', 'hierarchy_parent_merged', 'hierarchy_parent_unresolved', 'hierarchy_human_override_disagrees', 'affiliation_endpoint_unresolved', 'extension_value_conflict', 'extension_human_override_disagrees', 'extension_reference_unresolved', 'custom_record_parent_unresolved', 'custom_relationship_endpoint_unresolved'));
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_entity_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record'));

-- ---------------------------------------------------------------------------
-- 5. Canonical version 0.4 and module extension (plan §10; Q18, Q19)
-- ---------------------------------------------------------------------------
-- 0.3 moves to `supported` before 0.4 is inserted `current` (the one-current trigger).
ALTER TABLE "canonical_model_versions" NO FORCE ROW LEVEL SECURITY;
UPDATE "canonical_model_versions" SET "status" = 'supported' WHERE "version" = '0.3';
INSERT INTO "canonical_model_versions" ("version", "major", "minor", "status", "released_at", "catalogue_hash", "adr")
VALUES ('0.4', 0, 4, 'current', '2027-01-12 12:00:00+00', '70584afd267f4c5620c2d63c95cc547f18c1cacdb0b408304eea9a41aeae81c7', '0030');
ALTER TABLE "canonical_model_versions" FORCE ROW LEVEL SECURITY;

-- Available at 0.4; disabled for every tenant until an operator enables it.
ALTER TABLE "canonical_modules" NO FORCE ROW LEVEL SECURITY;
UPDATE "canonical_modules" SET "available" = true, "minimum_canonical_version" = '0.4' WHERE "module_key" = 'extension';
ALTER TABLE "canonical_modules" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 6. Audit catalogues: policy v5 capabilities and the M10D actions (plan §16)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry', 'config.canonical.adopt', 'config.module.change', 'config.registry.publish', 'config.data_policy.publish', 'config.mapping.draft', 'config.mapping.retire', 'security.integrity.run', 'canonical.evidence.link', 'data.provenance.read', 'data.account_structure.read', 'data.extension.read')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied', 'canonical.adopt', 'module.enable', 'module.disable', 'module.configure', 'registry.publish', 'data_policy.publish', 'mapping.draft.save', 'mapping.draft.validate', 'mapping.draft.discard', 'mapping.retire', 'integrity.verify', 'provenance.read', 'evidence.link', 'source_reference.observe', 'account.hierarchy.set', 'account.hierarchy.clear', 'account.hierarchy.release', 'person.affiliation.add', 'person.affiliation.end', 'person.affiliation.release', 'account_structure.read', 'extension.value.set', 'extension.value.clear', 'extension.value.release', 'extension.record.create', 'extension.record.update', 'extension.record.retire', 'extension.record.reactivate', 'extension.relationship.add', 'extension.relationship.end', 'extension.read'));

-- ---------------------------------------------------------------------------
-- 7. Tenant isolation and privileges (plan §3, §13; Q26)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_extension_values', 'tenant_extension_value_items',
                           'tenant_custom_records', 'tenant_custom_relationships'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change()',
      t || '_tenant_immutable', t);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM lip_app', t);
  END LOOP;
END
$$;

-- Values, records and edges change state, never disappear (explicit empty, retire, end).
GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_extension_values" TO lip_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_custom_records" TO lip_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_custom_relationships" TO lip_app;
-- Collection items are replaced on change (Q26): the only M10D DELETE grant.
GRANT SELECT, INSERT, DELETE ON TABLE "tenant_extension_value_items" TO lip_app;
