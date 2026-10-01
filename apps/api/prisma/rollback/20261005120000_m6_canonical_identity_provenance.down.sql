-- Down-script for 20261005120000_m6_canonical_identity_provenance (Milestone 6).
--
-- Development and staging only: production policy is forward-fix (M6 record,
-- "Rollback strategy"). Run with the owner credentials, AFTER
-- 20261005130000_m6_event_processing_state.down.sql:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261005120000_m6_canonical_identity_provenance.down.sql
--
-- Drops provenance, source relationships, identity conflicts and reference
-- source state. Refuses (and changes nothing) while the data holds anything
-- the M5 schema cannot: a company without a name, a person without an email,
-- two people with one email in a tenant, or a merged record. Resolve those
-- rows first; the script never invents names or emails.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "companies" WHERE "name" IS NULL)
     OR EXISTS (SELECT 1 FROM "persons" WHERE "primary_email" IS NULL)
     OR EXISTS (SELECT 1 FROM "persons" GROUP BY "tenant_id", "primary_email" HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM "companies" WHERE "record_state" = 'merged')
     OR EXISTS (SELECT 1 FROM "persons" WHERE "record_state" = 'merged') THEN
    RAISE EXCEPTION 'M6 identity migration cannot be rolled back: data the M5 schema cannot hold (null name/email, shared email or merged record)';
  END IF;
END
$$;

DROP TABLE "tenant_identity_conflicts";
DROP TABLE "tenant_source_relationships";
DROP TABLE "tenant_context_changes";

-- External references: CHECK constraints go with the columns.
ALTER TABLE "company_external_refs" DROP COLUMN "deleted_at",
DROP COLUMN "field_hash",
DROP COLUMN "last_change_id",
DROP COLUMN "last_seen_at",
DROP COLUMN "merged_into_external_id",
DROP COLUMN "source_created_at",
DROP COLUMN "source_updated_at",
DROP COLUMN "state";

ALTER TABLE "person_external_refs" DROP COLUMN "deleted_at",
DROP COLUMN "field_hash",
DROP COLUMN "last_change_id",
DROP COLUMN "last_seen_at",
DROP COLUMN "merged_into_external_id",
DROP COLUMN "source_created_at",
DROP COLUMN "source_updated_at",
DROP COLUMN "state";

ALTER TABLE "company_external_refs" RENAME COLUMN "first_seen_at" TO "created_at";
ALTER TABLE "person_external_refs" RENAME COLUMN "first_seen_at" TO "created_at";

-- Canonical records: state and merge columns (their FKs and CHECKs go with them).
ALTER TABLE "companies" DROP CONSTRAINT "companies_name_not_blank",
DROP COLUMN "merged_into_id",
DROP COLUMN "record_state",
ALTER COLUMN "name" SET NOT NULL;

ALTER TABLE "persons" DROP COLUMN "merged_into_id",
DROP COLUMN "record_state",
ALTER COLUMN "primary_email" SET NOT NULL;

DROP INDEX "persons_tenant_id_primary_email_idx";
CREATE UNIQUE INDEX "persons_tenant_id_primary_email_key" ON "persons"("tenant_id", "primary_email");

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261005120000_m6_canonical_identity_provenance';

COMMIT;
