-- Down-script for 20261005130000_m6_event_processing_state (Milestone 6).
--
-- Development and staging only: production policy is forward-fix (M6 record,
-- "Rollback strategy"). Run with the owner credentials, AFTER stopping the API
-- and worker, and BEFORE 20261005120000_m6_canonical_identity_provenance.down.sql:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20261005130000_m6_event_processing_state.down.sql
--
-- Drops processing state (dead letters, checkpoints, receipt processing
-- columns). Receipts themselves are kept, as stored by M5.

BEGIN;

DROP TABLE "tenant_sync_checkpoints";
DROP TABLE "tenant_dead_letters";

DROP INDEX "tenant_webhook_receipts_tenant_id_processing_status_receive_idx";

-- The CHECK constraints on these columns are dropped with them.
ALTER TABLE "tenant_webhook_receipts" DROP COLUMN "association_category",
DROP COLUMN "association_removed",
DROP COLUMN "association_type_id",
DROP COLUMN "correlation_id",
DROP COLUMN "from_object_id",
DROP COLUMN "from_object_type_id",
DROP COLUMN "is_primary_association",
DROP COLUMN "merged_object_ids",
DROP COLUMN "new_object_id",
DROP COLUMN "primary_object_id",
DROP COLUMN "processed_at",
DROP COLUMN "processing_attempts",
DROP COLUMN "processing_reason",
DROP COLUMN "processing_status",
DROP COLUMN "to_object_id",
DROP COLUMN "to_object_type_id";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261005130000_m6_event_processing_state';

COMMIT;
