-- Milestone 10E (ADR 0031): AccountContext and canonical version 0.5
-- (plan docs/milestones/M10E-account-context-plan.md).
--   1. tenant_account_contexts (entity-index kind account_context; direct
--      composite FK to the account, F2; the context type as a composite FK to
--      the registry projection), tenant_account_context_persons,
--      tenant_account_context_products, tenant_subscriptions.context_id (0..1)
--      and tenant_source_authority_versions.account_context_connection_id (Q16).
--   2. CHECKs, the context guard (identity immutable, merged terminal, one
--      active context per natural key serialised by an advisory lock, no new
--      context of a retired type), the membership guards and the deferred
--      line / context same-account guard (Q8).
--   3. Kind CHECKs widened: entity index, generic references, change records
--      (entity kinds only; change types unchanged, Q24), value history (Q23),
--      identity conflicts (interim data-quality kinds and entity kind),
--      extension targets (Q19).
--   4. canonical_model_versions: 0.4 -> supported, 0.5 current (ADR 0031);
--      canonical_modules: account_context available at 0.5 (disabled for every tenant).
--   5. Audit capability / action CHECKs widened to policy v6.
--   6. Forced RLS, tenant policy, tenant-id immutability and privileges
--      (SELECT / INSERT / UPDATE; no DELETE on any M10E table).
-- Additive only. No backfill: no context type, context, membership or line
-- assignment is invented; existing lines keep context_id NULL.

-- ---------------------------------------------------------------------------
-- Prisma-generated structure
-- ---------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "tenant_source_authority_versions" ADD COLUMN     "account_context_connection_id" UUID;

-- AlterTable
ALTER TABLE "tenant_subscriptions" ADD COLUMN     "context_id" UUID;

-- CreateTable
CREATE TABLE "tenant_account_contexts" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "context_type_registry_kind" TEXT NOT NULL DEFAULT 'context_type',
    "context_type_id" UUID NOT NULL,
    "natural_key_hash" TEXT NOT NULL,
    "dimensions" JSONB NOT NULL DEFAULT '{}',
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "owner_ref" TEXT,
    "renewal_date" DATE,
    "record_state" TEXT NOT NULL DEFAULT 'active',
    "merged_into_id" UUID,
    "last_change_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_account_contexts_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant_account_context_persons" (
    "tenant_id" UUID NOT NULL,
    "context_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "role_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "last_change_id" UUID,

    CONSTRAINT "tenant_account_context_persons_pkey" PRIMARY KEY ("tenant_id","context_id","person_id","role_code")
);

-- CreateTable
CREATE TABLE "tenant_account_context_products" (
    "tenant_id" UUID NOT NULL,
    "context_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_account_context_products_pkey" PRIMARY KEY ("tenant_id","context_id","product_key")
);

-- CreateIndex
CREATE INDEX "tenant_account_contexts_tenant_id_company_id_idx" ON "tenant_account_contexts"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "tenant_account_contexts_tenant_id_context_type_id_idx" ON "tenant_account_contexts"("tenant_id", "context_type_id");

-- CreateIndex
CREATE INDEX "tenant_account_contexts_tenant_id_company_id_context_type_i_idx" ON "tenant_account_contexts"("tenant_id", "company_id", "context_type_id", "natural_key_hash");

-- CreateIndex
CREATE INDEX "tenant_account_context_persons_tenant_id_person_id_idx" ON "tenant_account_context_persons"("tenant_id", "person_id");

-- CreateIndex
CREATE INDEX "tenant_account_context_products_tenant_id_product_key_idx" ON "tenant_account_context_products"("tenant_id", "product_key");

-- CreateIndex
CREATE INDEX "tenant_subscriptions_tenant_id_context_id_idx" ON "tenant_subscriptions"("tenant_id", "context_id");

