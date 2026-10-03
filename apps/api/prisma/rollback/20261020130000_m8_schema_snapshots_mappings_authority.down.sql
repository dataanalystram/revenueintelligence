-- Down-script for 20261020130000_m8_schema_snapshots_mappings_authority (Milestone 8).
--
-- Development and staging only: production policy is forward-fix. Run with the
-- owner credentials, before the earlier M8 down-scripts:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261020130000_m8_schema_snapshots_mappings_authority.down.sql
--
-- Removes schema snapshots, mapping versions, authority versions and ownership
-- gaps. Refuses when that would lose published configuration or run linkage:
-- any snapshot, mapping version or ownership gap, any authority version beyond
-- the seeded version 1, or provenance/runs that reference a mapping version.

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "tenant_source_schema_snapshots";
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % schema snapshots exist', n; END IF;
  SELECT count(*) INTO n FROM "tenant_source_mapping_versions";
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % mapping versions exist', n; END IF;
  SELECT count(*) INTO n FROM "tenant_ownership_gaps";
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % ownership gaps exist', n; END IF;
  SELECT count(*) INTO n FROM "tenant_source_authority_versions" WHERE "version" > 1;
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % published authority versions beyond the default', n; END IF;
  SELECT count(*) INTO n FROM "tenant_context_changes" WHERE "mapping_version" IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % provenance rows reference a mapping version', n; END IF;
  SELECT count(*) INTO n FROM "tenant_sync_checkpoints" WHERE "mapping_version" IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % runs reference a mapping version', n; END IF;
END
$$;

ALTER TABLE "tenant_context_changes" DROP CONSTRAINT "tenant_context_changes_tenant_id_source_connection_id_mapp_fkey";
ALTER TABLE "tenant_sync_checkpoints" DROP CONSTRAINT "tenant_sync_checkpoints_tenant_id_source_connection_id_map_fkey";

-- Immutable tables: drop the guard triggers first (row deletion is refused).
DROP TABLE "tenant_ownership_gaps";
DROP TRIGGER "tenant_source_mapping_versions_immutable" ON "tenant_source_mapping_versions";
DROP TABLE "tenant_source_mapping_versions";
DROP TRIGGER "tenant_source_schema_snapshots_immutable" ON "tenant_source_schema_snapshots";
DROP TABLE "tenant_source_schema_snapshots";
DROP TRIGGER "tenant_source_authority_versions_immutable" ON "tenant_source_authority_versions";
DROP TABLE "tenant_source_authority_versions";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261020130000_m8_schema_snapshots_mappings_authority';

COMMIT;
