-- Milestone 10A1 (ADR 0026): security foundation.
--   1. tenant_audit_events: append-only, hash-chained audit of privileged
--      operations (denials included); tenant_audit_anchors for purge anchors.
--   2. Actor attribution on the change record (NULL = written before M10A1).
--   3. Append-only protection (privileges + trigger) for the change record and
--      the immutable version/snapshot tables (owner decision Q4).
-- No data change and no backfill of invented actors.

-- ---------------------------------------------------------------------------
-- Prisma-generated structure
-- ---------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "tenant_context_changes" ADD COLUMN     "actor_assurance" TEXT,
ADD COLUMN     "actor_id" TEXT,
ADD COLUMN     "actor_kind" TEXT;

-- CreateTable
CREATE TABLE "tenant_audit_events" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_assurance" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason_code" TEXT,
    "target_kind" TEXT,
    "target_ref" TEXT,
    "correlation_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "prev_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "tenant_audit_events_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant_audit_anchors" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "anchor_seq" INTEGER NOT NULL,
    "anchor_hash" TEXT NOT NULL,
    "purged" INTEGER NOT NULL,
    "cutoff" TIMESTAMPTZ(3) NOT NULL,
    "actor" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_audit_anchors_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE INDEX "tenant_audit_events_tenant_id_occurred_at_idx" ON "tenant_audit_events"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "tenant_audit_events_tenant_id_correlation_id_idx" ON "tenant_audit_events"("tenant_id", "correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_audit_events_tenant_id_seq_key" ON "tenant_audit_events"("tenant_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_audit_events_tenant_id_prev_hash_key" ON "tenant_audit_events"("tenant_id", "prev_hash");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_audit_events_tenant_id_hash_key" ON "tenant_audit_events"("tenant_id", "hash");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_audit_anchors_tenant_id_anchor_seq_key" ON "tenant_audit_anchors"("tenant_id", "anchor_seq");

-- AddForeignKey
ALTER TABLE "tenant_audit_events" ADD CONSTRAINT "tenant_audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_audit_anchors" ADD CONSTRAINT "tenant_audit_anchors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- 1. Audit events: value rules
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_seq_positive" CHECK ("seq" > 0),
  ADD CONSTRAINT "tenant_audit_events_actor_kind_valid" CHECK ("actor_kind" IN ('source_sync', 'system', 'operator', 'human_user', 'ai')),
  ADD CONSTRAINT "tenant_audit_events_actor_id_format" CHECK ("actor_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  ADD CONSTRAINT "tenant_audit_events_actor_assurance_valid" CHECK ("actor_assurance" IN ('system', 'asserted', 'authenticated')),
  -- Until authenticated operator identity exists (M15) nothing is "authenticated".
  ADD CONSTRAINT "tenant_audit_events_operator_asserted" CHECK ("actor_kind" <> 'operator' OR "actor_assurance" = 'asserted'),
  ADD CONSTRAINT "tenant_audit_events_capability_format" CHECK ("capability" ~ '^[a-z_]+(\.[a-z_]+)+$'),
  ADD CONSTRAINT "tenant_audit_events_action_format" CHECK ("action" ~ '^[a-z_]+(\.[a-z_]+)+$'),
  ADD CONSTRAINT "tenant_audit_events_outcome_valid" CHECK ("outcome" IN ('allowed', 'denied', 'failed', 'completed')),
  ADD CONSTRAINT "tenant_audit_events_reason_required" CHECK (("outcome" IN ('denied', 'failed')) = ("reason_code" IS NOT NULL)),
  ADD CONSTRAINT "tenant_audit_events_reason_format" CHECK ("reason_code" IS NULL OR "reason_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD CONSTRAINT "tenant_audit_events_target_kind_format" CHECK ("target_kind" IS NULL OR "target_kind" ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD CONSTRAINT "tenant_audit_events_target_ref_format" CHECK ("target_ref" IS NULL OR "target_ref" ~ '^[A-Za-z0-9_.:@/-]{1,200}$'),
  ADD CONSTRAINT "tenant_audit_events_policy_version_positive" CHECK ("policy_version" > 0),
  ADD CONSTRAINT "tenant_audit_events_details_object" CHECK (jsonb_typeof("details") = 'object' AND octet_length("details"::text) <= 4096),
  ADD CONSTRAINT "tenant_audit_events_details_no_secrets" CHECK (NOT app_jsonb_has_secret_like_key("details")),
  ADD CONSTRAINT "tenant_audit_events_prev_hash_format" CHECK ("prev_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_audit_events_hash_format" CHECK ("hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "tenant_audit_anchors"
  ADD CONSTRAINT "tenant_audit_anchors_seq_positive" CHECK ("anchor_seq" > 0),
  ADD CONSTRAINT "tenant_audit_anchors_hash_format" CHECK ("anchor_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_audit_anchors_purged_positive" CHECK ("purged" > 0),
  ADD CONSTRAINT "tenant_audit_anchors_actor_format" CHECK ("actor" ~ '^[A-Za-z0-9_.:@-]{1,128}$');

-- ---------------------------------------------------------------------------
-- 2. Change record: actor attribution
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_actor_all_or_none" CHECK (("actor_kind" IS NULL) = ("actor_id" IS NULL) AND ("actor_id" IS NULL) = ("actor_assurance" IS NULL)),
  ADD CONSTRAINT "tenant_context_changes_actor_kind_valid" CHECK ("actor_kind" IS NULL OR "actor_kind" IN ('source_sync', 'system', 'operator', 'human_user', 'ai')),
  ADD CONSTRAINT "tenant_context_changes_actor_id_format" CHECK ("actor_id" IS NULL OR "actor_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  ADD CONSTRAINT "tenant_context_changes_actor_assurance_valid" CHECK ("actor_assurance" IS NULL OR "actor_assurance" IN ('system', 'asserted', 'authenticated'));

-- ---------------------------------------------------------------------------
-- 3. Tenant isolation for the new tables (ADR 0008)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_audit_events', 'tenant_audit_anchors'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t);
  END LOOP;
END
$$;
CREATE TRIGGER "tenant_audit_events_tenant_immutable" BEFORE UPDATE ON "tenant_audit_events"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();
CREATE TRIGGER "tenant_audit_anchors_tenant_immutable" BEFORE UPDATE ON "tenant_audit_anchors"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();

-- ---------------------------------------------------------------------------
-- 4. Append-only: triggers
-- ---------------------------------------------------------------------------
-- Audit events: never updated. Deleted only inside the owner-path purge (the
-- transaction sets lip.audit_purge = 'on' and the session is neither lip_app
-- nor a member of it). The purge stays disabled in code until the formal
-- retention policy is approved (owner decision Q3).
CREATE FUNCTION "app_audit_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('lip.audit_purge', true) = 'on'
     AND NOT app_session_in_app_role() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% on % is not allowed (%)', TG_OP, TG_TABLE_NAME, TG_ARGV[0]
    USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "tenant_audit_events_append_only" BEFORE UPDATE OR DELETE ON "tenant_audit_events"
  FOR EACH ROW EXECUTE FUNCTION app_audit_refuse_change('audit events are append-only');
CREATE TRIGGER "tenant_audit_anchors_append_only" BEFORE UPDATE OR DELETE ON "tenant_audit_anchors"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('audit anchors are append-only');
-- The change record (Q4): inspection found no application update/delete path.
CREATE TRIGGER "tenant_context_changes_append_only" BEFORE UPDATE OR DELETE ON "tenant_context_changes"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('change records are append-only');

-- ---------------------------------------------------------------------------
-- 5. Append-only: privileges (in addition to the triggers)
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_audit_events" FROM lip_app;
-- Anchors are written only by the owner-path purge.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "tenant_audit_anchors" FROM lip_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_context_changes" FROM lip_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_product_models" FROM lip_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_eligibility_snapshots" FROM lip_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_source_schema_snapshots" FROM lip_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_source_mapping_versions" FROM lip_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_source_authority_versions" FROM lip_app;
REVOKE DELETE, TRUNCATE ON TABLE "tenant_products" FROM lip_app;