-- AddForeignKey
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_context_id_fkey" FOREIGN KEY ("tenant_id", "context_id") REFERENCES "tenant_account_contexts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_authority_versions" ADD CONSTRAINT "tenant_source_authority_versions_tenant_id_account_context_fkey" FOREIGN KEY ("tenant_id", "account_context_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_account_contexts" ADD CONSTRAINT "tenant_account_contexts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_account_contexts" ADD CONSTRAINT "tenant_account_contexts_tenant_id_company_id_fkey" FOREIGN KEY ("tenant_id", "company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_account_contexts" ADD CONSTRAINT "tenant_account_contexts_tenant_id_context_type_registry_ki_fkey" FOREIGN KEY ("tenant_id", "context_type_registry_kind", "context_type_id") REFERENCES "tenant_registry_entries"("tenant_id", "kind", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_account_contexts" ADD CONSTRAINT "tenant_account_contexts_tenant_id_merged_into_id_fkey" FOREIGN KEY ("tenant_id", "merged_into_id") REFERENCES "tenant_account_contexts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_account_contexts" ADD CONSTRAINT "tenant_account_contexts_tenant_id_last_change_id_fkey" FOREIGN KEY ("tenant_id", "last_change_id") REFERENCES "tenant_context_changes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_account_context_persons" ADD CONSTRAINT "tenant_account_context_persons_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_account_context_persons" ADD CONSTRAINT "tenant_account_context_persons_tenant_id_context_id_fkey" FOREIGN KEY ("tenant_id", "context_id") REFERENCES "tenant_account_contexts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_account_context_persons" ADD CONSTRAINT "tenant_account_context_persons_tenant_id_person_id_fkey" FOREIGN KEY ("tenant_id", "person_id") REFERENCES "persons"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_account_context_persons" ADD CONSTRAINT "tenant_account_context_persons_tenant_id_last_change_id_fkey" FOREIGN KEY ("tenant_id", "last_change_id") REFERENCES "tenant_context_changes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_account_context_products" ADD CONSTRAINT "tenant_account_context_products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_account_context_products" ADD CONSTRAINT "tenant_account_context_products_tenant_id_context_id_fkey" FOREIGN KEY ("tenant_id", "context_id") REFERENCES "tenant_account_contexts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_account_context_products" ADD CONSTRAINT "tenant_account_context_products_tenant_id_product_key_fkey" FOREIGN KEY ("tenant_id", "product_key") REFERENCES "tenant_products"("tenant_id", "key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 2a. Account contexts (plan §3.1; Q3, Q4, Q6, Q12)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_account_contexts"
  ADD CONSTRAINT "tenant_account_contexts_type_registry_kind" CHECK ("context_type_registry_kind" = 'context_type'),
  ADD CONSTRAINT "tenant_account_contexts_natural_key_hash_format" CHECK ("natural_key_hash" ~ '^[0-9a-f]{64}$'),
  -- A flat object of at most 6 scalar (string / number / boolean) values, no secret-like key.
  ADD CONSTRAINT "tenant_account_contexts_dimensions_flat" CHECK (jsonb_typeof("dimensions") = 'object'
    AND jsonb_array_length(jsonb_path_query_array("dimensions", '$.keyvalue()')) <= 6
    AND NOT jsonb_path_exists("dimensions", '$.* ? (@.type() == "object" || @.type() == "array" || @.type() == "null")')
    AND octet_length("dimensions"::text) <= 4096
    AND NOT app_jsonb_has_secret_like_key("dimensions")),
  ADD CONSTRAINT "tenant_account_contexts_name_length" CHECK (char_length("name") BETWEEN 1 AND 200),
  ADD CONSTRAINT "tenant_account_contexts_status_valid" CHECK ("status" IN ('active', 'inactive', 'retired')),
  -- Q12: an opaque source owner id; an email-like value cannot match (no '@').
  ADD CONSTRAINT "tenant_account_contexts_owner_ref_format" CHECK ("owner_ref" IS NULL OR "owner_ref" ~ '^[A-Za-z0-9_.:-]{1,255}$'),
  ADD CONSTRAINT "tenant_account_contexts_record_state_valid" CHECK ("record_state" IN ('active', 'merged')),
  ADD CONSTRAINT "tenant_account_contexts_merged_target" CHECK (("record_state" = 'merged') = ("merged_into_id" IS NOT NULL)),
  ADD CONSTRAINT "tenant_account_contexts_not_merged_into_self" CHECK ("merged_into_id" IS NULL OR "merged_into_id" <> "id");

