-- Milestone 7 (ADR 0018): frozen eligibility evidence. Written only when a
-- consumer relies on a result (CLI --record now, M11 candidates later).
-- Append-only: a snapshot is never updated or deleted in normal operation;
-- removal with a tenant is deferred to the retention policy (tech debt #15/#17).
CREATE TABLE "tenant_eligibility_snapshots" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "requested_company_id" UUID NOT NULL,
    "evaluated_company_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    "as_of" TIMESTAMPTZ(3) NOT NULL,
    "evaluated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "ownership" TEXT NOT NULL,
    "model_version" INTEGER NOT NULL,
    "model_hash" TEXT NOT NULL,
    "evaluator_version" INTEGER NOT NULL,
    "facts_hash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "purpose" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    CONSTRAINT "tenant_eligibility_snapshots_pkey" PRIMARY KEY ("tenant_id","id")
);
CREATE INDEX "tenant_eligibility_snapshots_tenant_id_evaluated_company_id_idx" ON "tenant_eligibility_snapshots"("tenant_id", "evaluated_company_id", "product_key", "evaluated_at");
CREATE INDEX "tenant_eligibility_snapshots_tenant_id_requested_company_id_idx" ON "tenant_eligibility_snapshots"("tenant_id", "requested_company_id");
ALTER TABLE "tenant_eligibility_snapshots" ADD CONSTRAINT "tenant_eligibility_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_eligibility_snapshots" ADD CONSTRAINT "tenant_eligibility_snapshots_tenant_id_requested_company_i_fkey" FOREIGN KEY ("tenant_id", "requested_company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_eligibility_snapshots" ADD CONSTRAINT "tenant_eligibility_snapshots_tenant_id_evaluated_company_i_fkey" FOREIGN KEY ("tenant_id", "evaluated_company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_eligibility_snapshots" ADD CONSTRAINT "tenant_eligibility_snapshots_tenant_id_product_key_fkey" FOREIGN KEY ("tenant_id", "product_key") REFERENCES "tenant_products"("tenant_id", "key") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "tenant_eligibility_snapshots" ADD CONSTRAINT "tenant_eligibility_snapshots_tenant_id_model_version_fkey" FOREIGN KEY ("tenant_id", "model_version") REFERENCES "tenant_product_models"("tenant_id", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tenant_eligibility_snapshots"
  ADD CONSTRAINT "tenant_eligibility_snapshots_status_valid" CHECK ("status" IN ('eligible', 'ineligible', 'unknown')),
  ADD CONSTRAINT "tenant_eligibility_snapshots_ownership_valid" CHECK ("ownership" IN ('owned', 'not_owned', 'unknown')),
  ADD CONSTRAINT "tenant_eligibility_snapshots_hash_format" CHECK ("model_hash" ~ '^[0-9a-f]{64}$' AND "facts_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_eligibility_snapshots_evaluator_version_valid" CHECK ("evaluator_version" >= 1),
  ADD CONSTRAINT "tenant_eligibility_snapshots_purpose_format" CHECK ("purpose" ~ '^[a-z0-9_]{1,64}$'),
  ADD CONSTRAINT "tenant_eligibility_snapshots_result_object" CHECK (jsonb_typeof("result") = 'object'),
  ADD CONSTRAINT "tenant_eligibility_snapshots_result_size" CHECK (pg_column_size("result") <= 65536);

CREATE TRIGGER "tenant_eligibility_snapshots_append_only" BEFORE UPDATE OR DELETE ON "tenant_eligibility_snapshots"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('eligibility snapshots are append-only');

ALTER TABLE "tenant_eligibility_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_eligibility_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_eligibility_snapshots"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
