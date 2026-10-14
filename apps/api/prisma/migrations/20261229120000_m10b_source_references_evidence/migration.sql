-- Milestone 10B (ADR 0028): generic source references, evidence links and
-- canonical version 0.2 (plan docs/milestones/M10B-source-reference-evidence-link-plan.md).
--   1. Change records: entity_key, entity_id nullable under an exactly-one
--      CHECK, entity kind `product` (key-identified, D3).
--   2. tenant_source_references (forced RLS; app role SELECT/INSERT/UPDATE, no
--      DELETE): lifecycle CHECKs incl. the named retirement gate, the named
--      not-legacy-kind CHECK, identity-immutability and updated_at triggers.
--   3. Backfill (before RLS, M8 pattern): declared product references from
--      each tenant's latest published product model; counts asserted.
--      Company / person references and subscription triples are NOT copied (Q2).
--   4. tenant_evidence_links (forced RLS; append-only by privilege and trigger).
--   5. source_reference_index: read-only security-invoker view over all stores.
--   6. canonical_model_versions: 0.1 -> supported, 0.2 current (ADR 0028).
--   7. Audit capability / action CHECKs widened to policy v3.
-- Additive only: new tables, a view, a nullable column, a relaxed NOT NULL
-- guarded by a CHECK, widened CHECKs, triggers and grants on new objects. No
-- existing row is rewritten (the 0.1 status change is platform reference data).

-- ---------------------------------------------------------------------------
-- Prisma-generated structure
-- ---------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "tenant_context_changes" ADD COLUMN     "entity_key" TEXT,
ALTER COLUMN "entity_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "tenant_source_references" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "system" TEXT NOT NULL,
    "connection_id" UUID,
    "object_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "entity_kind" TEXT NOT NULL,
    "entity_id" UUID,
    "entity_key" TEXT,
    "origin" TEXT NOT NULL,
    "declared_in_model_version" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'active',
    "merged_into_external_id" TEXT,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_created_at" TIMESTAMPTZ(3),
    "source_updated_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "retired_by_run_id" UUID,
    "retired_by_model_version" INTEGER,
    "field_hash" TEXT,
    "last_change_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_source_references_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant_evidence_links" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "link_set_id" UUID NOT NULL,
    "ordinal" SMALLINT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "subject_id" UUID,
    "subject_key" TEXT,
    "evidence_type" TEXT NOT NULL,
    "evidence_kind" TEXT,
    "evidence_id" UUID,
    "evidence_key" TEXT,
    "evidence_change_id" UUID,
    "evidence_snapshot_id" UUID,
    "role" TEXT NOT NULL,
    "weight" DECIMAL(5,4),
    "origin" TEXT NOT NULL,
    "derivation" JSONB,
    "supersedes_link_set_id" UUID,
    "change_id" UUID,
    "canonical_version" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_assurance" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_evidence_links_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE INDEX "tenant_source_references_tenant_id_entity_kind_entity_id_idx" ON "tenant_source_references"("tenant_id", "entity_kind", "entity_id");

-- CreateIndex
CREATE INDEX "tenant_source_references_tenant_id_entity_kind_entity_key_idx" ON "tenant_source_references"("tenant_id", "entity_kind", "entity_key");

-- CreateIndex
CREATE INDEX "tenant_source_references_tenant_id_system_object_type_state_idx" ON "tenant_source_references"("tenant_id", "system", "object_type", "state");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_source_references_tenant_id_system_object_type_exter_key" ON "tenant_source_references"("tenant_id", "system", "object_type", "external_id");

-- CreateIndex
CREATE INDEX "tenant_evidence_links_tenant_id_subject_kind_subject_id_idx" ON "tenant_evidence_links"("tenant_id", "subject_kind", "subject_id");

-- CreateIndex
CREATE INDEX "tenant_evidence_links_tenant_id_subject_kind_subject_key_idx" ON "tenant_evidence_links"("tenant_id", "subject_kind", "subject_key");

-- CreateIndex
CREATE INDEX "tenant_evidence_links_tenant_id_evidence_kind_evidence_id_idx" ON "tenant_evidence_links"("tenant_id", "evidence_kind", "evidence_id");

