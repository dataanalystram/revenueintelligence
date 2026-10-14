-- Milestone 10A2 (ADR 0027), migration 2 of 2: tenant entity index, value
-- history, richer change records, mapping lifecycle and integrity runs.
--   1. Role lip_entity_indexer (NOLOGIN, powerless) owning the SECURITY
--      DEFINER index functions; tenant_entity_index (app role: SELECT only),
--      backfilled before RLS with counts asserted; triggers on companies,
--      persons, tenant_products and tenant_subscriptions.
--   2. tenant_value_history (append-only), anchored in the index.
--   3. Change records: origin, derivation, canonical_version,
--      schema_snapshot_hash, transforms; widened change-type and cause CHECKs.
--   4. Mapping lifecycle: tenant_source_mapping_drafts (mutable working
--      copies), tenant_source_mapping_lifecycle (append-only; backfilled
--      "latest wins"), the tenant_source_mapping_states view, and
--      tenant_source_mapping_versions.canonical_version_min (NULL = 0.1).
--   5. tenant_integrity_runs (append-only).
-- Additive only: new tables, nullable columns, widened CHECKs, triggers and a
-- NOLOGIN role; no existing row is rewritten.

-- ---------------------------------------------------------------------------
-- Prisma-generated structure
-- ---------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "tenant_context_changes" ADD COLUMN     "canonical_version" TEXT,
ADD COLUMN     "derivation" JSONB,
ADD COLUMN     "origin" TEXT,
ADD COLUMN     "schema_snapshot_hash" TEXT,
ADD COLUMN     "transforms" TEXT[];

-- AlterTable
ALTER TABLE "tenant_source_mapping_versions" ADD COLUMN     "canonical_version_min" TEXT;

-- CreateTable
CREATE TABLE "tenant_entity_index" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "entity_id" UUID,
    "entity_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_entity_index_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant_value_history" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "entity_kind" TEXT NOT NULL,
    "entity_id" UUID,
    "entity_key" TEXT,
    "field" TEXT NOT NULL,
    "values_recorded" BOOLEAN NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "change_id" UUID NOT NULL,
    "retention_class" TEXT NOT NULL,
    "policy_version" INTEGER,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_assurance" TEXT NOT NULL,

    CONSTRAINT "tenant_value_history_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant_source_mapping_drafts" (
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "document" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "validated_snapshot_hash" TEXT,
    "validated_authority_version" INTEGER,
    "validated_canonical_version" TEXT,
    "validation" JSONB,
    "updated_by_kind" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "updated_by_assurance" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_source_mapping_drafts_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant_source_mapping_lifecycle" (
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_assurance" TEXT NOT NULL,
    "reason_code" TEXT,
    "audit_event_id" UUID,

    CONSTRAINT "tenant_source_mapping_lifecycle_pkey" PRIMARY KEY ("tenant_id","connection_id","version","seq")
);

