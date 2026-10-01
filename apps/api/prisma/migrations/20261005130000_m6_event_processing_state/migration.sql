-- Milestone 6 (ADR 0013): event-processing state in PostgreSQL, the source of
-- truth; Redis only coordinates jobs.

-- ---------------------------------------------------------------------------
-- 1. Webhook receipts: processing state, merge and association identifiers
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_webhook_receipts" ADD COLUMN     "association_category" TEXT,
ADD COLUMN     "association_removed" BOOLEAN,
ADD COLUMN     "association_type_id" INTEGER,
ADD COLUMN     "correlation_id" UUID,
ADD COLUMN     "from_object_id" TEXT,
ADD COLUMN     "from_object_type_id" TEXT,
ADD COLUMN     "is_primary_association" BOOLEAN,
ADD COLUMN     "merged_object_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "new_object_id" TEXT,
ADD COLUMN     "primary_object_id" TEXT,
ADD COLUMN     "processed_at" TIMESTAMPTZ(3),
ADD COLUMN     "processing_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "processing_reason" TEXT,
ADD COLUMN     "processing_status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "to_object_id" TEXT,
ADD COLUMN     "to_object_type_id" TEXT;

CREATE INDEX "tenant_webhook_receipts_tenant_id_processing_status_receive_idx" ON "tenant_webhook_receipts"("tenant_id", "processing_status", "received_at");

-- Receipts stored before M6 stay pending but are marked, so the automatic
-- sweep (recent receipts only) leaves them to the explicit, bounded command.
UPDATE "tenant_webhook_receipts" SET "processing_reason" = 'pre_m6';

ALTER TABLE "tenant_webhook_receipts"
  ADD CONSTRAINT "tenant_webhook_receipts_processing_status_valid" CHECK ("processing_status" IN ('pending', 'processing', 'retrying', 'processed', 'ineligible', 'deferred', 'irrelevant', 'source_not_found', 'dead_lettered')),
  ADD CONSTRAINT "tenant_webhook_receipts_processing_reason_format" CHECK ("processing_reason" IS NULL OR "processing_reason" ~ '^[a-z0-9_]{1,64}$'),
  ADD CONSTRAINT "tenant_webhook_receipts_processing_attempts_valid" CHECK ("processing_attempts" >= 0),
  ADD CONSTRAINT "tenant_webhook_receipts_merge_ids_format" CHECK (
    ("primary_object_id" IS NULL OR "primary_object_id" ~ '^[0-9]{1,20}$') AND
    ("new_object_id" IS NULL OR "new_object_id" ~ '^[0-9]{1,20}$') AND
    array_to_string("merged_object_ids", ',') ~ '^([0-9]{1,20}(,|$))*$'),
  ADD CONSTRAINT "tenant_webhook_receipts_association_format" CHECK (
    ("from_object_id" IS NULL OR "from_object_id" ~ '^[0-9]{1,20}$') AND
    ("to_object_id" IS NULL OR "to_object_id" ~ '^[0-9]{1,20}$') AND
    ("from_object_type_id" IS NULL OR "from_object_type_id" ~ '^[0-9]{1,5}-[0-9]{1,12}$') AND
    ("to_object_type_id" IS NULL OR "to_object_type_id" ~ '^[0-9]{1,5}-[0-9]{1,12}$') AND
    ("association_category" IS NULL OR "association_category" ~ '^[A-Z_]{1,40}$'));

-- ---------------------------------------------------------------------------
-- 2. Dead letters and sync checkpoints
-- ---------------------------------------------------------------------------
CREATE TABLE "tenant_dead_letters" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "queue" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "subject_system" TEXT,
    "subject_kind" TEXT,
    "subject_external_id" TEXT,
    "receipt_delivery_key" TEXT,
    "checkpoint_id" UUID,
    "correlation_id" UUID NOT NULL,
    "error_code" TEXT NOT NULL,
    "http_status" INTEGER,
    "attempts" INTEGER NOT NULL,
    "first_failed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_failed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "state" TEXT NOT NULL DEFAULT 'open',
    "resolved_at" TIMESTAMPTZ(3),
    "resolution" TEXT,

    CONSTRAINT "tenant_dead_letters_pkey" PRIMARY KEY ("tenant_id","id")
);

