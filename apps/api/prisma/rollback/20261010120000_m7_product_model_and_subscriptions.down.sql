-- Down-script for 20261010120000_m7_product_model_and_subscriptions (Milestone 7).
--
-- Development and staging only: production policy is forward-fix. Run with the
-- owner credentials, AFTER 20261010130000_m7_eligibility_snapshots.down.sql:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261010120000_m7_product_model_and_subscriptions.down.sql
--
-- Restores company_products from the migrated legacy rows. Refuses (and changes
-- nothing) while the data holds anything the M6 schema cannot: a published
-- product model, a subscription that did not come from the legacy migration
-- (or was changed, deleted or merged since), subscription import runs, or
-- provenance the old CHECKs do not accept. It never invents or drops facts.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "tenant_product_models") THEN
    RAISE EXCEPTION 'M7 migration cannot be rolled back: published product model versions exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "tenant_subscriptions"
     WHERE "source_system" <> 'import' OR "source_object_type" <> 'legacy_company_product'
        OR "record_state" <> 'active' OR "state" NOT IN ('active', 'trial', 'expired', 'cancelled')
        OR "quantity" IS NOT NULL
        OR "source_record_id" <> "company_id"::text || ':' || "product_key") THEN
    RAISE EXCEPTION 'M7 migration cannot be rolled back: subscriptions exist that the legacy table cannot hold';
  END IF;
  IF EXISTS (SELECT 1 FROM "tenant_context_changes" WHERE "entity_kind" = 'subscription' AND "adapter" <> 'migration') THEN
    RAISE EXCEPTION 'M7 migration cannot be rolled back: subscriptions changed after the migration (provenance exists)';
  END IF;
  IF EXISTS (SELECT 1 FROM "tenant_sync_checkpoints" WHERE "kind" = 'subscription' OR "system" = 'import' OR "mode" IN ('import_full', 'import_incremental')) THEN
    RAISE EXCEPTION 'M7 migration cannot be rolled back: subscription import runs exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "tenant_context_changes"
     WHERE "entity_kind" <> 'subscription'
       AND ("cause" = 'import' OR "source_system" = 'import' OR "source_record_id" !~ '^[A-Za-z0-9_.-]{1,255}$')) THEN
    RAISE EXCEPTION 'M7 migration cannot be rolled back: provenance exists that the M6 constraints do not accept';
  END IF;
END
$$;

-- Legacy ownership table, exactly as created in M2.
CREATE TABLE "company_products" (
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "since" TIMESTAMPTZ(3),
    "until" TIMESTAMPTZ(3),

    CONSTRAINT "company_products_pkey" PRIMARY KEY ("tenant_id","company_id","product_key")
);
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_tenant_id_company_id_fkey" FOREIGN KEY ("tenant_id", "company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_tenant_id_product_key_fkey" FOREIGN KEY ("tenant_id", "product_key") REFERENCES "tenant_products"("tenant_id", "key") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "company_products"
  ADD CONSTRAINT "company_products_status_valid" CHECK ("status" IN ('active', 'trial', 'expired', 'churned')),
  ADD CONSTRAINT "company_products_period_valid" CHECK ("since" IS NULL OR "until" IS NULL OR "since" <= "until");
ALTER TABLE "company_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_products" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "company_products" USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE TRIGGER "company_products_tenant_immutable" BEFORE UPDATE ON "company_products" FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();

INSERT INTO "company_products" ("tenant_id", "company_id", "product_key", "status", "since", "until")
SELECT "tenant_id", "company_id", "product_key",
       CASE "state" WHEN 'cancelled' THEN 'churned' ELSE "state" END,
       "starts_at", "ends_at"
  FROM "tenant_subscriptions";

DELETE FROM "tenant_context_changes" WHERE "entity_kind" = 'subscription';
DROP TABLE "tenant_subscriptions";
DROP TABLE "tenant_product_models";

DROP TRIGGER "tenant_products_never_deleted" ON "tenant_products";
ALTER TABLE "tenant_products" DROP COLUMN "family", DROP COLUMN "model_version";

ALTER TABLE "tenant_context_changes"
  DROP CONSTRAINT "tenant_context_changes_entity_kind_valid",
  DROP CONSTRAINT "tenant_context_changes_cause_valid",
  DROP CONSTRAINT "tenant_context_changes_system_valid",
  DROP CONSTRAINT "tenant_context_changes_record_id_format",
  ADD CONSTRAINT "tenant_context_changes_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person')),
  ADD CONSTRAINT "tenant_context_changes_cause_valid" CHECK ("cause" IN ('webhook', 'backfill', 'reconciliation', 'replay', 'resync')),
  ADD CONSTRAINT "tenant_context_changes_system_valid" CHECK ("source_system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px')),
  ADD CONSTRAINT "tenant_context_changes_record_id_format" CHECK ("source_record_id" ~ '^[A-Za-z0-9_.-]{1,255}$');

ALTER TABLE "tenant_sync_checkpoints"
  DROP CONSTRAINT "tenant_sync_checkpoints_input_hash_format",
  DROP CONSTRAINT "tenant_sync_checkpoints_system_valid",
  DROP CONSTRAINT "tenant_sync_checkpoints_kind_valid",
  DROP CONSTRAINT "tenant_sync_checkpoints_mode_valid",
  DROP COLUMN "input_hash",
  ADD CONSTRAINT "tenant_sync_checkpoints_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px')),
  ADD CONSTRAINT "tenant_sync_checkpoints_kind_valid" CHECK ("kind" IN ('company', 'person')),
  ADD CONSTRAINT "tenant_sync_checkpoints_mode_valid" CHECK ("mode" IN ('backfill', 'reconcile'));

DROP FUNCTION "app_refuse_change"();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261010120000_m7_product_model_and_subscriptions';

COMMIT;
