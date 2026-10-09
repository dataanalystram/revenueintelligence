-- Down-script for 20261201120000_m10a1_security_foundation (Milestone 10A1).
--
-- Development and staging only: production policy is forward-fix. Run with the
-- owner credentials:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261201120000_m10a1_security_foundation.down.sql
--
-- Removes the audit tables, the change-record actor columns and the
-- append-only protections, and restores the M9B privileges exactly. Refuses
-- (and changes nothing) while any audit event, audit anchor or actor-attributed
-- change record exists: the earlier schema cannot hold them, and dropping an
-- audit trail would destroy evidence.

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "tenant_audit_events";
  IF n <> 0 THEN
    RAISE EXCEPTION 'refusing rollback: % audit events exist', n;
  END IF;
  SELECT count(*) INTO n FROM "tenant_audit_anchors";
  IF n <> 0 THEN
    RAISE EXCEPTION 'refusing rollback: % audit anchors exist', n;
  END IF;
  SELECT count(*) INTO n FROM "tenant_context_changes" WHERE "actor_kind" IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'refusing rollback: % change records carry an actor', n;
  END IF;
END
$$;

-- Privileges back to the M9B state (default privileges granted DML).
GRANT UPDATE, DELETE ON TABLE "tenant_context_changes" TO lip_app;
GRANT UPDATE, DELETE ON TABLE "tenant_product_models" TO lip_app;
GRANT UPDATE, DELETE ON TABLE "tenant_eligibility_snapshots" TO lip_app;
GRANT UPDATE, DELETE ON TABLE "tenant_source_schema_snapshots" TO lip_app;
GRANT UPDATE, DELETE ON TABLE "tenant_source_mapping_versions" TO lip_app;
GRANT UPDATE, DELETE ON TABLE "tenant_source_authority_versions" TO lip_app;
GRANT DELETE ON TABLE "tenant_products" TO lip_app;

DROP TRIGGER "tenant_context_changes_append_only" ON "tenant_context_changes";
ALTER TABLE "tenant_context_changes"
  DROP CONSTRAINT "tenant_context_changes_actor_all_or_none",
  DROP CONSTRAINT "tenant_context_changes_actor_kind_valid",
  DROP CONSTRAINT "tenant_context_changes_actor_id_format",
  DROP CONSTRAINT "tenant_context_changes_actor_assurance_valid",
  DROP COLUMN "actor_assurance",
  DROP COLUMN "actor_id",
  DROP COLUMN "actor_kind";

DROP TABLE "tenant_audit_anchors";
DROP TABLE "tenant_audit_events";
DROP FUNCTION "app_audit_refuse_change"();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261201120000_m10a1_security_foundation';

COMMIT;
