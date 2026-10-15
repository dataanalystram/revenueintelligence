-- Milestone 10C (ADR 0029): account hierarchy, Person–Account affiliation and
-- canonical version 0.3 (plan docs/milestones/M10C-account-hierarchy-affiliation-plan.md).
--   1. companies: parent_company_id (canonical parent_account_id; same-tenant
--      composite FK), parent_company_origin, no-self-parent CHECK, origin CHECK,
--      children index, and the companies_hierarchy_guard trigger (per-tenant
--      advisory lock, merged-parent refusal, cycle refusal, walk ceiling 64).
--   2. tenant_source_authority_versions.account_hierarchy_connection_id
--      (existing versions untouched; NULL = nobody may write the hierarchy).
--   3. tenant_person_affiliations (forced RLS; app role SELECT/INSERT/UPDATE, no
--      DELETE): lifecycle CHECKs, one active row per (person, company) by
--      trigger, immutable endpoints / origin, terminal ended / merged rows,
--      entity-index triggers (kind person_affiliation).
--   4. Kind CHECKs widened: entity index, generic references, change records,
--      identity conflicts (interim data-quality kinds), value-history fields.
--   5. Read-only security-invoker views: account_hierarchy_paths,
--      person_affiliation_index (derived is_primary; never stored).
--   6. canonical_model_versions: 0.2 -> supported, 0.3 current (ADR 0029).
--   7. Audit capability / action CHECKs widened to policy v4.
-- Additive only. No backfill: no hierarchy is invented and no affiliation is
-- created from persons.company_id or tenant_source_relationships (Q9).

-- ---------------------------------------------------------------------------
-- Prisma-generated structure
-- ---------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "parent_company_id" UUID,
ADD COLUMN     "parent_company_origin" TEXT;

-- AlterTable
ALTER TABLE "tenant_source_authority_versions" ADD COLUMN     "account_hierarchy_connection_id" UUID;

-- CreateTable
CREATE TABLE "tenant_person_affiliations" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "person_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "role_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "end_reason" TEXT,
    "merged_into_id" UUID,
    "origin" TEXT NOT NULL,
    "field_hash" TEXT,
    "last_change_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_person_affiliations_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE INDEX "tenant_person_affiliations_tenant_id_person_id_status_idx" ON "tenant_person_affiliations"("tenant_id", "person_id", "status");

-- CreateIndex
CREATE INDEX "tenant_person_affiliations_tenant_id_company_id_status_idx" ON "tenant_person_affiliations"("tenant_id", "company_id", "status");