-- CreateIndex
CREATE INDEX "tenant_evidence_links_tenant_id_evidence_change_id_idx" ON "tenant_evidence_links"("tenant_id", "evidence_change_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_evidence_links_tenant_id_link_set_id_ordinal_key" ON "tenant_evidence_links"("tenant_id", "link_set_id", "ordinal");

-- CreateIndex
CREATE INDEX "tenant_context_changes_tenant_id_entity_kind_entity_key_ing_idx" ON "tenant_context_changes"("tenant_id", "entity_kind", "entity_key", "ingested_at");

-- AddForeignKey
ALTER TABLE "tenant_source_references" ADD CONSTRAINT "tenant_source_references_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_references" ADD CONSTRAINT "tenant_source_references_system_fkey" FOREIGN KEY ("system") REFERENCES "connector_kinds"("kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_references" ADD CONSTRAINT "tenant_source_references_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_references" ADD CONSTRAINT "tenant_source_references_tenant_id_entity_kind_entity_id_fkey" FOREIGN KEY ("tenant_id", "entity_kind", "entity_id") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_references" ADD CONSTRAINT "tenant_source_references_tenant_id_entity_kind_entity_key_fkey" FOREIGN KEY ("tenant_id", "entity_kind", "entity_key") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_references" ADD CONSTRAINT "tenant_source_references_tenant_id_declared_in_model_versi_fkey" FOREIGN KEY ("tenant_id", "declared_in_model_version") REFERENCES "tenant_product_models"("tenant_id", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_references" ADD CONSTRAINT "tenant_source_references_tenant_id_retired_by_model_versio_fkey" FOREIGN KEY ("tenant_id", "retired_by_model_version") REFERENCES "tenant_product_models"("tenant_id", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_references" ADD CONSTRAINT "tenant_source_references_tenant_id_retired_by_run_id_fkey" FOREIGN KEY ("tenant_id", "retired_by_run_id") REFERENCES "tenant_sync_checkpoints"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_references" ADD CONSTRAINT "tenant_source_references_tenant_id_last_change_id_fkey" FOREIGN KEY ("tenant_id", "last_change_id") REFERENCES "tenant_context_changes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_evidence_links" ADD CONSTRAINT "tenant_evidence_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_evidence_links" ADD CONSTRAINT "tenant_evidence_links_tenant_id_subject_kind_subject_id_fkey" FOREIGN KEY ("tenant_id", "subject_kind", "subject_id") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_evidence_links" ADD CONSTRAINT "tenant_evidence_links_tenant_id_subject_kind_subject_key_fkey" FOREIGN KEY ("tenant_id", "subject_kind", "subject_key") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_evidence_links" ADD CONSTRAINT "tenant_evidence_links_tenant_id_evidence_kind_evidence_id_fkey" FOREIGN KEY ("tenant_id", "evidence_kind", "evidence_id") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_evidence_links" ADD CONSTRAINT "tenant_evidence_links_tenant_id_evidence_kind_evidence_key_fkey" FOREIGN KEY ("tenant_id", "evidence_kind", "evidence_key") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
CREATE UNIQUE INDEX "vm4_tenant_context_changes_id" ON "tenant_context_changes"("id");
ALTER TABLE "tenant_evidence_links" ADD CONSTRAINT "tenant_evidence_links_tenant_id_evidence_change_id_fkey" FOREIGN KEY ("evidence_change_id") REFERENCES "tenant_context_changes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_evidence_links" ADD CONSTRAINT "tenant_evidence_links_tenant_id_evidence_snapshot_id_fkey" FOREIGN KEY ("tenant_id", "evidence_snapshot_id") REFERENCES "tenant_eligibility_snapshots"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_evidence_links" ADD CONSTRAINT "tenant_evidence_links_tenant_id_change_id_fkey" FOREIGN KEY ("tenant_id", "change_id") REFERENCES "tenant_context_changes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_evidence_links" ADD CONSTRAINT "tenant_evidence_links_canonical_version_fkey" FOREIGN KEY ("canonical_version") REFERENCES "canonical_model_versions"("version") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- 1. Change records (plan §6, Q8)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_context_changes"
  DROP CONSTRAINT "tenant_context_changes_entity_kind_valid";
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product')),
  ADD CONSTRAINT "tenant_context_changes_one_identity" CHECK (("entity_id" IS NULL) <> ("entity_key" IS NULL)),
  ADD CONSTRAINT "tenant_context_changes_key_only_for_products" CHECK (("entity_key" IS NOT NULL) = ("entity_kind" = 'product'));

-- ---------------------------------------------------------------------------
-- 2. Generic source references (plan §2.1, §2.4)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_source_references"
  ADD CONSTRAINT "tenant_source_references_entity_kind_valid" CHECK ("entity_kind" IN ('product')),
  -- Q2: legacy kinds keep their own stores; never copied into the generic store.
  ADD CONSTRAINT "tenant_source_references_not_legacy_kind" CHECK ("entity_kind" NOT IN ('company', 'person', 'subscription')),
  ADD CONSTRAINT "tenant_source_references_one_identity" CHECK (("entity_id" IS NULL) <> ("entity_key" IS NULL)),
  ADD CONSTRAINT "tenant_source_references_key_only_for_products" CHECK (("entity_key" IS NOT NULL) = ("entity_kind" = 'product')),
  -- Identifiers only, never values (as ProductExternalRefSchema).
  ADD CONSTRAINT "tenant_source_references_object_type_format" CHECK ("object_type" ~ '^[A-Za-z0-9_]{1,100}$'),
  ADD CONSTRAINT "tenant_source_references_external_id_format" CHECK ("external_id" ~ '^[A-Za-z0-9_.:-]{1,255}$'),
  ADD CONSTRAINT "tenant_source_references_origin_valid" CHECK ("origin" IN ('observed', 'declared')),
  ADD CONSTRAINT "tenant_source_references_declared_version" CHECK (("origin" = 'declared') = ("declared_in_model_version" IS NOT NULL)),
  ADD CONSTRAINT "tenant_source_references_state_valid" CHECK ("state" IN ('active', 'retired', 'deleted', 'merged')),
  ADD CONSTRAINT "tenant_source_references_merged_target" CHECK (("state" = 'merged') = ("merged_into_external_id" IS NOT NULL)),
  ADD CONSTRAINT "tenant_source_references_merged_target_format" CHECK ("merged_into_external_id" IS NULL OR "merged_into_external_id" ~ '^[A-Za-z0-9_.:-]{1,255}$'),
  ADD CONSTRAINT "tenant_source_references_deleted_at" CHECK (("state" = 'deleted') = ("deleted_at" IS NOT NULL)),
  -- Retirement only by an accepted run (observed) or an explicit model version (declared); all columns NULL otherwise.
  ADD CONSTRAINT "tenant_source_references_retirement_gate" CHECK (CASE WHEN "state" = 'retired' THEN "retired_at" IS NOT NULL AND (("origin" = 'observed' AND "retired_by_run_id" IS NOT NULL AND "retired_by_model_version" IS NULL) OR ("origin" = 'declared' AND "retired_by_model_version" IS NOT NULL AND "retired_by_run_id" IS NULL)) ELSE "retired_at" IS NULL AND "retired_by_run_id" IS NULL AND "retired_by_model_version" IS NULL END),
  ADD CONSTRAINT "tenant_source_references_field_hash_format" CHECK ("field_hash" IS NULL OR "field_hash" ~ '^[0-9a-f]{64}$');

-- Identity never changes: system, object_type, external_id, origin and
-- entity_kind are fixed; the entity is re-pointed only by a merge (ADR 0014 §5)
-- or by a later product-model version re-declaring the reference (Q6).
CREATE FUNCTION "app_source_reference_identity_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."system" IS DISTINCT FROM OLD."system" OR NEW."object_type" IS DISTINCT FROM OLD."object_type"
     OR NEW."external_id" IS DISTINCT FROM OLD."external_id" OR NEW."origin" IS DISTINCT FROM OLD."origin"
     OR NEW."entity_kind" IS DISTINCT FROM OLD."entity_kind" THEN
    RAISE EXCEPTION 'source reference identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."entity_id" IS DISTINCT FROM OLD."entity_id" OR NEW."entity_key" IS DISTINCT FROM OLD."entity_key")
     AND NOT (NEW."state" = 'merged' OR OLD."origin" = 'declared') THEN
    RAISE EXCEPTION 'a source reference is re-pointed only by a merge or a re-declaration' USING ERRCODE = 'check_violation';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Backfill: declared product references (plan §2.3, §8 step 3; Q3, Q5, Q6)
-- ---------------------------------------------------------------------------
-- One `declared`, `active` row per externalRefs[] entry of each tenant's
-- highest published model version (the version tenant_products reflects). No
-- change record is written: the model version row is the provenance.
INSERT INTO "tenant_source_references"
  ("tenant_id", "system", "object_type", "external_id", "entity_kind", "entity_key", "origin",
   "declared_in_model_version", "state", "first_seen_at", "last_seen_at")
SELECT m."tenant_id", r ->> 'system', r ->> 'objectType', r ->> 'id', 'product', p ->> 'key', 'declared',
       m."version", 'active', m."published_at", m."published_at"
  FROM "tenant_product_models" m
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m."document" -> 'products') = 'array'
                                               THEN m."document" -> 'products' ELSE '[]'::jsonb END) p
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p -> 'externalRefs') = 'array'
                                               THEN p -> 'externalRefs' ELSE '[]'::jsonb END) r
 WHERE m."version" = (SELECT max(w."version") FROM "tenant_product_models" w WHERE w."tenant_id" = m."tenant_id");

