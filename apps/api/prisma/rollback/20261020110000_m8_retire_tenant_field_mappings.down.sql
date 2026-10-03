-- Down-script for 20261020110000_m8_retire_tenant_field_mappings (Milestone 8).
--
-- Development and staging only: production policy is forward-fix. Run with the
-- owner credentials, after the later M8 down-scripts:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261020110000_m8_retire_tenant_field_mappings.down.sql
--
-- Recreates tenant_field_mappings exactly as M2 defined it (columns, keys,
-- CHECKs, RLS, tenant-immutability trigger). Rows are not restored here: the
-- migration only ran when every row equalled a documented template row, so
-- they are reproduced from docs/integrations/sugar/lead-handover-field-intent.md
-- (or from an optional pre-migration export). Refuses if the table exists.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.tenant_field_mappings') IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_field_mappings already exists';
  END IF;
END
$$;

CREATE TABLE "tenant_field_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "canonical_entity" TEXT NOT NULL,
    "canonical_field" TEXT NOT NULL,
    "external_field" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'tbc',
    "value_map" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_field_mappings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tenant_field_mappings_tenant_id_id_key" ON "tenant_field_mappings"("tenant_id", "id");
CREATE UNIQUE INDEX "tenant_field_mappings_tenant_id_system_object_type_canonica_key" ON "tenant_field_mappings"("tenant_id", "system", "object_type", "canonical_entity", "canonical_field");
ALTER TABLE "tenant_field_mappings" ADD CONSTRAINT "tenant_field_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_field_mappings"
  ADD CONSTRAINT "tenant_field_mappings_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px')),
  ADD CONSTRAINT "tenant_field_mappings_direction_valid" CHECK ("direction" IN ('inbound', 'outbound', 'bidirectional')),
  ADD CONSTRAINT "tenant_field_mappings_status_valid" CHECK ("status" IN ('tbc', 'proposed', 'confirmed')),
  ADD CONSTRAINT "tenant_field_mappings_tbc_has_no_field" CHECK (("status" = 'tbc') = ("external_field" IS NULL)),
  ADD CONSTRAINT "tenant_field_mappings_value_map_object" CHECK (jsonb_typeof("value_map") = 'object');
ALTER TABLE "tenant_field_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_field_mappings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_field_mappings"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE TRIGGER "tenant_field_mappings_tenant_immutable" BEFORE UPDATE ON "tenant_field_mappings"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261020110000_m8_retire_tenant_field_mappings';

COMMIT;