-- CreateIndex
CREATE INDEX "companies_tenant_parent_idx" ON "companies"("tenant_id", "parent_company_id");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_parent_company_id_fkey" FOREIGN KEY ("tenant_id", "parent_company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_authority_versions" ADD CONSTRAINT "tenant_source_authority_versions_tenant_id_account_hierarc_fkey" FOREIGN KEY ("tenant_id", "account_hierarchy_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_person_affiliations" ADD CONSTRAINT "tenant_person_affiliations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_person_affiliations" ADD CONSTRAINT "tenant_person_affiliations_tenant_id_person_id_fkey" FOREIGN KEY ("tenant_id", "person_id") REFERENCES "persons"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_person_affiliations" ADD CONSTRAINT "tenant_person_affiliations_tenant_id_company_id_fkey" FOREIGN KEY ("tenant_id", "company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_person_affiliations" ADD CONSTRAINT "tenant_person_affiliations_tenant_id_merged_into_id_fkey" FOREIGN KEY ("tenant_id", "merged_into_id") REFERENCES "tenant_person_affiliations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_person_affiliations" ADD CONSTRAINT "tenant_person_affiliations_tenant_id_last_change_id_fkey" FOREIGN KEY ("tenant_id", "last_change_id") REFERENCES "tenant_context_changes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 1. Account hierarchy (plan §2.1; Q3, Q4, Q8)
-- ---------------------------------------------------------------------------
-- No backfill (M10 §15): every existing account starts without a parent.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "companies" WHERE "parent_company_id" IS NOT NULL OR "parent_company_origin" IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'M10C no-backfill assertion failed: % companies carry a parent', n;
  END IF;
END
$$;

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_parent_origin_valid" CHECK ("parent_company_origin" IS NULL OR "parent_company_origin" IN ('source_provided', 'human'));

-- The tenant-scoped advisory-lock key, identical to tenantAdvisoryLock /
-- advisoryLockKey in code: the first 8 bytes (signed, big-endian) of
-- sha256(tenant_id || '|' || scope || '|' || value).
CREATE FUNCTION "app_tenant_advisory_key"(tenant uuid, scope text, val text) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT ('x' || substr(encode(sha256(convert_to(tenant::text || '|' || scope || '|' || val, 'UTF8')), 'hex'), 1, 16))::bit(64)::bigint
$$;

-- SECURITY INVOKER (Q4): it reads only same-tenant companies rows the caller
-- can already see (every step carries the tenant predicate; forced RLS applies
-- to the app role). Fixed search_path anyway. Raises SQLSTATE 23514 with the
-- refusal code as the message: hierarchy_cycle, hierarchy_parent_merged,
-- hierarchy_ceiling. A self-parent is left to the named CHECK.
CREATE FUNCTION "app_company_hierarchy_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  cur uuid;
  parent_state text;
  steps integer := 0;
BEGIN
  IF NEW.parent_company_id IS NULL OR NEW.parent_company_id = NEW.id THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.parent_company_id IS NOT DISTINCT FROM OLD.parent_company_id THEN
    RETURN NEW;
  END IF;
  -- Serialise every re-parenting of this tenant, raw SQL included, so two
  -- crossing updates (A -> B, B -> A) cannot both pass the walk.
  PERFORM pg_advisory_xact_lock(app_tenant_advisory_key(NEW.tenant_id, 'account-hierarchy', 'tenant'));
  SELECT c.record_state INTO parent_state FROM public.companies c
   WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.parent_company_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the composite foreign key reports the missing / foreign parent
  END IF;
  IF parent_state = 'merged' THEN
    RAISE EXCEPTION 'hierarchy_parent_merged' USING ERRCODE = 'check_violation',
      DETAIL = format('company %s cannot take merged parent %s', NEW.id, NEW.parent_company_id);
  END IF;
  cur := NEW.parent_company_id;
  LOOP
    IF cur = NEW.id THEN
      RAISE EXCEPTION 'hierarchy_cycle' USING ERRCODE = 'check_violation',
        DETAIL = format('parent %s of company %s descends from it', NEW.parent_company_id, NEW.id);
    END IF;
    steps := steps + 1;
    IF steps > 64 THEN
      RAISE EXCEPTION 'hierarchy_ceiling' USING ERRCODE = 'check_violation',
        DETAIL = format('no root within 64 ancestors of company %s', NEW.id);
    END IF;
    SELECT c.parent_company_id INTO cur FROM public.companies c
     WHERE c.tenant_id = NEW.tenant_id AND c.id = cur;
    EXIT WHEN cur IS NULL;
  END LOOP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_company_hierarchy_guard"() FROM PUBLIC;

CREATE TRIGGER "companies_hierarchy_guard" BEFORE INSERT OR UPDATE OF "parent_company_id" ON "companies"
  FOR EACH ROW EXECUTE FUNCTION app_company_hierarchy_guard();

-- ---------------------------------------------------------------------------
-- 3. Person–Account affiliations (plan §3.1; Q9–Q13, Q21)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_person_affiliations"
  ADD CONSTRAINT "tenant_person_affiliations_status_valid" CHECK ("status" IN ('active', 'ended', 'merged')),
  ADD CONSTRAINT "tenant_person_affiliations_origin_valid" CHECK ("origin" IN ('source_provided', 'human')),
  -- Identifiers only (Q11): 0–10 codes matching ^[a-z0-9_]{1,64}$; no NULL or empty element.
  ADD CONSTRAINT "tenant_person_affiliations_role_codes_valid" CHECK ("role_codes" IS NOT NULL AND cardinality("role_codes") <= 10
    AND array_to_string("role_codes", ',') ~ '^([a-z0-9_]{1,64}(,[a-z0-9_]{1,64})*)?$'
    AND coalesce(array_length(string_to_array(nullif(array_to_string("role_codes", ','), ''), ','), 1), 0) = cardinality("role_codes")),
  ADD CONSTRAINT "tenant_person_affiliations_period_valid" CHECK ("ends_at" IS NULL OR "starts_at" IS NULL OR "ends_at" >= "starts_at"),
  ADD CONSTRAINT "tenant_person_affiliations_ended_at" CHECK (("status" = 'active') = ("ended_at" IS NULL)),
  ADD CONSTRAINT "tenant_person_affiliations_end_reason" CHECK (("status" = 'active') = ("end_reason" IS NULL)),
  ADD CONSTRAINT "tenant_person_affiliations_end_reason_valid" CHECK ("end_reason" IS NULL OR "end_reason" IN ('source_end_date', 'source_removed', 'operator', 'person_merged', 'company_merged')),
  ADD CONSTRAINT "tenant_person_affiliations_merged_target" CHECK (("status" = 'merged') = ("merged_into_id" IS NOT NULL)),
  ADD CONSTRAINT "tenant_person_affiliations_merged_reason" CHECK ("status" <> 'merged' OR "end_reason" IN ('person_merged', 'company_merged')),
  ADD CONSTRAINT "tenant_person_affiliations_not_merged_into_self" CHECK ("merged_into_id" IS NULL OR "merged_into_id" <> "id"),
  ADD CONSTRAINT "tenant_person_affiliations_field_hash_format" CHECK ("field_hash" IS NULL OR "field_hash" ~ '^[0-9a-f]{64}$');

-- Endpoints and origin never change (Q13: a merge ends the loser row and
-- inserts or reuses a survivor row); ended / merged rows are terminal; at most
-- one active row per (person, company), serialised per pair by an advisory
-- lock (Q10; a trigger rather than a partial unique index, which the Prisma
-- schema cannot express without drift).
CREATE FUNCTION "app_person_affiliation_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.origin IS DISTINCT FROM OLD.origin THEN
      RAISE EXCEPTION 'affiliation_identity_immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'active' AND (NEW.status IS DISTINCT FROM OLD.status
       OR NEW.role_codes IS DISTINCT FROM OLD.role_codes OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
       OR NEW.ends_at IS DISTINCT FROM OLD.ends_at OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
       OR NEW.end_reason IS DISTINCT FROM OLD.end_reason OR NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id) THEN
      RAISE EXCEPTION 'affiliation_terminal' USING ERRCODE = 'check_violation',
        DETAIL = format('affiliation %s is %s', OLD.id, OLD.status);
    END IF;
    NEW.updated_at := CURRENT_TIMESTAMP;
  END IF;
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status <> 'active') THEN
    PERFORM pg_advisory_xact_lock(app_tenant_advisory_key(NEW.tenant_id, 'person-affiliation',
                                                          NEW.person_id::text || '|' || NEW.company_id::text));
    IF EXISTS (SELECT 1 FROM public.tenant_person_affiliations a
                WHERE a.tenant_id = NEW.tenant_id AND a.person_id = NEW.person_id
                  AND a.company_id = NEW.company_id AND a.status = 'active' AND a.id <> NEW.id) THEN
      RAISE EXCEPTION 'affiliation_active_exists' USING ERRCODE = 'unique_violation',
        DETAIL = format('person %s already has an active affiliation with company %s', NEW.person_id, NEW.company_id);
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_person_affiliation_guard"() FROM PUBLIC;

