-- Down-script for 20261215130000_m10a2_entity_index_history_lifecycle_integrity
-- (Milestone 10A2). Development and staging only: production policy is
-- forward-fix. Run with the owner credentials, before the rollback of
-- 20261215120000_m10a2_canonical_versions_modules_registries:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261215130000_m10a2_entity_index_history_lifecycle_integrity.down.sql
--
-- Refuses (and changes nothing) while data the M10A2-migration-1 schema cannot
-- hold exists: value history, mapping drafts, lifecycle events written after
-- the backfill, integrity runs, change records carrying the new governance
-- columns, mapping versions with canonical_version_min, or change records
-- using a widened change type or cause. The entity index and the lifecycle
-- backfill are derived and dropped. The role lip_entity_indexer is dropped
-- when nothing else in the cluster depends on it.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM tenant_value_history;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % value history rows exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_source_mapping_drafts;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % mapping drafts exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_source_mapping_lifecycle WHERE actor_id <> 'system:migration:m10a2';
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % mapping lifecycle events exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_integrity_runs;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % integrity runs exist', n; END IF;
  SELECT count(*) INTO n FROM tenant_context_changes
   WHERE origin IS NOT NULL OR derivation IS NOT NULL OR canonical_version IS NOT NULL
      OR schema_snapshot_hash IS NOT NULL OR transforms IS NOT NULL
      OR change_type NOT IN ('created', 'updated', 'state_changed', 'merged', 'ref_added', 'relationship_changed') OR cause NOT IN ('webhook', 'backfill', 'reconciliation', 'replay', 'resync', 'import');
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % change records carry M10A2 columns or vocabulary', n; END IF;
  SELECT count(*) INTO n FROM tenant_source_mapping_versions WHERE canonical_version_min IS NOT NULL;
  IF n > 0 THEN RAISE EXCEPTION 'refusing rollback: % mapping versions carry canonical_version_min', n; END IF;
END
$$;

DROP TRIGGER "companies_entity_index_add" ON "companies";
DROP TRIGGER "companies_entity_index_remove" ON "companies";
DROP TRIGGER "companies_identity_immutable" ON "companies";
DROP TRIGGER "persons_entity_index_add" ON "persons";
DROP TRIGGER "persons_entity_index_remove" ON "persons";
DROP TRIGGER "persons_identity_immutable" ON "persons";
DROP TRIGGER "tenant_products_entity_index_add" ON "tenant_products";
DROP TRIGGER "tenant_products_entity_index_remove" ON "tenant_products";
DROP TRIGGER "tenant_products_identity_immutable" ON "tenant_products";
DROP TRIGGER "tenant_subscriptions_entity_index_add" ON "tenant_subscriptions";
DROP TRIGGER "tenant_subscriptions_entity_index_remove" ON "tenant_subscriptions";
DROP TRIGGER "tenant_subscriptions_identity_immutable" ON "tenant_subscriptions";

DROP VIEW "tenant_source_mapping_states";
DROP TABLE "tenant_integrity_runs";
DROP TABLE "tenant_source_mapping_lifecycle";
DROP TABLE "tenant_source_mapping_drafts";
DROP TABLE "tenant_value_history";
DROP TABLE "tenant_entity_index";
DROP FUNCTION "app_mapping_lifecycle_transition"();
DROP FUNCTION "app_mapping_lifecycle_refuse_app_backfill"();
DROP FUNCTION "app_mapping_draft_edit"();
DROP FUNCTION "app_entity_identity_immutable"();
DROP FUNCTION "app_entity_index_add"();
DROP FUNCTION "app_entity_index_remove"();

ALTER TABLE "tenant_source_mapping_versions"
  DROP CONSTRAINT "tenant_source_mapping_versions_canonical_version_min_fkey",
  DROP COLUMN "canonical_version_min";

ALTER TABLE "tenant_context_changes"
  DROP CONSTRAINT "tenant_context_changes_canonical_version_fkey",
  DROP CONSTRAINT "tenant_context_changes_change_type_valid",
  DROP CONSTRAINT "tenant_context_changes_cause_valid",
  DROP CONSTRAINT "tenant_context_changes_origin_valid",
  DROP CONSTRAINT "tenant_context_changes_governance_pair",
  DROP CONSTRAINT "tenant_context_changes_derivation_required",
  DROP CONSTRAINT "tenant_context_changes_derivation_shape",
  DROP CONSTRAINT "tenant_context_changes_snapshot_hash_format",
  DROP CONSTRAINT "tenant_context_changes_transforms_format",
  DROP COLUMN "canonical_version",
  DROP COLUMN "derivation",
  DROP COLUMN "origin",
  DROP COLUMN "schema_snapshot_hash",
  DROP COLUMN "transforms";
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_change_type_valid" CHECK ("change_type" IN ('created', 'updated', 'state_changed', 'merged', 'ref_added', 'relationship_changed')),
  ADD CONSTRAINT "tenant_context_changes_cause_valid" CHECK ("cause" IN ('webhook', 'backfill', 'reconciliation', 'replay', 'resync', 'import'));

REVOKE USAGE ON SCHEMA public FROM lip_entity_indexer;
DO $$
BEGIN
  DROP ROLE lip_entity_indexer;
EXCEPTION WHEN dependent_objects_still_exist THEN
  -- Roles are cluster-wide: another database still grants to it. Its rights in
  -- this database are gone (tables and functions above are dropped).
  RAISE NOTICE 'lip_entity_indexer kept: other databases still depend on it';
END
$$;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261215130000_m10a2_entity_index_history_lifecycle_integrity';

COMMIT;
