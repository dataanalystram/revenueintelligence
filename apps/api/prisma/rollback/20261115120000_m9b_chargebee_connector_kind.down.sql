-- Down-script for 20261115120000_m9b_chargebee_connector_kind (Milestone 9B).
--
-- Development and staging only: production policy is forward-fix. Run with the
-- owner credentials:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261115120000_m9b_chargebee_connector_kind.down.sql
--
-- Removes the `chargebee` connector kind and restores the M9A integration and
-- credential system CHECKs. Refuses (and changes nothing) while any tenant row
-- names it: a connection, an external reference, a subscription line, a
-- checkpoint, a context change, an integration or a credential reference. The
-- foreign keys would refuse too; the explicit check gives a readable reason.

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM "tenant_source_connections" WHERE "kind" = 'chargebee') +
    (SELECT count(*) FROM "company_external_refs" WHERE "system" = 'chargebee') +
    (SELECT count(*) FROM "person_external_refs" WHERE "system" = 'chargebee') +
    (SELECT count(*) FROM "tenant_subscriptions" WHERE "source_system" = 'chargebee') +
    (SELECT count(*) FROM "tenant_sync_checkpoints" WHERE "system" = 'chargebee') +
    (SELECT count(*) FROM "tenant_context_changes" WHERE "source_system" = 'chargebee') +
    (SELECT count(*) FROM "tenant_integrations" WHERE "system" = 'chargebee') +
    (SELECT count(*) FROM "tenant_credential_refs" WHERE "system" = 'chargebee')
  INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'refusing rollback: % rows still name the chargebee connector kind', n;
  END IF;
END
$$;

ALTER TABLE "tenant_credential_refs"
  DROP CONSTRAINT "tenant_credential_refs_system_valid",
  ADD CONSTRAINT "tenant_credential_refs_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px', 'jev'));

ALTER TABLE "tenant_integrations"
  DROP CONSTRAINT "tenant_integrations_chargebee_read_only",
  DROP CONSTRAINT "tenant_integrations_system_valid",
  ADD CONSTRAINT "tenant_integrations_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px', 'jev'));

DELETE FROM "connector_kinds" WHERE "kind" = 'chargebee';

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261115120000_m9b_chargebee_connector_kind';

COMMIT;