CREATE TRIGGER "tenant_person_affiliations_guard" BEFORE INSERT OR UPDATE ON "tenant_person_affiliations"
  FOR EACH ROW EXECUTE FUNCTION app_person_affiliation_guard();

-- ---------------------------------------------------------------------------
-- 4. Kind CHECKs (plan §2.6, §6, §7, §8 step 4)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_entity_index" DROP CONSTRAINT "tenant_entity_index_kind_valid";
ALTER TABLE "tenant_entity_index"
  ADD CONSTRAINT "tenant_entity_index_kind_valid" CHECK ("kind" IN ('company', 'person', 'product', 'subscription', 'person_affiliation'));

ALTER TABLE "tenant_source_references" DROP CONSTRAINT "tenant_source_references_entity_kind_valid";
ALTER TABLE "tenant_source_references"
  ADD CONSTRAINT "tenant_source_references_entity_kind_valid" CHECK ("entity_kind" IN ('product', 'person_affiliation'));

ALTER TABLE "tenant_context_changes" DROP CONSTRAINT "tenant_context_changes_entity_kind_valid";
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation'));

-- Interim data-quality kinds (Q7) until M10L; entity_kind stays company / person.
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_kind_valid" CHECK ("kind" IN ('shared_email', 'merge_across_systems', 'ambiguous_primary_company', 'hierarchy_cycle_refused', 'hierarchy_depth_exceeded', 'hierarchy_parent_merged', 'hierarchy_parent_unresolved', 'hierarchy_human_override_disagrees', 'affiliation_endpoint_unresolved'));

ALTER TABLE "tenant_value_history" DROP CONSTRAINT "tenant_value_history_field_valid";
ALTER TABLE "tenant_value_history"
  ADD CONSTRAINT "tenant_value_history_field_valid" CHECK (("entity_kind", "field") IN (('company', 'name'), ('company', 'parent_company_id'), ('subscription', 'state'), ('subscription', 'starts_at'), ('subscription', 'ends_at'), ('subscription', 'product_key'), ('subscription', 'quantity'), ('person_affiliation', 'status'), ('person_affiliation', 'starts_at'), ('person_affiliation', 'ends_at'), ('person_affiliation', 'role_codes')));

-- Entity index (the M10A2 triggers and functions; kind person_affiliation by id).
CREATE TRIGGER "tenant_person_affiliations_entity_index_add" AFTER INSERT ON "tenant_person_affiliations"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_add('person_affiliation');
CREATE TRIGGER "tenant_person_affiliations_entity_index_remove" BEFORE DELETE ON "tenant_person_affiliations"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_remove('person_affiliation');
CREATE TRIGGER "tenant_person_affiliations_identity_immutable" BEFORE UPDATE OF "id" ON "tenant_person_affiliations"
  FOR EACH ROW EXECUTE FUNCTION app_entity_identity_immutable('id');

