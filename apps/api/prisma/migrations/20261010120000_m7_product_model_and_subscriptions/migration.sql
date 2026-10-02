-- Milestone 7 (ADR 0016, ADR 0017): immutable product model versions, the
-- tenant_products projection, canonical subscriptions, and the migration of
-- the legacy company_products ownership table.
--
-- Order matters: subscriptions are created and the legacy rows are migrated
-- and counted BEFORE company_products is dropped. A count mismatch aborts the
-- whole migration (it runs in one transaction).

-- ---------------------------------------------------------------------------
-- 1. Shared immutability helper
-- ---------------------------------------------------------------------------
CREATE FUNCTION "app_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (%)', TG_OP, TG_TABLE_NAME, TG_ARGV[0]
    USING ERRCODE = 'check_violation';
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Product model versions (immutable) and the projection
-- ---------------------------------------------------------------------------
CREATE TABLE "tenant_product_models" (
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" TEXT NOT NULL,

    CONSTRAINT "tenant_product_models_pkey" PRIMARY KEY ("tenant_id","version")
);
CREATE INDEX "tenant_product_models_tenant_id_effective_from_idx" ON "tenant_product_models"("tenant_id", "effective_from");
ALTER TABLE "tenant_product_models" ADD CONSTRAINT "tenant_product_models_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_product_models"
  ADD CONSTRAINT "tenant_product_models_version_valid" CHECK ("version" >= 1),
  ADD CONSTRAINT "tenant_product_models_hash_format" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_product_models_document_object" CHECK (jsonb_typeof("document") = 'object'),
  ADD CONSTRAINT "tenant_product_models_published_by_format" CHECK ("published_by" ~ '^[A-Za-z0-9_.:@-]{1,128}$');
CREATE TRIGGER "tenant_product_models_immutable" BEFORE UPDATE OR DELETE ON "tenant_product_models"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('published product model versions are immutable');