-- Parity (M9A pattern): per tenant, rows = externalRefs entries of the latest model.
DO $$
DECLARE mismatch bigint;
BEGIN
  WITH latest AS (
    SELECT m.* FROM "tenant_product_models" m
     WHERE m."version" = (SELECT max(w."version") FROM "tenant_product_models" w WHERE w."tenant_id" = m."tenant_id")
  ), expected AS (
    SELECT l."tenant_id", count(r) AS n
      FROM latest l
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l."document" -> 'products') = 'array'
                                                   THEN l."document" -> 'products' ELSE '[]'::jsonb END) p
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p -> 'externalRefs') = 'array'
                                                   THEN p -> 'externalRefs' ELSE '[]'::jsonb END) r
     GROUP BY 1
  ), actual AS (
    SELECT "tenant_id", count(*) AS n FROM "tenant_source_references" GROUP BY 1
  )
  SELECT count(*) INTO mismatch FROM expected e FULL JOIN actual a USING ("tenant_id")
   WHERE e.n IS DISTINCT FROM a.n;
  IF mismatch > 0 THEN
    RAISE EXCEPTION 'M10B declared product reference backfill mismatch in % tenants', mismatch;
  END IF;
  SELECT count(*) INTO mismatch FROM "tenant_source_references"
   WHERE "origin" <> 'declared' OR "state" <> 'active' OR "entity_kind" <> 'product' OR "last_change_id" IS NOT NULL;
  IF mismatch > 0 THEN
    RAISE EXCEPTION 'M10B backfill wrote % rows that are not declared active product references', mismatch;
  END IF;