-- CreateTable
CREATE TABLE "tenant_integrity_runs" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3) NOT NULL,
    "outcome" TEXT NOT NULL,
    "checks" JSONB NOT NULL,
    "findings" JSONB NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_assurance" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "audit_event_id" UUID NOT NULL,

    CONSTRAINT "tenant_integrity_runs_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_entity_index_tenant_id_kind_entity_id_key" ON "tenant_entity_index"("tenant_id", "kind", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_entity_index_tenant_id_kind_entity_key_key" ON "tenant_entity_index"("tenant_id", "kind", "entity_key");

-- CreateIndex
CREATE INDEX "tenant_value_history_tenant_id_entity_kind_entity_id_effect_idx" ON "tenant_value_history"("tenant_id", "entity_kind", "entity_id", "effective_at");

-- CreateIndex
CREATE INDEX "tenant_value_history_tenant_id_change_id_idx" ON "tenant_value_history"("tenant_id", "change_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_source_mapping_drafts_tenant_id_connection_id_key" ON "tenant_source_mapping_drafts"("tenant_id", "connection_id");

-- CreateIndex
CREATE INDEX "tenant_integrity_runs_tenant_id_finished_at_idx" ON "tenant_integrity_runs"("tenant_id", "finished_at");

-- AddForeignKey
ALTER TABLE "tenant_context_changes" ADD CONSTRAINT "tenant_context_changes_canonical_version_fkey" FOREIGN KEY ("canonical_version") REFERENCES "canonical_model_versions"("version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_mapping_versions" ADD CONSTRAINT "tenant_source_mapping_versions_canonical_version_min_fkey" FOREIGN KEY ("canonical_version_min") REFERENCES "canonical_model_versions"("version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_entity_index" ADD CONSTRAINT "tenant_entity_index_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_value_history" ADD CONSTRAINT "tenant_value_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_value_history" ADD CONSTRAINT "tenant_value_history_tenant_id_change_id_fkey" FOREIGN KEY ("tenant_id", "change_id") REFERENCES "tenant_context_changes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_value_history" ADD CONSTRAINT "tenant_value_history_tenant_id_entity_kind_entity_id_fkey" FOREIGN KEY ("tenant_id", "entity_kind", "entity_id") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_value_history" ADD CONSTRAINT "tenant_value_history_tenant_id_entity_kind_entity_key_fkey" FOREIGN KEY ("tenant_id", "entity_kind", "entity_key") REFERENCES "tenant_entity_index"("tenant_id", "kind", "entity_key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_mapping_drafts" ADD CONSTRAINT "tenant_source_mapping_drafts_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_mapping_lifecycle" ADD CONSTRAINT "tenant_source_mapping_lifecycle_tenant_id_connection_id_ve_fkey" FOREIGN KEY ("tenant_id", "connection_id", "version") REFERENCES "tenant_source_mapping_versions"("tenant_id", "connection_id", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_mapping_lifecycle" ADD CONSTRAINT "tenant_source_mapping_lifecycle_tenant_id_audit_event_id_fkey" FOREIGN KEY ("tenant_id", "audit_event_id") REFERENCES "tenant_audit_events"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_integrity_runs" ADD CONSTRAINT "tenant_integrity_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_integrity_runs" ADD CONSTRAINT "tenant_integrity_runs_tenant_id_audit_event_id_fkey" FOREIGN KEY ("tenant_id", "audit_event_id") REFERENCES "tenant_audit_events"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 1. Tenant entity index (D2, F2, Q12, Q13)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_entity_index"
  ADD CONSTRAINT "tenant_entity_index_kind_valid" CHECK ("kind" IN ('company', 'person', 'product', 'subscription')),
  -- D3: products are indexed by key, every other kind by uuid; exactly one of the two.
  ADD CONSTRAINT "tenant_entity_index_one_identity" CHECK (("entity_id" IS NULL) <> ("entity_key" IS NULL)),
  ADD CONSTRAINT "tenant_entity_index_key_only_for_products" CHECK (("entity_key" IS NOT NULL) = ("kind" = 'product'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lip_entity_indexer') THEN
    CREATE ROLE lip_entity_indexer NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO lip_entity_indexer;

-- Backfill (before RLS is enabled, M8 pattern): one row per existing entity.
INSERT INTO "tenant_entity_index" ("tenant_id", "kind", "entity_id")
  SELECT "tenant_id", 'company', "id" FROM "companies";
INSERT INTO "tenant_entity_index" ("tenant_id", "kind", "entity_id")
  SELECT "tenant_id", 'person', "id" FROM "persons";
INSERT INTO "tenant_entity_index" ("tenant_id", "kind", "entity_key")
  SELECT "tenant_id", 'product', "key" FROM "tenant_products";
INSERT INTO "tenant_entity_index" ("tenant_id", "kind", "entity_id")
  SELECT "tenant_id", 'subscription', "id" FROM "tenant_subscriptions";

-- Parity check (M9A pattern): per tenant and kind, the index equals the entity tables.
DO $$
DECLARE mismatch bigint;
BEGIN
  WITH expected AS (
    SELECT "tenant_id", 'company' AS kind, count(*) AS n FROM "companies" GROUP BY 1
    UNION ALL SELECT "tenant_id", 'person', count(*) FROM "persons" GROUP BY 1
    UNION ALL SELECT "tenant_id", 'product', count(*) FROM "tenant_products" GROUP BY 1
    UNION ALL SELECT "tenant_id", 'subscription', count(*) FROM "tenant_subscriptions" GROUP BY 1
  ), actual AS (
    SELECT "tenant_id", "kind", count(*) AS n FROM "tenant_entity_index" GROUP BY 1, 2
  )
  SELECT count(*) INTO mismatch FROM expected e FULL JOIN actual a USING ("tenant_id", kind)
   WHERE e.n IS DISTINCT FROM a.n;
  IF mismatch > 0 THEN
    RAISE EXCEPTION 'M10A2 entity index backfill mismatch in % tenant/kind groups', mismatch;
  END IF;
END
$$;

ALTER TABLE "tenant_entity_index" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_entity_index" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_entity_index"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
-- The indexer's own policy: tenant-scoped whenever a tenant is bound. With no
-- tenant bound only an owner session can have written the entity row (the app
-- role cannot write an entity without a bound tenant), so the trigger may
-- index it under the row's own tenant_id.
CREATE POLICY entity_indexer ON "tenant_entity_index" TO lip_entity_indexer
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());
CREATE TRIGGER "tenant_entity_index_tenant_immutable" BEFORE UPDATE ON "tenant_entity_index"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();
CREATE TRIGGER "tenant_entity_index_no_update" BEFORE UPDATE ON "tenant_entity_index"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('entity index rows are never updated');

-- The app role reads the index only; the indexer inserts and deletes.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "tenant_entity_index" FROM lip_app;
GRANT SELECT ON TABLE "tenant_entity_index" TO lip_app;
GRANT SELECT, INSERT, DELETE ON TABLE "tenant_entity_index" TO lip_entity_indexer;

CREATE FUNCTION "app_entity_index_add"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_ARGV[0] = 'product' THEN
    INSERT INTO public.tenant_entity_index (tenant_id, kind, entity_key) VALUES (NEW.tenant_id, 'product', NEW.key);
  ELSE
    INSERT INTO public.tenant_entity_index (tenant_id, kind, entity_id) VALUES (NEW.tenant_id, TG_ARGV[0], NEW.id);
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION "app_entity_index_remove"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_ARGV[0] = 'product' THEN
    DELETE FROM public.tenant_entity_index WHERE tenant_id = OLD.tenant_id AND kind = 'product' AND entity_key = OLD.key;
  ELSE
    DELETE FROM public.tenant_entity_index WHERE tenant_id = OLD.tenant_id AND kind = TG_ARGV[0] AND entity_id = OLD.id;
  END IF;
  RETURN OLD;
END
$$;

-- Identity columns of indexed tables are immutable (an update would orphan the index row).
CREATE FUNCTION "app_entity_identity_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) -> TG_ARGV[0] IS DISTINCT FROM to_jsonb(OLD) -> TG_ARGV[0] THEN
    RAISE EXCEPTION '% is immutable on % (entity index)', TG_ARGV[0], TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Ownership: the powerless indexer role (the lip_webhook_router pattern).
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'lip_entity_indexer', 'MEMBER') THEN
    EXECUTE format('GRANT lip_entity_indexer TO %I', current_user);
  END IF;
END
$$;
ALTER FUNCTION "app_entity_index_add"() OWNER TO lip_entity_indexer;
ALTER FUNCTION "app_entity_index_remove"() OWNER TO lip_entity_indexer;
REVOKE ALL ON FUNCTION "app_entity_index_add"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app_entity_index_remove"() FROM PUBLIC;

CREATE TRIGGER "companies_entity_index_add" AFTER INSERT ON "companies"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_add('company');
CREATE TRIGGER "companies_entity_index_remove" BEFORE DELETE ON "companies"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_remove('company');
CREATE TRIGGER "companies_identity_immutable" BEFORE UPDATE OF "id" ON "companies"
  FOR EACH ROW EXECUTE FUNCTION app_entity_identity_immutable('id');
CREATE TRIGGER "persons_entity_index_add" AFTER INSERT ON "persons"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_add('person');
CREATE TRIGGER "persons_entity_index_remove" BEFORE DELETE ON "persons"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_remove('person');
CREATE TRIGGER "persons_identity_immutable" BEFORE UPDATE OF "id" ON "persons"
  FOR EACH ROW EXECUTE FUNCTION app_entity_identity_immutable('id');
CREATE TRIGGER "tenant_products_entity_index_add" AFTER INSERT ON "tenant_products"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_add('product');
CREATE TRIGGER "tenant_products_entity_index_remove" BEFORE DELETE ON "tenant_products"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_remove('product');
CREATE TRIGGER "tenant_products_identity_immutable" BEFORE UPDATE OF "key" ON "tenant_products"
  FOR EACH ROW EXECUTE FUNCTION app_entity_identity_immutable('key');
CREATE TRIGGER "tenant_subscriptions_entity_index_add" AFTER INSERT ON "tenant_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_add('subscription');
CREATE TRIGGER "tenant_subscriptions_entity_index_remove" BEFORE DELETE ON "tenant_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_remove('subscription');
CREATE TRIGGER "tenant_subscriptions_identity_immutable" BEFORE UPDATE OF "id" ON "tenant_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION app_entity_identity_immutable('id');

-- ---------------------------------------------------------------------------
-- 2. Value history (append-only; restricted history is value-free)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_value_history"
  ADD CONSTRAINT "tenant_value_history_one_identity" CHECK (("entity_id" IS NULL) <> ("entity_key" IS NULL)),
  ADD CONSTRAINT "tenant_value_history_field_valid" CHECK (("entity_kind", "field") IN (('company', 'name'), ('company', 'customer_status'), ('subscription', 'state'), ('subscription', 'starts_at'), ('subscription', 'ends_at'), ('subscription', 'product_key'), ('subscription', 'quantity'))),
  ADD CONSTRAINT "tenant_value_history_value_free" CHECK ("values_recorded" OR ("old_value" IS NULL AND "new_value" IS NULL)),
  ADD CONSTRAINT "tenant_value_history_policy_only_with_values" CHECK ("policy_version" IS NULL OR "values_recorded"),
  ADD CONSTRAINT "tenant_value_history_value_size" CHECK (("old_value" IS NULL OR octet_length("old_value"::text) <= 4096) AND ("new_value" IS NULL OR octet_length("new_value"::text) <= 4096)),
  ADD CONSTRAINT "tenant_value_history_retention_valid" CHECK ("retention_class" IN ('canonical_lifecycle', 'sensitive_value_history')),
  ADD CONSTRAINT "tenant_value_history_sensitive_needs_policy" CHECK (("retention_class" = 'sensitive_value_history') = ("policy_version" IS NOT NULL)),
  ADD CONSTRAINT "tenant_value_history_actor_kind_valid" CHECK ("actor_kind" IN ('source_sync', 'system', 'operator', 'human_user', 'ai')),
  ADD CONSTRAINT "tenant_value_history_actor_id_format" CHECK ("actor_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  ADD CONSTRAINT "tenant_value_history_actor_assurance_valid" CHECK ("actor_assurance" IN ('system', 'asserted', 'authenticated')),
  ADD CONSTRAINT "tenant_value_history_operator_asserted" CHECK ("actor_kind" <> 'operator' OR "actor_assurance" = 'asserted');

-- ---------------------------------------------------------------------------
-- 3. Change records (E5 §3, Q18)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_context_changes"
  DROP CONSTRAINT "tenant_context_changes_change_type_valid",
  DROP CONSTRAINT "tenant_context_changes_cause_valid";
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_change_type_valid" CHECK ("change_type" IN ('created', 'updated', 'state_changed', 'merged', 'ref_added', 'relationship_changed', 'retired', 'reactivated', 'promoted', 'migrated', 'superseded', 'retracted')),
  ADD CONSTRAINT "tenant_context_changes_cause_valid" CHECK ("cause" IN ('webhook', 'backfill', 'reconciliation', 'replay', 'resync', 'import', 'migration', 'derivation', 'human', 'ai')),
  ADD CONSTRAINT "tenant_context_changes_origin_valid" CHECK ("origin" IS NULL OR "origin" IN ('source_provided', 'deterministic', 'ai_derived', 'human', 'migration')),
  -- Written together since M10A2; both NULL on earlier rows (no invented backfill).
  ADD CONSTRAINT "tenant_context_changes_governance_pair" CHECK (("origin" IS NULL) = ("canonical_version" IS NULL)),
  ADD CONSTRAINT "tenant_context_changes_derivation_required" CHECK (("derivation" IS NOT NULL) = ("origin" IS NOT NULL AND "origin" IN ('deterministic', 'ai_derived'))),
  ADD CONSTRAINT "tenant_context_changes_derivation_shape" CHECK ("derivation" IS NULL OR (jsonb_typeof("derivation") = 'object' AND "derivation" ?& ARRAY['key', 'version', 'inputs_hash'] AND octet_length("derivation"::text) <= 1024)),
  ADD CONSTRAINT "tenant_context_changes_snapshot_hash_format" CHECK ("schema_snapshot_hash" IS NULL OR "schema_snapshot_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_context_changes_transforms_format" CHECK ("transforms" IS NULL OR array_to_string("transforms", ',') ~ '^([A-Za-z][A-Za-z0-9_]{0,63}:(nullValues|normalise|parse|valueMap)(,|$))*$');

-- ---------------------------------------------------------------------------
-- 4. Mapping lifecycle (E6 §4, Q5, Q7)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_source_mapping_drafts"
  ADD CONSTRAINT "tenant_source_mapping_drafts_state_valid" CHECK ("state" IN ('draft', 'validated')),
  ADD CONSTRAINT "tenant_source_mapping_drafts_stamp" CHECK (("state" = 'validated') = ("validated_snapshot_hash" IS NOT NULL AND "validated_authority_version" IS NOT NULL AND "validated_canonical_version" IS NOT NULL AND "validation" IS NOT NULL)),
  ADD CONSTRAINT "tenant_source_mapping_drafts_stamp_all_or_none" CHECK (("validated_snapshot_hash" IS NULL) = ("validated_authority_version" IS NULL) AND ("validated_authority_version" IS NULL) = ("validated_canonical_version" IS NULL) AND ("validated_canonical_version" IS NULL) = ("validation" IS NULL)),
  ADD CONSTRAINT "tenant_source_mapping_drafts_document_object" CHECK (jsonb_typeof("document") = 'object' AND octet_length("document"::text) <= 262144),
  ADD CONSTRAINT "tenant_source_mapping_drafts_document_no_secrets" CHECK (NOT app_jsonb_has_secret_like_key("document")),
  ADD CONSTRAINT "tenant_source_mapping_drafts_hash_format" CHECK ("content_hash" ~ '^[0-9a-f]{64}$' AND ("validated_snapshot_hash" IS NULL OR "validated_snapshot_hash" ~ '^[0-9a-f]{64}$')),
  ADD CONSTRAINT "tenant_source_mapping_drafts_version_positive" CHECK ("version" > 0),
  ADD CONSTRAINT "tenant_source_mapping_drafts_actor_kind_valid" CHECK ("updated_by_kind" IN ('source_sync', 'system', 'operator', 'human_user', 'ai')),
  ADD CONSTRAINT "tenant_source_mapping_drafts_actor_id_format" CHECK ("updated_by_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  ADD CONSTRAINT "tenant_source_mapping_drafts_actor_assurance_valid" CHECK ("updated_by_assurance" IN ('system', 'asserted', 'authenticated')),
  ADD CONSTRAINT "tenant_source_mapping_drafts_operator_asserted" CHECK ("updated_by_kind" <> 'operator' OR "updated_by_assurance" = 'asserted');

-- Any edit of the document returns the draft to `draft` and clears the stamp.
CREATE FUNCTION "app_mapping_draft_edit"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."document" IS DISTINCT FROM OLD."document" THEN
    NEW."state" := 'draft';
    NEW."validated_snapshot_hash" := NULL;
    NEW."validated_authority_version" := NULL;
    NEW."validated_canonical_version" := NULL;
    NEW."validation" := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tenant_source_mapping_drafts_edit_resets" BEFORE UPDATE ON "tenant_source_mapping_drafts"
  FOR EACH ROW EXECUTE FUNCTION app_mapping_draft_edit();

ALTER TABLE "tenant_source_mapping_lifecycle"
  ADD CONSTRAINT "tenant_source_mapping_lifecycle_seq_positive" CHECK ("seq" > 0),
  ADD CONSTRAINT "tenant_source_mapping_lifecycle_state_valid" CHECK ("state" IN ('published', 'superseded', 'retired')),
  ADD CONSTRAINT "tenant_source_mapping_lifecycle_reason_format" CHECK ("reason_code" IS NULL OR "reason_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD CONSTRAINT "tenant_source_mapping_lifecycle_retire_reason" CHECK ("state" <> 'retired' OR "reason_code" IN ('connection_disabled', 'canonical_version_unsupported', 'operator_retired')),
  -- Only the migration's backfill has no audit event.
  ADD CONSTRAINT "tenant_source_mapping_lifecycle_audit_required" CHECK (("audit_event_id" IS NULL) = ("actor_id" = 'system:migration:m10a2')),
  ADD CONSTRAINT "tenant_source_mapping_lifecycle_actor_kind_valid" CHECK ("actor_kind" IN ('source_sync', 'system', 'operator', 'human_user', 'ai')),
  ADD CONSTRAINT "tenant_source_mapping_lifecycle_actor_id_format" CHECK ("actor_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  ADD CONSTRAINT "tenant_source_mapping_lifecycle_actor_assurance_valid" CHECK ("actor_assurance" IN ('system', 'asserted', 'authenticated')),
  ADD CONSTRAINT "tenant_source_mapping_lifecycle_operator_asserted" CHECK ("actor_kind" <> 'operator' OR "actor_assurance" = 'asserted');

-- Backfill (before the transition trigger and RLS): per connection the highest
-- version is published, earlier versions were published then superseded.
INSERT INTO "tenant_source_mapping_lifecycle"
  ("tenant_id", "connection_id", "version", "seq", "state", "occurred_at", "actor_kind", "actor_id", "actor_assurance")
SELECT v."tenant_id", v."connection_id", v."version", 1, 'published', v."published_at",
       'system', 'system:migration:m10a2', 'system'
  FROM "tenant_source_mapping_versions" v;
INSERT INTO "tenant_source_mapping_lifecycle"
  ("tenant_id", "connection_id", "version", "seq", "state", "occurred_at", "actor_kind", "actor_id", "actor_assurance")
SELECT v."tenant_id", v."connection_id", v."version", 2, 'superseded', CURRENT_TIMESTAMP,
       'system', 'system:migration:m10a2', 'system'
  FROM "tenant_source_mapping_versions" v
 WHERE v."version" < (SELECT max(w."version") FROM "tenant_source_mapping_versions" w
                       WHERE w."tenant_id" = v."tenant_id" AND w."connection_id" = v."connection_id");

DO $$
DECLARE connections_n bigint; published_n bigint;
BEGIN
  SELECT count(*) INTO connections_n FROM (SELECT DISTINCT "tenant_id", "connection_id" FROM "tenant_source_mapping_versions") c;
  SELECT count(*) INTO published_n FROM (
    SELECT DISTINCT ON ("tenant_id", "connection_id", "version") "state"
      FROM "tenant_source_mapping_lifecycle" ORDER BY "tenant_id", "connection_id", "version", "seq" DESC) s
   WHERE s."state" = 'published';
  IF connections_n <> published_n THEN
    RAISE EXCEPTION 'M10A2 mapping lifecycle backfill mismatch: % connections, % published', connections_n, published_n;
  END IF;
END
$$;

-- Legal transitions (∅ → published, published → superseded | retired,
-- superseded → retired; nothing leaves retired), dense seq per version, and at
-- most one published version per connection.
CREATE FUNCTION "app_mapping_lifecycle_transition"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev record;
  others bigint;
BEGIN
  SELECT l."seq", l."state" INTO prev FROM "tenant_source_mapping_lifecycle" l
   WHERE l."tenant_id" = NEW."tenant_id" AND l."connection_id" = NEW."connection_id" AND l."version" = NEW."version"
   ORDER BY l."seq" DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW."state" <> 'published' OR NEW."seq" <> 1 THEN
      RAISE EXCEPTION 'illegal mapping lifecycle transition: none -> % (seq %)', NEW."state", NEW."seq" USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."seq" <> prev."seq" + 1
     OR NOT ((prev."state" = 'published' AND NEW."state" IN ('superseded', 'retired'))
          OR (prev."state" = 'superseded' AND NEW."state" = 'retired')) THEN
    RAISE EXCEPTION 'illegal mapping lifecycle transition: % -> %', prev."state", NEW."state" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."state" = 'published' THEN
    SELECT count(*) INTO others FROM (
      SELECT DISTINCT ON (l."version") l."version", l."state" FROM "tenant_source_mapping_lifecycle" l
       WHERE l."tenant_id" = NEW."tenant_id" AND l."connection_id" = NEW."connection_id" AND l."version" <> NEW."version"
       ORDER BY l."version", l."seq" DESC) s
     WHERE s."state" = 'published';
    IF others > 0 THEN
      RAISE EXCEPTION 'a connection has at most one published mapping version' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tenant_source_mapping_lifecycle_transition" BEFORE INSERT ON "tenant_source_mapping_lifecycle"
  FOR EACH ROW EXECUTE FUNCTION app_mapping_lifecycle_transition();

-- Current state per published version (security invoker: RLS of the caller applies).
CREATE VIEW "tenant_source_mapping_states" WITH (security_invoker = true) AS
  SELECT DISTINCT ON (l."tenant_id", l."connection_id", l."version")
         l."tenant_id", l."connection_id", l."version", l."state", l."occurred_at", l."seq"
    FROM "tenant_source_mapping_lifecycle" l
   ORDER BY l."tenant_id", l."connection_id", l."version", l."seq" DESC;
REVOKE ALL ON "tenant_source_mapping_states" FROM PUBLIC;
GRANT SELECT ON "tenant_source_mapping_states" TO lip_app;

-- ---------------------------------------------------------------------------
-- 5. Integrity runs (append-only)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_integrity_runs"
  ADD CONSTRAINT "tenant_integrity_runs_outcome_valid" CHECK ("outcome" IN ('passed', 'findings', 'failed')),
  ADD CONSTRAINT "tenant_integrity_runs_time_ordered" CHECK ("started_at" <= "finished_at"),
  ADD CONSTRAINT "tenant_integrity_runs_checks_object" CHECK (jsonb_typeof("checks") = 'object' AND octet_length("checks"::text) <= 4096),
  ADD CONSTRAINT "tenant_integrity_runs_findings_array" CHECK (jsonb_typeof("findings") = 'array' AND octet_length("findings"::text) <= 16384),
  ADD CONSTRAINT "tenant_integrity_runs_findings_no_secrets" CHECK (NOT app_jsonb_has_secret_like_key("findings")),
  ADD CONSTRAINT "tenant_integrity_runs_actor_kind_valid" CHECK ("actor_kind" IN ('source_sync', 'system', 'operator', 'human_user', 'ai')),
  ADD CONSTRAINT "tenant_integrity_runs_actor_id_format" CHECK ("actor_id" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  ADD CONSTRAINT "tenant_integrity_runs_actor_assurance_valid" CHECK ("actor_assurance" IN ('system', 'asserted', 'authenticated')),
  ADD CONSTRAINT "tenant_integrity_runs_operator_asserted" CHECK ("actor_kind" <> 'operator' OR "actor_assurance" = 'asserted');

-- ---------------------------------------------------------------------------
-- 6. Tenant isolation and append-only protection
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_value_history', 'tenant_source_mapping_drafts',
                           'tenant_source_mapping_lifecycle', 'tenant_integrity_runs'] LOOP
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

CREATE TRIGGER "tenant_value_history_append_only" BEFORE UPDATE OR DELETE ON "tenant_value_history"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('value history is append-only');
CREATE TRIGGER "tenant_source_mapping_lifecycle_append_only" BEFORE UPDATE OR DELETE ON "tenant_source_mapping_lifecycle"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('mapping lifecycle events are append-only');
CREATE TRIGGER "tenant_integrity_runs_append_only" BEFORE UPDATE OR DELETE ON "tenant_integrity_runs"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('integrity runs are append-only');

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_value_history" FROM lip_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_source_mapping_lifecycle" FROM lip_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_integrity_runs" FROM lip_app;
REVOKE TRUNCATE ON TABLE "tenant_source_mapping_drafts" FROM lip_app;
