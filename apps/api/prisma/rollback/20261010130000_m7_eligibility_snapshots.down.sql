-- Down-script for 20261010130000_m7_eligibility_snapshots (Milestone 7).
--
-- Development and staging only: production policy is forward-fix. Run with the
-- owner credentials, after stopping the API and worker, and BEFORE
-- 20261010120000_m7_product_model_and_subscriptions.down.sql:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261010130000_m7_eligibility_snapshots.down.sql
--
-- Refuses (and changes nothing) while any snapshot exists: snapshots are
-- recorded evidence that a consumer relied on, and are never discarded silently.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "tenant_eligibility_snapshots") THEN
    RAISE EXCEPTION 'M7 snapshot migration cannot be rolled back: eligibility snapshots exist (recorded evidence)';
  END IF;
END
$$;

DROP TABLE "tenant_eligibility_snapshots";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261010130000_m7_eligibility_snapshots';

COMMIT;
