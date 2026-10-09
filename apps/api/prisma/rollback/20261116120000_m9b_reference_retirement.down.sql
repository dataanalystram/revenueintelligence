-- Down-script for 20261116120000_m9b_reference_retirement (Milestone 9B).
--
-- Development and staging only: production policy is forward-fix. Run with the
-- owner credentials:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261116120000_m9b_reference_retirement.down.sql
--
-- Removes the `retired` reference state and its two columns. Refuses (and
-- changes nothing) while any reference is retired or carries retirement
-- provenance: the earlier schema cannot hold it, and turning it into
-- `active` or `deleted` would invent a lifecycle fact.

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "company_external_refs"
   WHERE "state" = 'retired' OR "retired_at" IS NOT NULL OR "retired_by_run_id" IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'refusing rollback: % references are retired', n;
  END IF;
END
$$;

ALTER TABLE "company_external_refs"
  DROP CONSTRAINT "company_external_refs_tenant_id_retired_by_run_id_fkey",
  DROP CONSTRAINT "company_external_refs_retired_partial",
  DROP CONSTRAINT "company_external_refs_retired_consistent",
  DROP CONSTRAINT "company_external_refs_state_valid",
  ADD CONSTRAINT "company_external_refs_state_valid" CHECK ("state" IN ('active', 'deleted', 'merged'));

ALTER TABLE "company_external_refs"
  DROP COLUMN "retired_by_run_id",
  DROP COLUMN "retired_at";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261116120000_m9b_reference_retirement';

COMMIT;