-- Type, dimensions and natural key never change (a different key is a different
-- context, R-C1); merged contexts are terminal; a new context needs an active
-- context type; at most one active context per (company, type, natural key),
-- serialised per key by an advisory lock (the M10C affiliation pattern: a partial
-- unique index cannot be expressed in the Prisma schema without drift).
CREATE FUNCTION "app_account_context_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.tenant_registry_entries e
                    WHERE e.tenant_id = NEW.tenant_id AND e.kind = NEW.context_type_registry_kind
                      AND e.id = NEW.context_type_id AND e.status = 'active') THEN
      RAISE EXCEPTION 'account_context_type_not_active' USING ERRCODE = 'check_violation',
        DETAIL = format('context type %s is not an active context type', NEW.context_type_id);
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.context_type_registry_kind IS DISTINCT FROM OLD.context_type_registry_kind
       OR NEW.context_type_id IS DISTINCT FROM OLD.context_type_id OR NEW.natural_key_hash IS DISTINCT FROM OLD.natural_key_hash
       OR NEW.dimensions IS DISTINCT FROM OLD.dimensions THEN
      RAISE EXCEPTION 'account_context_identity_immutable' USING ERRCODE = 'check_violation',
        DETAIL = format('account context %s', OLD.id);
    END IF;
    IF OLD.record_state = 'merged' AND (NEW.record_state IS DISTINCT FROM OLD.record_state
       OR NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
      RAISE EXCEPTION 'account_context_terminal' USING ERRCODE = 'check_violation',
        DETAIL = format('account context %s is merged', OLD.id);
    END IF;
    NEW.updated_at := CURRENT_TIMESTAMP;
  END IF;
  IF NEW.record_state = 'active' AND (TG_OP = 'INSERT' OR OLD.record_state <> 'active'
     OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
    -- The existence check must see the previous lock holder's commit (M10C review M1).
    IF current_setting('transaction_isolation') = 'repeatable read' THEN
      RAISE EXCEPTION 'account_context_isolation_unsupported' USING ERRCODE = 'feature_not_supported',
        DETAIL = 'an active account context needs READ COMMITTED or SERIALIZABLE';
    END IF;
    PERFORM pg_advisory_xact_lock(app_tenant_advisory_key(NEW.tenant_id, 'account-context',
      NEW.company_id::text || '|' || NEW.context_type_id::text || '|' || NEW.natural_key_hash));
    IF EXISTS (SELECT 1 FROM public.tenant_account_contexts c
                WHERE c.tenant_id = NEW.tenant_id AND c.company_id = NEW.company_id
                  AND c.context_type_id = NEW.context_type_id AND c.natural_key_hash = NEW.natural_key_hash
                  AND c.record_state = 'active' AND c.id <> NEW.id) THEN
      RAISE EXCEPTION 'account_context_natural_key_exists' USING ERRCODE = 'unique_violation',
        DETAIL = format('company %s already has an active context of type %s with this natural key',
                        NEW.company_id, NEW.context_type_id);
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_account_context_guard"() FROM PUBLIC;
CREATE TRIGGER "tenant_account_contexts_guard" BEFORE INSERT OR UPDATE ON "tenant_account_contexts"
  FOR EACH ROW EXECUTE FUNCTION app_account_context_guard();

-- Entity index (the M10A2 generic functions; kind account_context by id).
CREATE TRIGGER "tenant_account_contexts_entity_index_add" AFTER INSERT ON "tenant_account_contexts"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_add('account_context');
CREATE TRIGGER "tenant_account_contexts_entity_index_remove" BEFORE DELETE ON "tenant_account_contexts"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_remove('account_context');
CREATE TRIGGER "tenant_account_contexts_identity_immutable" BEFORE UPDATE OF "id" ON "tenant_account_contexts"
  FOR EACH ROW EXECUTE FUNCTION app_entity_identity_immutable('id');

-- ---------------------------------------------------------------------------
-- 2b. Person memberships (plan §3.2; Q9, Q10)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_account_context_persons"
  ADD CONSTRAINT "tenant_account_context_persons_role_format" CHECK ("role_code" ~ '^[a-z0-9_]{1,64}$'),
  ADD CONSTRAINT "tenant_account_context_persons_status_valid" CHECK ("status" IN ('active', 'ended')),
  ADD CONSTRAINT "tenant_account_context_persons_ended_at" CHECK (("status" = 'active') = ("ended_at" IS NULL)),
  ADD CONSTRAINT "tenant_account_context_persons_period" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

-- The (context, person, role) identity never changes.
CREATE FUNCTION "app_account_context_person_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.context_id IS DISTINCT FROM OLD.context_id OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.role_code IS DISTINCT FROM OLD.role_code THEN
    RAISE EXCEPTION 'account_context_member_identity_immutable' USING ERRCODE = 'check_violation',
      DETAIL = format('membership of person %s in context %s', OLD.person_id, OLD.context_id);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_account_context_person_guard"() FROM PUBLIC;
CREATE TRIGGER "tenant_account_context_persons_guard" BEFORE UPDATE ON "tenant_account_context_persons"
  FOR EACH ROW EXECUTE FUNCTION app_account_context_person_guard();

-- ---------------------------------------------------------------------------
-- 2c. Product memberships (plan §3.3; Q7)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_account_context_products"
  ADD CONSTRAINT "tenant_account_context_products_origin_valid" CHECK ("origin" IN ('dimension', 'explicit'));

CREATE FUNCTION "app_account_context_product_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.context_id IS DISTINCT FROM OLD.context_id OR NEW.product_key IS DISTINCT FROM OLD.product_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'account_context_product_identity_immutable' USING ERRCODE = 'check_violation',
      DETAIL = format('product %s in context %s', OLD.product_key, OLD.context_id);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_account_context_product_guard"() FROM PUBLIC;
CREATE TRIGGER "tenant_account_context_products_guard" BEFORE UPDATE ON "tenant_account_context_products"
  FOR EACH ROW EXECUTE FUNCTION app_account_context_product_guard();

-- ---------------------------------------------------------------------------
-- 2d. Line context (plan §3.4; Q8): same account; assignable only while the
-- context is active / inactive and not merged. Deferred to commit so a company
-- merge can re-point lines and contexts in either order inside one transaction.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "app_line_context_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  line_company uuid;
  line_context uuid;
  ctx record;
BEGIN
  IF TG_TABLE_NAME = 'tenant_account_contexts' THEN
    SELECT c.company_id INTO line_company FROM public.tenant_account_contexts c
     WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.id;
    IF EXISTS (SELECT 1 FROM public.tenant_subscriptions s
                WHERE s.tenant_id = NEW.tenant_id AND s.context_id = NEW.id
                  AND s.company_id IS DISTINCT FROM line_company) THEN
      RAISE EXCEPTION 'account_context_company_mismatch' USING ERRCODE = 'check_violation',
        DETAIL = format('account context %s has lines of another account', NEW.id);
    END IF;
    RETURN NULL;
  END IF;
  SELECT s.company_id, s.context_id INTO line_company, line_context FROM public.tenant_subscriptions s
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.id;
  IF line_context IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT c.company_id, c.status, c.record_state INTO ctx FROM public.tenant_account_contexts c
   WHERE c.tenant_id = NEW.tenant_id AND c.id = line_context;
  IF ctx.company_id IS DISTINCT FROM line_company THEN
    RAISE EXCEPTION 'account_context_company_mismatch' USING ERRCODE = 'check_violation',
      DETAIL = format('line %s and account context %s belong to different accounts', NEW.id, line_context);
  END IF;
  IF (TG_OP = 'INSERT' OR OLD.context_id IS DISTINCT FROM NEW.context_id)
     AND (ctx.status NOT IN ('active', 'inactive') OR ctx.record_state <> 'active') THEN
    RAISE EXCEPTION 'account_context_not_assignable' USING ERRCODE = 'check_violation',
      DETAIL = format('account context %s is %s / %s', line_context, ctx.status, ctx.record_state);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION "app_line_context_guard"() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "tenant_subscriptions_context_guard" AFTER INSERT OR UPDATE OF "context_id", "company_id" ON "tenant_subscriptions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_line_context_guard();
CREATE CONSTRAINT TRIGGER "tenant_account_contexts_line_guard" AFTER UPDATE OF "company_id" ON "tenant_account_contexts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_line_context_guard();

-- ---------------------------------------------------------------------------
-- 3. Kind CHECKs (plan §3.5)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_entity_index" DROP CONSTRAINT "tenant_entity_index_kind_valid";
ALTER TABLE "tenant_entity_index"
  ADD CONSTRAINT "tenant_entity_index_kind_valid" CHECK ("kind" IN ('company', 'person', 'product', 'subscription', 'person_affiliation', 'custom_record', 'account_context'));

ALTER TABLE "tenant_source_references" DROP CONSTRAINT "tenant_source_references_entity_kind_valid";
ALTER TABLE "tenant_source_references"
  ADD CONSTRAINT "tenant_source_references_entity_kind_valid" CHECK ("entity_kind" IN ('product', 'person_affiliation', 'custom_record', 'account_context'));

-- Q24: change types are catalogue-hashed and not widened.
ALTER TABLE "tenant_context_changes" DROP CONSTRAINT "tenant_context_changes_entity_kind_valid";
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'custom_relationship', 'account_context', 'account_context_person'));

