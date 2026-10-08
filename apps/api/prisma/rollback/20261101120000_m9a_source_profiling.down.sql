-- Down-script for 20261101120000_m9a_source_profiling (Milestone 9A).
--
-- Development and staging only: production policy is forward-fix. Run with the
-- owner credentials:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261101120000_m9a_source_profiling.down.sql
--
-- Removes the profiling tables, the M9A ownership-gap reasons and the
-- authority proof acceptances. Refuses when that would lose evidence or
-- silently weaken a safety decision M8 code cannot reproduce:
-- any profile run, profile, finding or purge audit row; any ownership gap with
-- an M9A reason; any non-empty proof acceptance; any mapping version carrying
-- a reviewed holding-filter domain (M8 would ignore it and reinstate the
-- not_in null admission); any eligibility snapshot written by evaluator v3.
-- Run proofs recorded in tenant_sync_checkpoints.quality are kept (M8 ignores
-- them; a re-apply reads them again).

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "tenant_source_profile_runs";
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % profile runs exist', n; END IF;
  SELECT count(*) INTO n FROM "tenant_source_profiles";
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % source profiles exist', n; END IF;
  SELECT count(*) INTO n FROM "tenant_source_profile_findings";
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % profile findings exist', n; END IF;
  SELECT count(*) INTO n FROM "tenant_source_profile_purges";
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % profile purge audit rows exist', n; END IF;
  SELECT count(*) INTO n FROM "tenant_ownership_gaps"
   WHERE "reason" NOT IN ('missing_product_reference', 'orphan_product_reference');
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % ownership gaps use an M9A reason', n; END IF;
  SELECT count(*) INTO n FROM "tenant_source_authority_versions" WHERE "proof_acceptances" <> '[]'::jsonb;
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % authority versions carry proof acceptances', n; END IF;
  SELECT count(*) INTO n FROM "tenant_source_mapping_versions"
   WHERE jsonb_path_exists("document", '$.**.reviewedDomain');
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % mapping versions carry a reviewed holding domain', n; END IF;
  SELECT count(*) INTO n FROM "tenant_eligibility_snapshots" WHERE "evaluator_version" >= 3;
  IF n <> 0 THEN RAISE EXCEPTION 'refusing rollback: % eligibility snapshots were written by evaluator v3', n; END IF;
END
$$;

-- Authority proof acceptances.
DROP TRIGGER "tenant_source_authority_versions_acceptances" ON "tenant_source_authority_versions";
DROP FUNCTION "app_check_proof_acceptances"();
ALTER TABLE "tenant_source_authority_versions"
  DROP CONSTRAINT "tenant_source_authority_versions_acceptances_shape",
  DROP COLUMN "proof_acceptances";

-- Ownership-gap reasons: the M8 list.
ALTER TABLE "tenant_ownership_gaps"
  DROP CONSTRAINT "tenant_ownership_gaps_reason_valid",
  ADD CONSTRAINT "tenant_ownership_gaps_reason_valid" CHECK ("reason" IN ('missing_product_reference', 'orphan_product_reference'));

-- Profiling tables (empty, checked above), dependants first.
DROP TABLE "tenant_source_profile_purges";
DROP TABLE "tenant_source_profile_findings";
DROP TABLE "tenant_source_profiles";
DROP TABLE "tenant_source_profile_runs";
DROP FUNCTION "app_profile_refuse_change"();
DROP FUNCTION "app_session_in_app_role"();
DROP FUNCTION "app_profile_run_transition"();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261101120000_m9a_source_profiling';

COMMIT;