CREATE TABLE "tenant_sync_checkpoints" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "active_key" TEXT,
    "cursor" TEXT,
    "window_since" TIMESTAMPTZ(3),
    "high_watermark" TIMESTAMPTZ(3),
    "page_no" INTEGER NOT NULL DEFAULT 0,
    "records_seen" INTEGER NOT NULL DEFAULT 0,
    "records_changed" INTEGER NOT NULL DEFAULT 0,
    "records_skipped" INTEGER NOT NULL DEFAULT 0,
    "records_failed" INTEGER NOT NULL DEFAULT 0,
    "max_records" INTEGER,
    "page_size" INTEGER NOT NULL DEFAULT 100,
    "correlation_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,

    CONSTRAINT "tenant_sync_checkpoints_pkey" PRIMARY KEY ("tenant_id","id")
);

CREATE INDEX "tenant_dead_letters_tenant_id_state_last_failed_at_idx" ON "tenant_dead_letters"("tenant_id", "state", "last_failed_at");
CREATE UNIQUE INDEX "tenant_dead_letters_tenant_id_job_id_key" ON "tenant_dead_letters"("tenant_id", "job_id");
CREATE INDEX "tenant_sync_checkpoints_tenant_id_system_kind_mode_status_c_idx" ON "tenant_sync_checkpoints"("tenant_id", "system", "kind", "mode", "status", "completed_at");
CREATE UNIQUE INDEX "tenant_sync_checkpoints_tenant_id_active_key_key" ON "tenant_sync_checkpoints"("tenant_id", "active_key");

ALTER TABLE "tenant_dead_letters" ADD CONSTRAINT "tenant_dead_letters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_sync_checkpoints" ADD CONSTRAINT "tenant_sync_checkpoints_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_dead_letters"
  ADD CONSTRAINT "tenant_dead_letters_queue_format" CHECK ("queue" ~ '^[a-z0-9-]{1,40}$' AND "job_name" ~ '^[a-z0-9_.]{1,40}$' AND "job_id" ~ '^[a-z][a-z0-9-]{2,190}$'),
  ADD CONSTRAINT "tenant_dead_letters_subject_format" CHECK (
    ("subject_system" IS NULL OR "subject_system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px')) AND
    ("subject_kind" IS NULL OR "subject_kind" IN ('company', 'person')) AND
    ("subject_external_id" IS NULL OR "subject_external_id" ~ '^[A-Za-z0-9_.-]{1,255}$')),
  ADD CONSTRAINT "tenant_dead_letters_delivery_key_format" CHECK ("receipt_delivery_key" IS NULL OR "receipt_delivery_key" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_dead_letters_error_code_format" CHECK ("error_code" ~ '^[a-z0-9_]{1,64}$'),
  ADD CONSTRAINT "tenant_dead_letters_attempts_valid" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "tenant_dead_letters_state_valid" CHECK ("state" IN ('open', 'replayed', 'discarded')),
  ADD CONSTRAINT "tenant_dead_letters_resolution_format" CHECK ("resolution" IS NULL OR "resolution" ~ '^[a-z0-9_]{1,64}$');

ALTER TABLE "tenant_sync_checkpoints"
  ADD CONSTRAINT "tenant_sync_checkpoints_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px')),
  ADD CONSTRAINT "tenant_sync_checkpoints_kind_valid" CHECK ("kind" IN ('company', 'person')),
  ADD CONSTRAINT "tenant_sync_checkpoints_mode_valid" CHECK ("mode" IN ('backfill', 'reconcile')),
  ADD CONSTRAINT "tenant_sync_checkpoints_status_valid" CHECK ("status" IN ('running', 'completed', 'failed', 'cancelled')),
  ADD CONSTRAINT "tenant_sync_checkpoints_active_consistent" CHECK (("status" = 'running') = ("active_key" IS NOT NULL)),
  ADD CONSTRAINT "tenant_sync_checkpoints_cursor_format" CHECK ("cursor" IS NULL OR "cursor" ~ '^[A-Za-z0-9_=%.+/-]{1,512}$'),
  ADD CONSTRAINT "tenant_sync_checkpoints_counts_valid" CHECK ("page_no" >= 0 AND "records_seen" >= 0 AND "records_changed" >= 0 AND "records_skipped" >= 0 AND "records_failed" >= 0 AND ("max_records" IS NULL OR "max_records" > 0) AND "page_size" BETWEEN 1 AND 200),
  ADD CONSTRAINT "tenant_sync_checkpoints_error_code_format" CHECK ("last_error_code" IS NULL OR "last_error_code" ~ '^[a-z0-9_]{1,64}$');

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_dead_letters', 'tenant_sync_checkpoints'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change()',
      t || '_tenant_immutable', t);
  END LOOP;
END
$$;