-- Q23 / M10 §10: owner and status of a context, the line's context; ext:<key> on account contexts (Q19).
ALTER TABLE "tenant_value_history" DROP CONSTRAINT "tenant_value_history_field_valid";
ALTER TABLE "tenant_value_history"
  ADD CONSTRAINT "tenant_value_history_field_valid" CHECK (("entity_kind", "field") IN (('company', 'name'), ('company', 'parent_company_id'), ('subscription', 'state'), ('subscription', 'starts_at'), ('subscription', 'ends_at'), ('subscription', 'product_key'), ('subscription', 'quantity'), ('subscription', 'context_id'), ('person_affiliation', 'status'), ('person_affiliation', 'starts_at'), ('person_affiliation', 'ends_at'), ('person_affiliation', 'role_codes'), ('account_context', 'owner_ref'), ('account_context', 'status'))
    OR ("field" ~ '^ext:[a-z][a-z0-9_]{0,62}$' AND "entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context')));

-- Interim data-quality kinds (plan §3.5) until M10L.
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_kind_valid" CHECK ("kind" IN ('shared_email', 'merge_across_systems', 'ambiguous_primary_company', 'hierarchy_cycle_refused', 'hierarchy_depth_exceeded', 'hierarchy_parent_merged', 'hierarchy_parent_unresolved', 'hierarchy_human_override_disagrees', 'affiliation_endpoint_unresolved', 'extension_value_conflict', 'extension_human_override_disagrees', 'extension_reference_unresolved', 'custom_record_parent_unresolved', 'custom_relationship_endpoint_unresolved', 'account_context_merge_collision', 'account_context_company_mismatch', 'account_context_human_override_disagrees', 'account_context_reference_unresolved'));
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_entity_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context'));

-- Q19: account contexts are extension targets (values, reference values, relationship ends).
ALTER TABLE "tenant_extension_values" DROP CONSTRAINT "tenant_extension_values_target_kind_valid";
ALTER TABLE "tenant_extension_values"
  ADD CONSTRAINT "tenant_extension_values_target_kind_valid" CHECK ("target_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context'));
ALTER TABLE "tenant_extension_values" DROP CONSTRAINT "tenant_extension_values_ref_kind_valid";
ALTER TABLE "tenant_extension_values"
  ADD CONSTRAINT "tenant_extension_values_ref_kind_valid" CHECK ("value_ref_kind" IS NULL OR "value_ref_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context'));
ALTER TABLE "tenant_custom_relationships" DROP CONSTRAINT "tenant_custom_relationships_from_kind_valid";
ALTER TABLE "tenant_custom_relationships"
  ADD CONSTRAINT "tenant_custom_relationships_from_kind_valid" CHECK ("from_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context'));
ALTER TABLE "tenant_custom_relationships" DROP CONSTRAINT "tenant_custom_relationships_to_kind_valid";
ALTER TABLE "tenant_custom_relationships"
  ADD CONSTRAINT "tenant_custom_relationships_to_kind_valid" CHECK ("to_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context'));

-- ---------------------------------------------------------------------------
-- 4. Canonical version 0.5 and module account_context (plan §10; Q17, Q18)
-- ---------------------------------------------------------------------------
-- 0.4 moves to `supported` before 0.5 is inserted `current` (the one-current trigger).
ALTER TABLE "canonical_model_versions" NO FORCE ROW LEVEL SECURITY;
UPDATE "canonical_model_versions" SET "status" = 'supported' WHERE "version" = '0.4';
INSERT INTO "canonical_model_versions" ("version", "major", "minor", "status", "released_at", "catalogue_hash", "adr")
VALUES ('0.5', 0, 5, 'current', '2027-01-19 12:00:00+00', 'bfc152541c0788a1532d400e1dd0d23c450f228fa7509e5108966dee9e2b46e2', '0031');
ALTER TABLE "canonical_model_versions" FORCE ROW LEVEL SECURITY;

-- Available at 0.5; disabled for every tenant until an operator enables it.
ALTER TABLE "canonical_modules" NO FORCE ROW LEVEL SECURITY;
UPDATE "canonical_modules" SET "available" = true, "minimum_canonical_version" = '0.5' WHERE "module_key" = 'account_context';
ALTER TABLE "canonical_modules" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 5. Audit catalogues: policy v6 capability and the M10E actions (plan §15)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry', 'config.canonical.adopt', 'config.module.change', 'config.registry.publish', 'config.data_policy.publish', 'config.mapping.draft', 'config.mapping.retire', 'security.integrity.run', 'canonical.evidence.link', 'data.provenance.read', 'data.account_structure.read', 'data.extension.read', 'data.account_context.read')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied', 'canonical.adopt', 'module.enable', 'module.disable', 'module.configure', 'registry.publish', 'data_policy.publish', 'mapping.draft.save', 'mapping.draft.validate', 'mapping.draft.discard', 'mapping.retire', 'integrity.verify', 'provenance.read', 'evidence.link', 'source_reference.observe', 'account.hierarchy.set', 'account.hierarchy.clear', 'account.hierarchy.release', 'person.affiliation.add', 'person.affiliation.end', 'person.affiliation.release', 'account_structure.read', 'extension.value.set', 'extension.value.clear', 'extension.value.release', 'extension.record.create', 'extension.record.update', 'extension.record.retire', 'extension.record.reactivate', 'extension.relationship.add', 'extension.relationship.end', 'extension.read', 'account_context.write', 'account_context.retire', 'account_context.member.set', 'account_context.line.assign', 'account_context.release', 'account_context.read'));

-- ---------------------------------------------------------------------------
-- 6. Tenant isolation and privileges (plan §3, §13)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_account_contexts', 'tenant_account_context_persons',
                           'tenant_account_context_products'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF t <> 'tenant_account_contexts' THEN
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    END IF;
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change()',
      t || '_tenant_immutable', t);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM lip_app', t);
  END LOOP;
END
$$;

-- Contexts retire or merge, memberships end, product memberships stay: nothing disappears.
GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_account_contexts" TO lip_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_account_context_persons" TO lip_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_account_context_products" TO lip_app;