-- ---------------------------------------------------------------------------
-- 5. Read-only views (plan §3.1, §5): security invoker, so RLS of the caller applies
-- ---------------------------------------------------------------------------
-- Every account reachable from a root within the 64-step ceiling, with its
-- root and depth (edges from the root). Derived, never stored.
CREATE VIEW "account_hierarchy_paths" WITH (security_invoker = true) AS
  WITH RECURSIVE walk ("tenant_id", "company_id", "parent_company_id", "root_company_id", "depth") AS (
    SELECT c."tenant_id", c."id", c."parent_company_id", c."id", 0
      FROM "companies" c WHERE c."parent_company_id" IS NULL
    UNION ALL
    SELECT c."tenant_id", c."id", c."parent_company_id", w."root_company_id", w."depth" + 1
      FROM walk w JOIN "companies" c ON c."tenant_id" = w."tenant_id" AND c."parent_company_id" = w."company_id"
     WHERE w."depth" < 64
  )
  SELECT "tenant_id", "company_id", "parent_company_id", "root_company_id", "depth" FROM walk;

-- Affiliations with the derived primary flag (Q9: persons.company_id stays the
-- single primary account; is_primary is never stored).
CREATE VIEW "person_affiliation_index" WITH (security_invoker = true) AS
  SELECT a."tenant_id", a."id", a."person_id", a."company_id", a."status", a."role_codes", a."starts_at", a."ends_at",
         a."ended_at", a."end_reason", a."origin", (p."company_id" IS NOT DISTINCT FROM a."company_id") AS "is_primary"
    FROM "tenant_person_affiliations" a
    JOIN "persons" p ON p."tenant_id" = a."tenant_id" AND p."id" = a."person_id";

REVOKE ALL ON "account_hierarchy_paths" FROM PUBLIC;
REVOKE ALL ON "person_affiliation_index" FROM PUBLIC;
-- The schema default privileges grant DML on new relations (views included) to lip_app; the views are read-only.
REVOKE ALL ON "account_hierarchy_paths" FROM lip_app;
REVOKE ALL ON "person_affiliation_index" FROM lip_app;
GRANT SELECT ON "account_hierarchy_paths" TO lip_app;
GRANT SELECT ON "person_affiliation_index" TO lip_app;

-- ---------------------------------------------------------------------------
-- 6. Canonical version 0.3 (plan §7; Q18, Q19)
-- ---------------------------------------------------------------------------
-- 0.2 moves to `supported` before 0.3 is inserted `current` (the one-current trigger).
ALTER TABLE "canonical_model_versions" NO FORCE ROW LEVEL SECURITY;
UPDATE "canonical_model_versions" SET "status" = 'supported' WHERE "version" = '0.2';
INSERT INTO "canonical_model_versions" ("version", "major", "minor", "status", "released_at", "catalogue_hash", "adr")
VALUES ('0.3', 0, 3, 'current', '2027-01-05 12:00:00+00', '70db9aa697147cf1d0d63e93a923ed8714b78da32550aaefe5699597e26eb069', '0029');
ALTER TABLE "canonical_model_versions" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 7. Audit catalogues: policy v4 capabilities and the M10C actions (plan §13)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry', 'config.canonical.adopt', 'config.module.change', 'config.registry.publish', 'config.data_policy.publish', 'config.mapping.draft', 'config.mapping.retire', 'security.integrity.run', 'canonical.evidence.link', 'data.provenance.read', 'data.account_structure.read')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied', 'canonical.adopt', 'module.enable', 'module.disable', 'module.configure', 'registry.publish', 'data_policy.publish', 'mapping.draft.save', 'mapping.draft.validate', 'mapping.draft.discard', 'mapping.retire', 'integrity.verify', 'provenance.read', 'evidence.link', 'source_reference.observe', 'account.hierarchy.set', 'account.hierarchy.clear', 'account.hierarchy.release', 'person.affiliation.add', 'person.affiliation.end', 'account_structure.read'));

-- ---------------------------------------------------------------------------
-- 8. Tenant isolation and privileges (plan §10, §13)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_person_affiliations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_person_affiliations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_person_affiliations"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE TRIGGER "tenant_person_affiliations_tenant_immutable" BEFORE UPDATE ON "tenant_person_affiliations"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();

-- Affiliations end, never disappear: no DELETE.
REVOKE ALL ON TABLE "tenant_person_affiliations" FROM lip_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_person_affiliations" TO lip_app;
