-- Down-script for 20261020120000_m8_connector_kinds_and_connections (Milestone 8).
--
-- Development and staging only: production policy is forward-fix. Run with the
-- owner credentials, after the later M8 down-scripts:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261020120000_m8_connector_kinds_and_connections.down.sql
--
-- Restores the M7 source-system CHECK lists exactly and removes the connector
-- catalogue, source connections and the provenance/run columns. Refuses when
-- that would lose information: a connector kind beyond the original five, a
-- connection the migration did not backfill (or one that was configured since),
-- provenance that references a connection, or any run carrying a connection
-- other than the import link, a mapping version or quality data.

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "connector_kinds"
   WHERE "kind" NOT IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px', 'import');
  IF n <> 0 THEN
    RAISE EXCEPTION 'refusing rollback: % connector kinds beyond the original five', n;
  END IF;

  SELECT count(*) INTO n FROM "tenant_source_connections" s
   WHERE NOT (
       s."mapping_mode" = 'code' AND s."status" = 'enabled' AND s."config" = '{}'::jsonb
       AND s."credential_name" IS NULL
       AND ((s."kind" = 'import' AND s."label" = 'Operator import (CSV)')
         OR (s."kind" = 'hubspot' AND s."label" = 'HubSpot'
             AND EXISTS (SELECT 1 FROM "tenant_integrations" i
                          WHERE i."tenant_id" = s."tenant_id" AND i."system" = 'hubspot'
                            AND i."access" <> 'disabled'))));
  IF n <> 0 THEN
    RAISE EXCEPTION 'refusing rollback: % source connections beyond the backfilled ones', n;
  END IF;

  SELECT count(*) INTO n FROM "tenant_context_changes"
   WHERE "source_connection_id" IS NOT NULL OR "mapping_version" IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'refusing rollback: % provenance rows reference a connection or mapping version', n;
  END IF;

  SELECT count(*) INTO n FROM "tenant_sync_checkpoints"
   WHERE "mapping_version" IS NOT NULL OR "quality" IS NOT NULL
      OR ("source_connection_id" IS NOT NULL AND "system" <> 'import');
  IF n <> 0 THEN
    RAISE EXCEPTION 'refusing rollback: % runs reference a connection, mapping version or quality', n;
  END IF;
END
$$;

-- Provenance and run records
ALTER TABLE "tenant_sync_checkpoints"
  DROP CONSTRAINT "tenant_sync_checkpoints_tenant_id_source_connection_id_fkey",
  DROP CONSTRAINT "tenant_sync_checkpoints_mapping_version_valid",
  DROP CONSTRAINT "tenant_sync_checkpoints_quality_object",
  DROP COLUMN "source_connection_id",
  DROP COLUMN "mapping_version",
  DROP COLUMN "quality";
ALTER TABLE "tenant_context_changes"
  DROP CONSTRAINT "tenant_context_changes_tenant_id_source_connection_id_fkey",
  DROP CONSTRAINT "tenant_context_changes_mapping_version_valid",
  DROP COLUMN "source_connection_id",
  DROP COLUMN "mapping_version";

-- Source connections
DROP TABLE "tenant_source_connections";
DROP FUNCTION "app_jsonb_has_secret_like_key"(jsonb);

-- Foreign keys → the M7 CHECK lists, exactly
ALTER TABLE "company_external_refs"
  DROP CONSTRAINT "company_external_refs_system_fkey",
  DROP CONSTRAINT "company_external_refs_system_not_import",
  ADD CONSTRAINT "company_external_refs_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px'));
ALTER TABLE "person_external_refs"
  DROP CONSTRAINT "person_external_refs_system_fkey",
  DROP CONSTRAINT "person_external_refs_system_not_import",
  ADD CONSTRAINT "person_external_refs_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px'));
ALTER TABLE "tenant_context_changes"
  DROP CONSTRAINT "tenant_context_changes_source_system_fkey",
  ADD CONSTRAINT "tenant_context_changes_system_valid" CHECK ("source_system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px', 'import'));
ALTER TABLE "tenant_source_relationships"
  DROP CONSTRAINT "tenant_source_relationships_system_fkey",
  DROP CONSTRAINT "tenant_source_relationships_system_not_import",
  ADD CONSTRAINT "tenant_source_relationships_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px'));
ALTER TABLE "tenant_sync_checkpoints"
  DROP CONSTRAINT "tenant_sync_checkpoints_system_fkey",
  ADD CONSTRAINT "tenant_sync_checkpoints_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px', 'import'));
ALTER TABLE "tenant_subscriptions"
  DROP CONSTRAINT "tenant_subscriptions_source_system_fkey",
  ADD CONSTRAINT "tenant_subscriptions_source_system_valid" CHECK ("source_system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px', 'import'));
ALTER TABLE "tenant_dead_letters"
  DROP CONSTRAINT "tenant_dead_letters_subject_system_fkey",
  DROP CONSTRAINT "tenant_dead_letters_subject_system_not_import",
  DROP CONSTRAINT "tenant_dead_letters_subject_format",
  ADD CONSTRAINT "tenant_dead_letters_subject_format" CHECK (
    ("subject_system" IS NULL OR "subject_system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px')) AND
    ("subject_kind" IS NULL OR "subject_kind" IN ('company', 'person')) AND
    ("subject_external_id" IS NULL OR "subject_external_id" ~ '^[A-Za-z0-9_.-]{1,255}$'));

DROP TABLE "connector_kinds";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261020120000_m8_connector_kinds_and_connections';

COMMIT;