END
$$;

CREATE TRIGGER "tenant_source_references_reference_identity" BEFORE UPDATE ON "tenant_source_references"
  FOR EACH ROW EXECUTE FUNCTION app_source_reference_identity_immutable();

-- ---------------------------------------------------------------------------
-- 4. Evidence links (plan §3.1; Q11–Q15)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_evidence_links"
  ADD CONSTRAINT "tenant_evidence_links_ordinal_range" CHECK ("ordinal" BETWEEN 0 AND 999),
  ADD CONSTRAINT "tenant_evidence_links_subject_one_identity" CHECK (("subject_id" IS NULL) <> ("subject_key" IS NULL)),
  ADD CONSTRAINT "tenant_evidence_links_subject_key_only_for_products" CHECK (("subject_key" IS NOT NULL) = ("subject_kind" = 'product')),
  ADD CONSTRAINT "tenant_evidence_links_evidence_type_valid" CHECK ("evidence_type" IN ('entity', 'change_record', 'eligibility_snapshot')),
  -- Exactly the column group of the evidence type is set; every other group is NULL.
  ADD CONSTRAINT "tenant_evidence_links_evidence_group" CHECK (CASE "evidence_type"
    WHEN 'entity' THEN "evidence_kind" IS NOT NULL AND (("evidence_id" IS NULL) <> ("evidence_key" IS NULL))
                       AND (("evidence_key" IS NOT NULL) = ("evidence_kind" = 'product'))
                       AND "evidence_change_id" IS NULL AND "evidence_snapshot_id" IS NULL
    WHEN 'change_record' THEN "evidence_change_id" IS NOT NULL AND "evidence_kind" IS NULL AND "evidence_id" IS NULL
                       AND "evidence_key" IS NULL AND "evidence_snapshot_id" IS NULL
    WHEN 'eligibility_snapshot' THEN "evidence_snapshot_id" IS NOT NULL AND "evidence_kind" IS NULL AND "evidence_id" IS NULL
                       AND "evidence_key" IS NULL AND "evidence_change_id" IS NULL
    ELSE false END),
  -- An entity link never cites its own subject.
  ADD CONSTRAINT "tenant_evidence_links_not_self" CHECK ("evidence_type" <> 'entity' OR NOT ("evidence_kind" = "subject_kind" AND "evidence_id" IS NOT DISTINCT FROM "subject_id" AND "evidence_key" IS NOT DISTINCT FROM "subject_key")),
  ADD CONSTRAINT "tenant_evidence_links_role_valid" CHECK ("role" IN ('supports', 'contradicts', 'derived_from', 'context')),
  ADD CONSTRAINT "tenant_evidence_links_weight_range" CHECK ("weight" IS NULL OR ("weight" >= 0 AND "weight" <= 1)),
  ADD CONSTRAINT "tenant_evidence_links_origin_valid" CHECK ("origin" IN ('source_provided', 'deterministic', 'ai_derived', 'human')),
  ADD CONSTRAINT "tenant_evidence_links_derivation_required" CHECK (("derivation" IS NOT NULL) = ("origin" IN ('deterministic', 'ai_derived'))),
  ADD CONSTRAINT "tenant_evidence_links_derivation_shape" CHECK ("derivation" IS NULL OR (jsonb_typeof("derivation") = 'object' AND "derivation" ?& ARRAY['key', 'version', 'inputs_hash'] AND octet_length("derivation"::text) <= 1024)),
  ADD CONSTRAINT "tenant_evidence_links_derivation_no_secrets" CHECK ("derivation" IS NULL OR NOT app_jsonb_has_secret_like_key("derivation")),
  ADD CONSTRAINT "tenant_evidence_links_supersedes_other_set" CHECK ("supersedes_link_set_id" IS NULL OR "supersedes_link_set_id" <> "link_set_id"),
  ADD CONSTRAINT "tenant_evidence_links_actor_kind_valid" CHECK ("actor_kind" IN ('source_sync', 'system', 'operator', 'human_user', 'ai')),
  ADD CONSTRAINT "tenant_evidence_links_actor_id_format" CHECK ("actor_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  ADD CONSTRAINT "tenant_evidence_links_actor_assurance_valid" CHECK ("actor_assurance" IN ('system', 'asserted', 'authenticated')),
  ADD CONSTRAINT "tenant_evidence_links_operator_asserted" CHECK ("actor_kind" <> 'operator' OR "actor_assurance" = 'asserted');

-- ---------------------------------------------------------------------------
-- 5. source_reference_index: read-only union of every reference store (plan §4)
-- ---------------------------------------------------------------------------
CREATE VIEW "source_reference_index" WITH (security_invoker = true) AS
  SELECT r."tenant_id", 'company_external_refs'::text AS "store", 'company'::text AS "entity_kind",
         r."company_id" AS "entity_id", NULL::text AS "entity_key", r."system", r."object_type", r."external_id",
         r."state", 'observed'::text AS "origin", r."first_seen_at", r."last_seen_at", r."source_updated_at", r."retired_at"
    FROM "company_external_refs" r
  UNION ALL
  SELECT r."tenant_id", 'person_external_refs', 'person', r."person_id", NULL, r."system", r."object_type", r."external_id",
         r."state", 'observed', r."first_seen_at", r."last_seen_at", r."source_updated_at", NULL::timestamptz(3)
    FROM "person_external_refs" r
  UNION ALL
  SELECT s."tenant_id", 'tenant_subscriptions', 'subscription', s."id", NULL, s."source_system", s."source_object_type",
         s."source_record_id", s."record_state", 'observed', s."first_seen_at", s."last_seen_at", s."source_updated_at", NULL
    FROM "tenant_subscriptions" s
  UNION ALL
  SELECT g."tenant_id", 'tenant_source_references', g."entity_kind", g."entity_id", g."entity_key", g."system", g."object_type",
         g."external_id", g."state", g."origin", g."first_seen_at", g."last_seen_at", g."source_updated_at", g."retired_at"
    FROM "tenant_source_references" g;
REVOKE ALL ON "source_reference_index" FROM PUBLIC;
-- The schema default privileges grant DML on new relations (views included) to lip_app; the view is read-only.
REVOKE ALL ON "source_reference_index" FROM lip_app;
GRANT SELECT ON "source_reference_index" TO lip_app;

-- Per-store parity: the view returns every row of every store, nothing copied.
DO $$
DECLARE mismatch bigint;
BEGIN
  WITH expected AS (
    SELECT 'company_external_refs' AS store, count(*) AS n FROM "company_external_refs"
    UNION ALL SELECT 'person_external_refs', count(*) FROM "person_external_refs"
    UNION ALL SELECT 'tenant_subscriptions', count(*) FROM "tenant_subscriptions"
    UNION ALL SELECT 'tenant_source_references', count(*) FROM "tenant_source_references"
  ), actual AS (
    SELECT "store", count(*) AS n FROM "source_reference_index" GROUP BY 1
  )
  SELECT count(*) INTO mismatch FROM expected e LEFT JOIN actual a USING (store)
   WHERE e.n <> coalesce(a.n, 0);
  IF mismatch > 0 THEN
    RAISE EXCEPTION 'M10B source_reference_index parity mismatch in % stores', mismatch;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. Canonical version 0.2 (plan §7; Q19, Q20, Q21)
-- ---------------------------------------------------------------------------
-- 0.1 moves to `supported` before 0.2 is inserted `current` (the one-current
-- trigger). The table's forced RLS has a read policy only; the owner writes
-- this platform reference data with forcing lifted inside this transaction.
ALTER TABLE "canonical_model_versions" NO FORCE ROW LEVEL SECURITY;
UPDATE "canonical_model_versions" SET "status" = 'supported' WHERE "version" = '0.1';
INSERT INTO "canonical_model_versions" ("version", "major", "minor", "status", "released_at", "catalogue_hash", "adr")
VALUES ('0.2', 0, 2, 'current', '2026-12-29 12:00:00+00', 'db7c0fc245cae469e8cddae88b89077c017805c7b87586b9d3e71f1936c96c98', '0028');
ALTER TABLE "canonical_model_versions" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 7. Audit catalogues: policy v3 capabilities and the M10B actions (plan §13)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry', 'config.canonical.adopt', 'config.module.change', 'config.registry.publish', 'config.data_policy.publish', 'config.mapping.draft', 'config.mapping.retire', 'security.integrity.run', 'canonical.evidence.link', 'data.provenance.read')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied', 'canonical.adopt', 'module.enable', 'module.disable', 'module.configure', 'registry.publish', 'data_policy.publish', 'mapping.draft.save', 'mapping.draft.validate', 'mapping.draft.discard', 'mapping.retire', 'integrity.verify', 'provenance.read', 'evidence.link', 'source_reference.observe'));

-- ---------------------------------------------------------------------------
-- 8. Tenant isolation, append-only protection and privileges (plan §10, §13)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_source_references', 'tenant_evidence_links'] LOOP
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

CREATE TRIGGER "tenant_evidence_links_append_only" BEFORE UPDATE OR DELETE ON "tenant_evidence_links"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('evidence links are append-only');

-- References change state, never disappear: no DELETE. Evidence: SELECT, INSERT only.
REVOKE ALL ON TABLE "tenant_source_references" FROM lip_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_source_references" TO lip_app;
REVOKE ALL ON TABLE "tenant_evidence_links" FROM lip_app;
GRANT SELECT, INSERT ON TABLE "tenant_evidence_links" TO lip_app;