ALTER TABLE "tenant_products" ADD COLUMN     "family" TEXT,
ADD COLUMN     "model_version" INTEGER;
ALTER TABLE "tenant_products"
  ADD CONSTRAINT "tenant_products_family_format" CHECK ("family" IS NULL OR "family" ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  ADD CONSTRAINT "tenant_products_model_version_valid" CHECK ("model_version" IS NULL OR "model_version" >= 1);
-- K4: a product key, once it existed, never disappears (subscriptions and
-- snapshots reference it; it can never come back as a "new" product).
CREATE TRIGGER "tenant_products_never_deleted" BEFORE DELETE ON "tenant_products"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('catalogue rows are retired, never deleted');

-- ---------------------------------------------------------------------------
-- 3. Subscriptions
-- ---------------------------------------------------------------------------
CREATE TABLE "tenant_subscriptions" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "quantity" INTEGER,
    "source_system" TEXT NOT NULL,
    "source_object_type" TEXT NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "record_state" TEXT NOT NULL DEFAULT 'active',
    "source_updated_at" TIMESTAMPTZ(3),
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "field_hash" TEXT,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_change_id" UUID,

    CONSTRAINT "tenant_subscriptions_pkey" PRIMARY KEY ("tenant_id","id")
);
CREATE INDEX "tenant_subscriptions_tenant_id_company_id_idx" ON "tenant_subscriptions"("tenant_id", "company_id");
CREATE INDEX "tenant_subscriptions_tenant_id_product_key_idx" ON "tenant_subscriptions"("tenant_id", "product_key");
CREATE UNIQUE INDEX "tenant_subscriptions_tenant_id_source_system_source_object__key" ON "tenant_subscriptions"("tenant_id", "source_system", "source_object_type", "source_record_id");
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_company_id_fkey" FOREIGN KEY ("tenant_id", "company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_product_key_fkey" FOREIGN KEY ("tenant_id", "product_key") REFERENCES "tenant_products"("tenant_id", "key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Identifiers, codes and dates only: no column can hold a free-text value.
ALTER TABLE "tenant_subscriptions"
  ADD CONSTRAINT "tenant_subscriptions_state_valid" CHECK ("state" IN ('active', 'trial', 'expired', 'cancelled', 'unknown')),
  ADD CONSTRAINT "tenant_subscriptions_period_valid" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "starts_at" <= "ends_at"),
  ADD CONSTRAINT "tenant_subscriptions_quantity_valid" CHECK ("quantity" IS NULL OR "quantity" BETWEEN 1 AND 10000000),
  ADD CONSTRAINT "tenant_subscriptions_source_system_valid" CHECK ("source_system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px', 'import')),
  ADD CONSTRAINT "tenant_subscriptions_source_format" CHECK ("source_object_type" ~ '^[A-Za-z0-9_]{1,100}$' AND "source_record_id" ~ '^[A-Za-z0-9_.:-]{1,255}$'),
  ADD CONSTRAINT "tenant_subscriptions_record_state_valid" CHECK ("record_state" IN ('active', 'deleted')),
  ADD CONSTRAINT "tenant_subscriptions_deleted_has_time" CHECK ("record_state" <> 'deleted' OR "deleted_at" IS NOT NULL),
  ADD CONSTRAINT "tenant_subscriptions_field_hash_format" CHECK ("field_hash" IS NULL OR "field_hash" ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- 4. Provenance and run records: accept subscriptions and imports (ADR 0017)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_context_changes"
  DROP CONSTRAINT "tenant_context_changes_entity_kind_valid",
  DROP CONSTRAINT "tenant_context_changes_cause_valid",
  DROP CONSTRAINT "tenant_context_changes_system_valid",
  DROP CONSTRAINT "tenant_context_changes_record_id_format",
  ADD CONSTRAINT "tenant_context_changes_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription')),
  ADD CONSTRAINT "tenant_context_changes_cause_valid" CHECK ("cause" IN ('webhook', 'backfill', 'reconciliation', 'replay', 'resync', 'import')),
  ADD CONSTRAINT "tenant_context_changes_system_valid" CHECK ("source_system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px', 'import')),
  ADD CONSTRAINT "tenant_context_changes_record_id_format" CHECK ("source_record_id" ~ '^[A-Za-z0-9_.:-]{1,255}$');

ALTER TABLE "tenant_sync_checkpoints" ADD COLUMN "input_hash" TEXT;
ALTER TABLE "tenant_sync_checkpoints"
  DROP CONSTRAINT "tenant_sync_checkpoints_system_valid",
  DROP CONSTRAINT "tenant_sync_checkpoints_kind_valid",
  DROP CONSTRAINT "tenant_sync_checkpoints_mode_valid",
  ADD CONSTRAINT "tenant_sync_checkpoints_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px', 'import')),
  ADD CONSTRAINT "tenant_sync_checkpoints_kind_valid" CHECK ("kind" IN ('company', 'person', 'subscription')),
  ADD CONSTRAINT "tenant_sync_checkpoints_mode_valid" CHECK ("mode" IN ('backfill', 'reconcile', 'import_full', 'import_incremental')),
  ADD CONSTRAINT "tenant_sync_checkpoints_input_hash_format" CHECK ("input_hash" IS NULL OR "input_hash" ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- 5. Legacy ownership → subscriptions (honestly marked as migrated)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  correlation uuid := gen_random_uuid();
  legacy_count bigint;
  migrated_count bigint;
BEGIN
  SELECT count(*) INTO legacy_count FROM "company_products";

  WITH moved AS (
    INSERT INTO "tenant_subscriptions" (
      "tenant_id", "id", "company_id", "product_key", "state", "starts_at", "ends_at",
      "source_system", "source_object_type", "source_record_id", "observed_at")
    SELECT cp."tenant_id", gen_random_uuid(), cp."company_id", cp."product_key",
           CASE cp."status" WHEN 'churned' THEN 'cancelled' ELSE cp."status" END,
           cp."since", cp."until",
           'import', 'legacy_company_product', cp."company_id"::text || ':' || cp."product_key",
           CURRENT_TIMESTAMP
      FROM "company_products" cp
    RETURNING "tenant_id", "id", "source_record_id", "starts_at", "ends_at"
  )
  INSERT INTO "tenant_context_changes" (
    "tenant_id", "id", "entity_kind", "entity_id", "change_type", "changed_fields",
    "source_system", "source_object_type", "source_record_id", "cause",
    "adapter", "adapter_version", "correlation_id")
  SELECT m."tenant_id", gen_random_uuid(), 'subscription', m."id", 'created',
         ARRAY['companyId', 'productKey', 'state']
           || CASE WHEN m."starts_at" IS NULL THEN ARRAY[]::text[] ELSE ARRAY['startsAt'] END
           || CASE WHEN m."ends_at" IS NULL THEN ARRAY[]::text[] ELSE ARRAY['endsAt'] END,
         'import', 'legacy_company_product', m."source_record_id", 'import',
         'migration', 'm7.0', correlation
    FROM moved m;

  SELECT count(*) INTO migrated_count FROM "tenant_subscriptions"
   WHERE "source_object_type" = 'legacy_company_product';
  IF migrated_count <> legacy_count THEN
    RAISE EXCEPTION 'legacy ownership migration incomplete: % of % rows', migrated_count, legacy_count;
  END IF;
END
$$;

ALTER TABLE "company_products" DROP CONSTRAINT "company_products_tenant_id_company_id_fkey";
ALTER TABLE "company_products" DROP CONSTRAINT "company_products_tenant_id_product_key_fkey";
DROP TABLE "company_products";

-- ---------------------------------------------------------------------------
-- 6. Row-level security, exactly as for every other tenant-owned table
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_product_models', 'tenant_subscriptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t);
  END LOOP;
  -- Subscriptions are updated (state, merge repoint): the tenant id must never change.
  EXECUTE 'CREATE TRIGGER tenant_subscriptions_tenant_immutable BEFORE UPDATE ON tenant_subscriptions FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change()';
END
$$;
