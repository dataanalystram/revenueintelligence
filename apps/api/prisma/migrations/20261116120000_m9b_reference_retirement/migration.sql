-- Milestone 9B (governed correction after live mutation M08): retirement of
-- source account references (ADR 0024 amendment).
--
-- A source reference that a successful, proven and operator-accepted full read
-- no longer returns becomes `retired`: an explicit lifecycle state, distinct
-- from `deleted` (the source said the record was deleted). The row is never
-- physically deleted, the canonical company is untouched (retirement is
-- neutral to its record state) and the run that retired it is recorded. A
-- later observation of the same record makes the reference active again.
--
-- 1. `company_external_refs.state` admits `retired`.
-- 2. `retired_at` and `retired_by_run_id` are set exactly when the state is
--    `retired` (CHECK); the run is a foreign key to its checkpoint.
-- Person references are unchanged (no connector retires them).

ALTER TABLE "company_external_refs"
  ADD COLUMN "retired_at" TIMESTAMPTZ(3),
  ADD COLUMN "retired_by_run_id" UUID;

ALTER TABLE "company_external_refs"
  DROP CONSTRAINT "company_external_refs_state_valid",
  ADD CONSTRAINT "company_external_refs_state_valid" CHECK ("state" IN ('active', 'deleted', 'merged', 'retired')),
  ADD CONSTRAINT "company_external_refs_retired_consistent" CHECK (("state" = 'retired') = ("retired_at" IS NOT NULL AND "retired_by_run_id" IS NOT NULL)),
  ADD CONSTRAINT "company_external_refs_retired_partial" CHECK (("retired_at" IS NULL) = ("retired_by_run_id" IS NULL));

ALTER TABLE "company_external_refs"
  ADD CONSTRAINT "company_external_refs_tenant_id_retired_by_run_id_fkey" FOREIGN KEY ("tenant_id", "retired_by_run_id") REFERENCES "tenant_sync_checkpoints"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
