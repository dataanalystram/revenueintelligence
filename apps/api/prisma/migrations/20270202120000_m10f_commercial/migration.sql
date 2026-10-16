-- Milestone 10F (ADR 0032): Commercial and canonical version 0.6
-- (plan docs/milestones/M10F-commercial-plan.md §3, §4, §11, §12, §16).
--   1. tenant_price_offers (entity kind price_offer), tenant_contracts (entity
--      kind contract; the three Contract -> Contract links renews / amends /
--      parent as composite self-FK columns, Q6), tenant_entitlements (entity
--      kind entitlement); tenant_subscriptions columns agreement_ref_system /
--      _object_type / _external_id (Core, all or none), contract_id,
--      price_offer_id, supersedes_line_id; tenant_source_authority_versions
--      price_offer / contract / entitlement connection columns (optional
--      authority facts, Q24). Every relation is a direct composite tenant FK (F2).
--   2. CHECKs (closed vocabularies, currency shape, period pair, money pair,
--      amounts >= 0, dates ordered, no self link), the price-offer guard
--      (product_key immutable once a line references the offer, Q10), the
--      acyclic contract graph over the union of the three link kinds and the
--      acyclic line lineage (walk ceiling 64, tenant advisory locks
--      contract-graph / line-lineage, REPEATABLE READ refused, Q7 / Q11), and the
--      deferred two-table guards: line <-> contract same account, line <-> offer
--      same product, contract links same account, line lineage same account,
--      contract <-> context same account (M10E D2 pattern). The deferred line /
--      context guards re-read the referenced row FOR SHARE, so a concurrent
--      change of the other end waits for this transaction (or is seen) instead of
--      slipping past; the contract-link and line-lineage account guards serialise
--      on the contract-graph / line-lineage advisory locks instead (no row lock,
--      no crossing deadlock).
--   3. Kind CHECKs widened: entity index, generic references, change records
--      (entity kinds only; change types unchanged, Q25), value history (plan §9),
--      identity conflicts (interim data-quality kinds and entity kinds),
--      extension targets (Q21).
--   4. canonical_model_versions: 0.5 -> supported, 0.6 current (ADR 0032);
--      canonical_modules: commercial available at 0.6 (disabled for every tenant).
--   5. Policy v8: audit capability / action CHECKs widened
--      (data.commercial.read, data.commercial.read_confidential; the
--      commercial.* actions) and the grantable capability CHECK of
--      tenant_capability_grants widened (data.commercial.read_confidential, Q22).
--   6. Forced RLS, tenant policy, tenant-id immutability and privileges
--      (SELECT / INSERT / UPDATE; no DELETE on any M10F table).
-- Additive only. No backfill: no price offer, contract, entitlement, link or
-- line reference is invented; existing lines keep NULLs.

-- ---------------------------------------------------------------------------
-- Prisma-generated structure
-- ---------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "tenant_source_authority_versions" ADD COLUMN     "contract_connection_id" UUID,
ADD COLUMN     "entitlement_connection_id" UUID,
ADD COLUMN     "price_offer_connection_id" UUID;

-- AlterTable
ALTER TABLE "tenant_subscriptions" ADD COLUMN     "agreement_ref_external_id" TEXT,
ADD COLUMN     "agreement_ref_object_type" TEXT,
ADD COLUMN     "agreement_ref_system" TEXT,
ADD COLUMN     "contract_id" UUID,
ADD COLUMN     "price_offer_id" UUID,
ADD COLUMN     "supersedes_line_id" UUID;

-- CreateTable
CREATE TABLE "tenant_price_offers" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_key" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "billing_period" INTEGER,
    "billing_period_unit" TEXT,
    "pricing_model" TEXT,
    "list_amount_minor" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "record_state" TEXT NOT NULL DEFAULT 'active',
    "last_change_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_price_offers_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant_contracts" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "context_id" UUID,
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "renewal_date" DATE,
    "auto_renew" BOOLEAN,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "total_value_minor" BIGINT,
    "total_value_currency" TEXT,
    "renews_contract_id" UUID,
    "amends_contract_id" UUID,
    "parent_contract_id" UUID,
    "record_state" TEXT NOT NULL DEFAULT 'active',
    "last_change_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_contracts_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "tenant_entitlements" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    "quantity" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "record_state" TEXT NOT NULL DEFAULT 'active',
    "last_change_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_entitlements_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE INDEX "tenant_subscriptions_tenant_id_contract_id_idx" ON "tenant_subscriptions"("tenant_id", "contract_id");

-- CreateIndex
CREATE INDEX "tenant_subscriptions_tenant_id_price_offer_id_idx" ON "tenant_subscriptions"("tenant_id", "price_offer_id");

-- CreateIndex
CREATE INDEX "tenant_subscriptions_tenant_id_supersedes_line_id_idx" ON "tenant_subscriptions"("tenant_id", "supersedes_line_id");

-- CreateIndex
CREATE INDEX "tenant_subscriptions_agreement_ref_idx" ON "tenant_subscriptions"("tenant_id", "agreement_ref_system", "agreement_ref_object_type", "agreement_ref_external_id");

-- CreateIndex
CREATE INDEX "tenant_price_offers_tenant_id_product_key_idx" ON "tenant_price_offers"("tenant_id", "product_key");

-- CreateIndex
CREATE INDEX "tenant_contracts_tenant_id_company_id_idx" ON "tenant_contracts"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "tenant_contracts_tenant_id_context_id_idx" ON "tenant_contracts"("tenant_id", "context_id");

-- CreateIndex
CREATE INDEX "tenant_contracts_tenant_id_renews_contract_id_idx" ON "tenant_contracts"("tenant_id", "renews_contract_id");

-- CreateIndex
CREATE INDEX "tenant_contracts_tenant_id_amends_contract_id_idx" ON "tenant_contracts"("tenant_id", "amends_contract_id");

-- CreateIndex
CREATE INDEX "tenant_contracts_tenant_id_parent_contract_id_idx" ON "tenant_contracts"("tenant_id", "parent_contract_id");

-- CreateIndex
CREATE INDEX "tenant_entitlements_tenant_id_company_id_idx" ON "tenant_entitlements"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "tenant_entitlements_tenant_id_product_key_idx" ON "tenant_entitlements"("tenant_id", "product_key");

-- AddForeignKey
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_agreement_ref_system_fkey" FOREIGN KEY ("agreement_ref_system") REFERENCES "connector_kinds"("kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_contract_id_fkey" FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "tenant_contracts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_price_offer_id_fkey" FOREIGN KEY ("tenant_id", "price_offer_id") REFERENCES "tenant_price_offers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_supersedes_line_id_fkey" FOREIGN KEY ("tenant_id", "supersedes_line_id") REFERENCES "tenant_subscriptions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_authority_versions" ADD CONSTRAINT "tenant_source_authority_versions_tenant_id_price_offer_fkey" FOREIGN KEY ("tenant_id", "price_offer_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_authority_versions" ADD CONSTRAINT "tenant_source_authority_versions_tenant_id_contract_fkey" FOREIGN KEY ("tenant_id", "contract_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_source_authority_versions" ADD CONSTRAINT "tenant_source_authority_versions_tenant_id_entitlement_fkey" FOREIGN KEY ("tenant_id", "entitlement_connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_price_offers" ADD CONSTRAINT "tenant_price_offers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_price_offers" ADD CONSTRAINT "tenant_price_offers_tenant_id_product_key_fkey" FOREIGN KEY ("tenant_id", "product_key") REFERENCES "tenant_products"("tenant_id", "key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_price_offers" ADD CONSTRAINT "tenant_price_offers_tenant_id_last_change_id_fkey" FOREIGN KEY ("tenant_id", "last_change_id") REFERENCES "tenant_context_changes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_contracts" ADD CONSTRAINT "tenant_contracts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_contracts" ADD CONSTRAINT "tenant_contracts_tenant_id_company_id_fkey" FOREIGN KEY ("tenant_id", "company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_contracts" ADD CONSTRAINT "tenant_contracts_tenant_id_context_id_fkey" FOREIGN KEY ("tenant_id", "context_id") REFERENCES "tenant_account_contexts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_contracts" ADD CONSTRAINT "tenant_contracts_tenant_id_renews_contract_id_fkey" FOREIGN KEY ("tenant_id", "renews_contract_id") REFERENCES "tenant_contracts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_contracts" ADD CONSTRAINT "tenant_contracts_tenant_id_amends_contract_id_fkey" FOREIGN KEY ("tenant_id", "amends_contract_id") REFERENCES "tenant_contracts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_contracts" ADD CONSTRAINT "tenant_contracts_tenant_id_parent_contract_id_fkey" FOREIGN KEY ("tenant_id", "parent_contract_id") REFERENCES "tenant_contracts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_contracts" ADD CONSTRAINT "tenant_contracts_tenant_id_last_change_id_fkey" FOREIGN KEY ("tenant_id", "last_change_id") REFERENCES "tenant_context_changes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_tenant_id_company_id_fkey" FOREIGN KEY ("tenant_id", "company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_tenant_id_product_key_fkey" FOREIGN KEY ("tenant_id", "product_key") REFERENCES "tenant_products"("tenant_id", "key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_entitlements" ADD CONSTRAINT "tenant_entitlements_tenant_id_last_change_id_fkey" FOREIGN KEY ("tenant_id", "last_change_id") REFERENCES "tenant_context_changes"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 2a. Price offers (plan §3.1; Q5, Q8, Q10)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_price_offers"
  -- ISO 4217 shape, not a list (no currency is seeded).
  ADD CONSTRAINT "tenant_price_offers_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "tenant_price_offers_billing_period_positive" CHECK ("billing_period" IS NULL OR "billing_period" > 0),
  ADD CONSTRAINT "tenant_price_offers_billing_period_unit_valid" CHECK ("billing_period_unit" IS NULL OR "billing_period_unit" IN ('day', 'week', 'month', 'year')),
  ADD CONSTRAINT "tenant_price_offers_billing_period_pair" CHECK (("billing_period" IS NULL) = ("billing_period_unit" IS NULL)),
  ADD CONSTRAINT "tenant_price_offers_pricing_model_valid" CHECK ("pricing_model" IS NULL OR "pricing_model" IN ('flat', 'per_unit', 'tiered', 'volume', 'usage')),
  ADD CONSTRAINT "tenant_price_offers_list_amount_non_negative" CHECK ("list_amount_minor" IS NULL OR "list_amount_minor" >= 0),
  ADD CONSTRAINT "tenant_price_offers_status_valid" CHECK ("status" IN ('active', 'retired')),
  ADD CONSTRAINT "tenant_price_offers_record_state_valid" CHECK ("record_state" IN ('active'));

-- Q10: an offer's product never changes once a line references it (a line's
-- product and its offer's product must match; the deferred guard below holds
-- the pair, this refuses the change early with its own code).
CREATE FUNCTION "app_price_offer_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.product_key IS DISTINCT FROM OLD.product_key
     AND EXISTS (SELECT 1 FROM public.tenant_subscriptions s
                  WHERE s.tenant_id = OLD.tenant_id AND s.price_offer_id = OLD.id) THEN
    RAISE EXCEPTION 'price_offer_product_referenced' USING ERRCODE = 'check_violation',
      DETAIL = format('price offer %s is referenced by subscription lines', OLD.id);
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_price_offer_guard"() FROM PUBLIC;
CREATE TRIGGER "tenant_price_offers_guard" BEFORE UPDATE ON "tenant_price_offers"
  FOR EACH ROW EXECUTE FUNCTION app_price_offer_guard();

-- ---------------------------------------------------------------------------
-- 2b. Contracts (plan §3.2; Q6, Q7, Q12, Q13, Q14)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_contracts"
  ADD CONSTRAINT "tenant_contracts_status_valid" CHECK ("status" IN ('draft', 'active', 'expired', 'terminated', 'unknown')),
  ADD CONSTRAINT "tenant_contracts_record_state_valid" CHECK ("record_state" IN ('active')),
  ADD CONSTRAINT "tenant_contracts_period" CHECK ("ends_at" IS NULL OR "starts_at" IS NULL OR "ends_at" >= "starts_at"),
  -- Money pair: an amount always carries its currency (and only then).
  ADD CONSTRAINT "tenant_contracts_total_value_pair" CHECK (("total_value_minor" IS NULL) = ("total_value_currency" IS NULL)),
  ADD CONSTRAINT "tenant_contracts_total_value_non_negative" CHECK ("total_value_minor" IS NULL OR "total_value_minor" >= 0),
  ADD CONSTRAINT "tenant_contracts_total_value_currency_format" CHECK ("total_value_currency" IS NULL OR "total_value_currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "tenant_contracts_not_renews_self" CHECK ("renews_contract_id" IS NULL OR "renews_contract_id" <> "id"),
  ADD CONSTRAINT "tenant_contracts_not_amends_self" CHECK ("amends_contract_id" IS NULL OR "amends_contract_id" <> "id"),
  ADD CONSTRAINT "tenant_contracts_not_parent_self" CHECK ("parent_contract_id" IS NULL OR "parent_contract_id" <> "id");

-- Keeps updated_at on every update of a commercial row (contracts, entitlements).
CREATE FUNCTION "app_commercial_touch"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_commercial_touch"() FROM PUBLIC;
CREATE TRIGGER "tenant_contracts_touch" BEFORE UPDATE ON "tenant_contracts"
  FOR EACH ROW EXECUTE FUNCTION app_commercial_touch();

-- Q7: the contract graph is acyclic over the UNION of renews / amends / parent.
-- SECURITY INVOKER (same-tenant rows only, every step carries the tenant
-- predicate; forced RLS applies to the app role). Every link change of a
-- tenant, raw SQL included, is serialised by the advisory lock
-- ('contract-graph', tenant), so two crossing link writes (A renews B, B
-- renews A) cannot both pass the walk. REPEATABLE READ is refused: its snapshot
-- predates the previous lock holder's commit (M10C review M1). A self link is
-- left to the named CHECKs. Walk ceiling 64 levels (fail closed).
CREATE FUNCTION "app_contract_graph_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  frontier uuid[];
  visited uuid[];
  nxt uuid[];
  steps integer := 0;
  k integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.renews_contract_id IS NOT DISTINCT FROM OLD.renews_contract_id
     AND NEW.amends_contract_id IS NOT DISTINCT FROM OLD.amends_contract_id
     AND NEW.parent_contract_id IS NOT DISTINCT FROM OLD.parent_contract_id THEN
    RETURN NEW;
  END IF;
  frontier := ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[NEW.renews_contract_id, NEW.amends_contract_id,
                                                         NEW.parent_contract_id]) AS x
                     WHERE x IS NOT NULL AND x <> NEW.id);
  IF cardinality(frontier) = 0 THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'contract_graph_isolation_unsupported' USING ERRCODE = 'feature_not_supported',
      DETAIL = 'linking contracts needs READ COMMITTED or SERIALIZABLE';
  END IF;
  PERFORM pg_advisory_xact_lock(app_tenant_advisory_key(NEW.tenant_id, 'contract-graph', 'tenant'));
  -- MUTATION VM7: cycles checked per link kind instead of the union
  FOR k IN 1..3 LOOP
  frontier := ARRAY(SELECT x FROM unnest(ARRAY[(ARRAY[NEW.renews_contract_id, NEW.amends_contract_id,
                                                      NEW.parent_contract_id])[k]]) AS x
                     WHERE x IS NOT NULL AND x <> NEW.id);
  visited := frontier;
  steps := 0;
  WHILE cardinality(frontier) > 0 LOOP
    IF NEW.id = ANY(frontier) THEN
      RAISE EXCEPTION 'contract_link_cycle' USING ERRCODE = 'check_violation',
        DETAIL = format('a link of contract %s reaches it again', NEW.id);
    END IF;
    steps := steps + 1;
    IF steps > 64 THEN
      RAISE EXCEPTION 'contract_link_ceiling' USING ERRCODE = 'check_violation',
        DETAIL = format('the links of contract %s go deeper than 64 levels', NEW.id);
    END IF;
    nxt := ARRAY(SELECT DISTINCT z.n FROM public.tenant_contracts c
                  CROSS JOIN LATERAL (SELECT (ARRAY[c.renews_contract_id, c.amends_contract_id,
                                                  c.parent_contract_id])[k] AS n) z
                  WHERE c.tenant_id = NEW.tenant_id AND c.id = ANY(frontier)
                    AND z.n IS NOT NULL AND NOT (z.n = ANY(visited)));
    visited := visited || nxt;
    frontier := nxt;
  END LOOP;
  END LOOP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_contract_graph_guard"() FROM PUBLIC;
CREATE TRIGGER "tenant_contracts_graph_guard" BEFORE INSERT OR UPDATE OF "renews_contract_id", "amends_contract_id", "parent_contract_id" ON "tenant_contracts"
  FOR EACH ROW EXECUTE FUNCTION app_contract_graph_guard();

-- Q12: a contract and every contract it links to (and every contract linking to
-- it) belong to the same account. Deferred to commit so a company merge can
-- re-point every contract of the merged account in one transaction; fires on
-- both ends (an incoming link is checked when the target moves). The current
-- row is re-read (a deferred event may carry an intermediate version). A check
-- that has anything to compare runs under the same tenant advisory lock as the
-- graph guard ('contract-graph'), so a link write and an account move of either
-- end are serialised and the later one reads the earlier one's commit (READ
-- COMMITTED; REPEATABLE READ refused) — with no row lock on the other end, so a
-- crossing pair of writes cannot deadlock.
CREATE FUNCTION "app_contract_link_account_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  me record;
  other uuid;
BEGIN
  SELECT c.company_id, c.renews_contract_id, c.amends_contract_id, c.parent_contract_id INTO me
    FROM public.tenant_contracts c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF num_nonnulls(me.renews_contract_id, me.amends_contract_id, me.parent_contract_id) = 0
     AND (TG_OP = 'INSERT' OR OLD.company_id IS NOT DISTINCT FROM NEW.company_id) THEN
    RETURN NULL;
  END IF;
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'contract_graph_isolation_unsupported' USING ERRCODE = 'feature_not_supported',
      DETAIL = 'linking or moving linked contracts needs READ COMMITTED or SERIALIZABLE';
  END IF;
  PERFORM pg_advisory_xact_lock(app_tenant_advisory_key(NEW.tenant_id, 'contract-graph', 'tenant'));
  SELECT t.id INTO other FROM public.tenant_contracts t
   WHERE t.tenant_id = NEW.tenant_id
     AND t.id IN (me.renews_contract_id, me.amends_contract_id, me.parent_contract_id)
     AND t.company_id IS DISTINCT FROM me.company_id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'contract_link_cross_account' USING ERRCODE = 'check_violation',
      DETAIL = format('contract %s links to contract %s of another account', NEW.id, other);
  END IF;
  SELECT s.id INTO other FROM public.tenant_contracts s
   WHERE s.tenant_id = NEW.tenant_id
     AND (s.renews_contract_id = NEW.id OR s.amends_contract_id = NEW.id OR s.parent_contract_id = NEW.id)
     AND s.company_id IS DISTINCT FROM me.company_id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'contract_link_cross_account' USING ERRCODE = 'check_violation',
      DETAIL = format('contract %s of another account links to contract %s', other, NEW.id);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION "app_contract_link_account_guard"() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "tenant_contracts_link_account_guard" AFTER INSERT OR UPDATE OF "company_id", "renews_contract_id", "amends_contract_id", "parent_contract_id" ON "tenant_contracts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_contract_link_account_guard();

-- Q13 (M10E D2 pattern): a contract's account context belongs to the contract's
-- account; checked from both tables at commit.
CREATE FUNCTION "app_contract_context_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  contract_company uuid;
  contract_context uuid;
  ctx_company uuid;
  other uuid;
BEGIN
  IF TG_TABLE_NAME = 'tenant_account_contexts' THEN
    SELECT c.company_id INTO ctx_company FROM public.tenant_account_contexts c
     WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.id;
    SELECT k.id INTO other FROM public.tenant_contracts k
     WHERE k.tenant_id = NEW.tenant_id AND k.context_id = NEW.id
       AND k.company_id IS DISTINCT FROM ctx_company
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'contract_context_company_mismatch' USING ERRCODE = 'check_violation',
        DETAIL = format('account context %s has contract %s of another account', NEW.id, other);
    END IF;
    RETURN NULL;
  END IF;
  SELECT k.company_id, k.context_id INTO contract_company, contract_context FROM public.tenant_contracts k
   WHERE k.tenant_id = NEW.tenant_id AND k.id = NEW.id;
  IF contract_context IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT c.company_id INTO ctx_company FROM public.tenant_account_contexts c
   WHERE c.tenant_id = NEW.tenant_id AND c.id = contract_context FOR SHARE;
  IF ctx_company IS DISTINCT FROM contract_company THEN
    RAISE EXCEPTION 'contract_context_company_mismatch' USING ERRCODE = 'check_violation',
      DETAIL = format('contract %s and account context %s belong to different accounts', NEW.id, contract_context);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION "app_contract_context_guard"() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "tenant_contracts_context_guard" AFTER INSERT OR UPDATE OF "context_id", "company_id" ON "tenant_contracts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_contract_context_guard();
CREATE CONSTRAINT TRIGGER "tenant_account_contexts_contract_guard" AFTER UPDATE OF "company_id" ON "tenant_account_contexts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_contract_context_guard();

-- ---------------------------------------------------------------------------
-- 2c. Entitlements (plan §3.3; Q15) — informational only
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_entitlements"
  ADD CONSTRAINT "tenant_entitlements_quantity_non_negative" CHECK ("quantity" IS NULL OR "quantity" >= 0),
  ADD CONSTRAINT "tenant_entitlements_status_valid" CHECK ("status" IN ('active', 'inactive', 'expired', 'unknown')),
  ADD CONSTRAINT "tenant_entitlements_period" CHECK ("ends_at" IS NULL OR "starts_at" IS NULL OR "ends_at" >= "starts_at"),
  ADD CONSTRAINT "tenant_entitlements_record_state_valid" CHECK ("record_state" IN ('active'));
CREATE TRIGGER "tenant_entitlements_touch" BEFORE UPDATE ON "tenant_entitlements"
  FOR EACH ROW EXECUTE FUNCTION app_commercial_touch();

-- ---------------------------------------------------------------------------
-- 2d. Line commercial references (plan §3.4; Q2, Q10, Q11)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_subscriptions"
  -- E3 §4.1: an attribute, never an identity; all three or none; bounded like the line source columns.
  ADD CONSTRAINT "tenant_subscriptions_agreement_ref_all_or_none" CHECK (num_nonnulls("agreement_ref_system", "agreement_ref_object_type", "agreement_ref_external_id") IN (0, 3)),
  ADD CONSTRAINT "tenant_subscriptions_agreement_ref_format" CHECK (("agreement_ref_object_type" IS NULL OR "agreement_ref_object_type" ~ '^[A-Za-z0-9_]{1,100}$')
    AND ("agreement_ref_external_id" IS NULL OR "agreement_ref_external_id" ~ '^[A-Za-z0-9_.:-]{1,255}$')),
  ADD CONSTRAINT "tenant_subscriptions_not_superseding_self" CHECK ("supersedes_line_id" IS NULL OR "supersedes_line_id" <> "id");

-- Line <-> contract: same account (M10E D2 pattern), from both tables at commit.
CREATE FUNCTION "app_line_contract_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  line_company uuid;
  line_contract uuid;
  contract_company uuid;
  other uuid;
BEGIN
  IF TG_TABLE_NAME = 'tenant_contracts' THEN
    SELECT k.company_id INTO contract_company FROM public.tenant_contracts k
     WHERE k.tenant_id = NEW.tenant_id AND k.id = NEW.id;
    SELECT s.id INTO other FROM public.tenant_subscriptions s
     WHERE s.tenant_id = NEW.tenant_id AND s.contract_id = NEW.id
       AND s.company_id IS DISTINCT FROM contract_company
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'line_contract_company_mismatch' USING ERRCODE = 'check_violation',
        DETAIL = format('contract %s has line %s of another account', NEW.id, other);
    END IF;
    RETURN NULL;
  END IF;
  SELECT s.company_id, s.contract_id INTO line_company, line_contract FROM public.tenant_subscriptions s
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.id;
  IF line_contract IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT k.company_id INTO contract_company FROM public.tenant_contracts k
   WHERE k.tenant_id = NEW.tenant_id AND k.id = line_contract FOR SHARE;
  IF contract_company IS DISTINCT FROM line_company THEN
    RAISE EXCEPTION 'line_contract_company_mismatch' USING ERRCODE = 'check_violation',
      DETAIL = format('line %s and contract %s belong to different accounts', NEW.id, line_contract);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION "app_line_contract_guard"() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "tenant_subscriptions_contract_guard" AFTER INSERT OR UPDATE OF "contract_id", "company_id" ON "tenant_subscriptions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_line_contract_guard();
CREATE CONSTRAINT TRIGGER "tenant_contracts_line_guard" AFTER UPDATE OF "company_id" ON "tenant_contracts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_line_contract_guard();

-- Line <-> price offer: same product (Q10), from both tables at commit.
CREATE FUNCTION "app_line_price_offer_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  line_product text;
  line_offer uuid;
  offer_product text;
  other uuid;
BEGIN
  IF TG_TABLE_NAME = 'tenant_price_offers' THEN
    SELECT o.product_key INTO offer_product FROM public.tenant_price_offers o
     WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.id;
    SELECT s.id INTO other FROM public.tenant_subscriptions s
     WHERE s.tenant_id = NEW.tenant_id AND s.price_offer_id = NEW.id
       AND s.product_key IS DISTINCT FROM offer_product
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'line_price_offer_product_mismatch' USING ERRCODE = 'check_violation',
        DETAIL = format('price offer %s has line %s of another product', NEW.id, other);
    END IF;
    RETURN NULL;
  END IF;
  SELECT s.product_key, s.price_offer_id INTO line_product, line_offer FROM public.tenant_subscriptions s
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.id;
  IF line_offer IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT o.product_key INTO offer_product FROM public.tenant_price_offers o
   WHERE o.tenant_id = NEW.tenant_id AND o.id = line_offer FOR SHARE;
  IF offer_product IS DISTINCT FROM line_product THEN
    RAISE EXCEPTION 'line_price_offer_product_mismatch' USING ERRCODE = 'check_violation',
      DETAIL = format('line %s and price offer %s are of different products', NEW.id, line_offer);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION "app_line_price_offer_guard"() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "tenant_subscriptions_price_offer_guard" AFTER INSERT OR UPDATE OF "price_offer_id", "product_key" ON "tenant_subscriptions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_line_price_offer_guard();
CREATE CONSTRAINT TRIGGER "tenant_price_offers_line_guard" AFTER UPDATE OF "product_key" ON "tenant_price_offers"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_line_price_offer_guard();

-- Q11: line lineage is acyclic (a line supersedes at most one line, structural),
-- serialised per tenant by the advisory lock ('line-lineage', tenant) — taken
-- after 'contract-graph' when a transaction needs both (lock order, Q16).
-- REPEATABLE READ refused; walk ceiling 64; a self reference is left to the CHECK.
CREATE FUNCTION "app_line_lineage_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  cur uuid;
  steps integer := 0;
BEGIN
  IF NEW.supersedes_line_id IS NULL OR NEW.supersedes_line_id = NEW.id THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.supersedes_line_id IS NOT DISTINCT FROM OLD.supersedes_line_id THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'line_lineage_isolation_unsupported' USING ERRCODE = 'feature_not_supported',
      DETAIL = 'setting a line predecessor needs READ COMMITTED or SERIALIZABLE';
  END IF;
  PERFORM pg_advisory_xact_lock(app_tenant_advisory_key(NEW.tenant_id, 'line-lineage', 'tenant'));
  cur := NEW.supersedes_line_id;
  LOOP
    IF cur = NEW.id THEN
      RAISE EXCEPTION 'line_lineage_cycle' USING ERRCODE = 'check_violation',
        DETAIL = format('predecessor %s of line %s descends from it', NEW.supersedes_line_id, NEW.id);
    END IF;
    steps := steps + 1;
    IF steps > 64 THEN
      RAISE EXCEPTION 'line_lineage_ceiling' USING ERRCODE = 'check_violation',
        DETAIL = format('no first line within 64 predecessors of line %s', NEW.id);
    END IF;
    SELECT s.supersedes_line_id INTO cur FROM public.tenant_subscriptions s
     WHERE s.tenant_id = NEW.tenant_id AND s.id = cur;
    EXIT WHEN cur IS NULL;
  END LOOP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_line_lineage_guard"() FROM PUBLIC;
CREATE TRIGGER "tenant_subscriptions_lineage_guard" BEFORE INSERT OR UPDATE OF "supersedes_line_id" ON "tenant_subscriptions"
  FOR EACH ROW EXECUTE FUNCTION app_line_lineage_guard();

-- Line lineage: a line and its predecessor (and every line superseding it)
-- belong to the same account; deferred so a company merge re-points lines in
-- any order inside one transaction. Serialised on ('line-lineage', tenant)
-- like the contract-link account guard (phase 2a: a FOR SHARE re-read of the
-- predecessor deadlocked against a crossing predecessor write).
CREATE FUNCTION "app_line_lineage_account_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  me record;
  other uuid;
  pred_company uuid;
BEGIN
  SELECT s.company_id, s.supersedes_line_id INTO me FROM public.tenant_subscriptions s
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF me.supersedes_line_id IS NULL
     AND NOT (TG_OP = 'UPDATE' AND OLD.company_id IS DISTINCT FROM NEW.company_id) THEN
    RETURN NULL;
  END IF;
  -- Serialised on the line-lineage advisory lock (no row lock on the other
  -- end): a crossing pair of predecessor writes cannot deadlock here (the
  -- lineage BEFORE trigger waits on this lock while holding its own row).
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'line_lineage_isolation_unsupported' USING ERRCODE = 'feature_not_supported',
      DETAIL = 'setting a line predecessor needs READ COMMITTED or SERIALIZABLE';
  END IF;
  PERFORM pg_advisory_xact_lock(app_tenant_advisory_key(NEW.tenant_id, 'line-lineage', 'tenant'));
  IF me.supersedes_line_id IS NOT NULL THEN
    SELECT p.company_id INTO pred_company FROM public.tenant_subscriptions p
     WHERE p.tenant_id = NEW.tenant_id AND p.id = me.supersedes_line_id;
    IF pred_company IS DISTINCT FROM me.company_id THEN
      RAISE EXCEPTION 'line_lineage_cross_account' USING ERRCODE = 'check_violation',
        DETAIL = format('line %s supersedes line %s of another account', NEW.id, me.supersedes_line_id);
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.company_id IS DISTINCT FROM NEW.company_id THEN
    SELECT n.id INTO other FROM public.tenant_subscriptions n
     WHERE n.tenant_id = NEW.tenant_id AND n.supersedes_line_id = NEW.id
       AND n.company_id IS DISTINCT FROM me.company_id
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'line_lineage_cross_account' USING ERRCODE = 'check_violation',
        DETAIL = format('line %s of another account supersedes line %s', other, NEW.id);
    END IF;
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION "app_line_lineage_account_guard"() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER "tenant_subscriptions_lineage_account_guard" AFTER INSERT OR UPDATE OF "supersedes_line_id", "company_id" ON "tenant_subscriptions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_line_lineage_account_guard();

-- Entity index (the M10A2 generic functions; kinds by id).
CREATE TRIGGER "tenant_price_offers_entity_index_add" AFTER INSERT ON "tenant_price_offers"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_add('price_offer');
CREATE TRIGGER "tenant_price_offers_entity_index_remove" BEFORE DELETE ON "tenant_price_offers"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_remove('price_offer');
CREATE TRIGGER "tenant_price_offers_identity_immutable" BEFORE UPDATE OF "id" ON "tenant_price_offers"
  FOR EACH ROW EXECUTE FUNCTION app_entity_identity_immutable('id');
CREATE TRIGGER "tenant_contracts_entity_index_add" AFTER INSERT ON "tenant_contracts"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_add('contract');
CREATE TRIGGER "tenant_contracts_entity_index_remove" BEFORE DELETE ON "tenant_contracts"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_remove('contract');
CREATE TRIGGER "tenant_contracts_identity_immutable" BEFORE UPDATE OF "id" ON "tenant_contracts"
  FOR EACH ROW EXECUTE FUNCTION app_entity_identity_immutable('id');
CREATE TRIGGER "tenant_entitlements_entity_index_add" AFTER INSERT ON "tenant_entitlements"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_add('entitlement');
CREATE TRIGGER "tenant_entitlements_entity_index_remove" BEFORE DELETE ON "tenant_entitlements"
  FOR EACH ROW EXECUTE FUNCTION app_entity_index_remove('entitlement');
CREATE TRIGGER "tenant_entitlements_identity_immutable" BEFORE UPDATE OF "id" ON "tenant_entitlements"
  FOR EACH ROW EXECUTE FUNCTION app_entity_identity_immutable('id');

-- ---------------------------------------------------------------------------
-- 3. Kind CHECKs (plan §3.5)
-- ---------------------------------------------------------------------------
-- Q25: change types are catalogue-hashed and not widened; plan §9: value-history
-- fields; Q21: commercial entities are extension targets.
ALTER TABLE "tenant_entity_index" DROP CONSTRAINT "tenant_entity_index_kind_valid";
ALTER TABLE "tenant_entity_index"
  ADD CONSTRAINT "tenant_entity_index_kind_valid" CHECK ("kind" IN ('company', 'person', 'product', 'subscription', 'person_affiliation', 'custom_record', 'account_context', 'price_offer', 'contract', 'entitlement'));
ALTER TABLE "tenant_source_references" DROP CONSTRAINT "tenant_source_references_entity_kind_valid";
ALTER TABLE "tenant_source_references"
  ADD CONSTRAINT "tenant_source_references_entity_kind_valid" CHECK ("entity_kind" IN ('product', 'person_affiliation', 'custom_record', 'account_context', 'price_offer', 'contract', 'entitlement'));
ALTER TABLE "tenant_context_changes" DROP CONSTRAINT "tenant_context_changes_entity_kind_valid";
ALTER TABLE "tenant_context_changes"
  ADD CONSTRAINT "tenant_context_changes_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'custom_relationship', 'account_context', 'account_context_person', 'price_offer', 'contract', 'entitlement'));
ALTER TABLE "tenant_value_history" DROP CONSTRAINT "tenant_value_history_field_valid";
ALTER TABLE "tenant_value_history"
  ADD CONSTRAINT "tenant_value_history_field_valid" CHECK (("entity_kind", "field") IN (('company', 'name'), ('company', 'parent_company_id'), ('subscription', 'state'), ('subscription', 'starts_at'), ('subscription', 'ends_at'), ('subscription', 'product_key'), ('subscription', 'quantity'), ('subscription', 'context_id'), ('person_affiliation', 'status'), ('person_affiliation', 'starts_at'), ('person_affiliation', 'ends_at'), ('person_affiliation', 'role_codes'), ('account_context', 'owner_ref'), ('account_context', 'status'), ('subscription', 'contract_id'), ('subscription', 'price_offer_id'), ('contract', 'status'), ('contract', 'starts_at'), ('contract', 'ends_at'), ('contract', 'renewal_date'), ('price_offer', 'status'), ('price_offer', 'list_amount_minor'), ('entitlement', 'status'), ('entitlement', 'starts_at'), ('entitlement', 'ends_at'))
    OR ("field" ~ '^ext:[a-z][a-z0-9_]{0,62}$' AND "entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context', 'price_offer', 'contract', 'entitlement')));
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_kind_valid" CHECK ("kind" IN ('shared_email', 'merge_across_systems', 'ambiguous_primary_company', 'hierarchy_cycle_refused', 'hierarchy_depth_exceeded', 'hierarchy_parent_merged', 'hierarchy_parent_unresolved', 'hierarchy_human_override_disagrees', 'affiliation_endpoint_unresolved', 'extension_value_conflict', 'extension_human_override_disagrees', 'extension_reference_unresolved', 'custom_record_parent_unresolved', 'custom_relationship_endpoint_unresolved', 'account_context_merge_collision', 'account_context_company_mismatch', 'account_context_human_override_disagrees', 'account_context_reference_unresolved', 'contract_reference_unresolved', 'price_offer_reference_unresolved', 'contract_company_mismatch', 'price_offer_product_mismatch', 'contract_link_cycle_refused', 'contract_link_cross_account', 'contract_duplicate_source', 'commercial_human_override_disagrees'));
ALTER TABLE "tenant_identity_conflicts" DROP CONSTRAINT "tenant_identity_conflicts_entity_kind_valid";
ALTER TABLE "tenant_identity_conflicts"
  ADD CONSTRAINT "tenant_identity_conflicts_entity_kind_valid" CHECK ("entity_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context', 'price_offer', 'contract', 'entitlement'));
ALTER TABLE "tenant_extension_values" DROP CONSTRAINT "tenant_extension_values_target_kind_valid";
ALTER TABLE "tenant_extension_values"
  ADD CONSTRAINT "tenant_extension_values_target_kind_valid" CHECK ("target_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context', 'price_offer', 'contract', 'entitlement'));
ALTER TABLE "tenant_extension_values" DROP CONSTRAINT "tenant_extension_values_ref_kind_valid";
ALTER TABLE "tenant_extension_values"
  ADD CONSTRAINT "tenant_extension_values_ref_kind_valid" CHECK ("value_ref_kind" IS NULL OR "value_ref_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context', 'price_offer', 'contract', 'entitlement'));
ALTER TABLE "tenant_custom_relationships" DROP CONSTRAINT "tenant_custom_relationships_from_kind_valid";
ALTER TABLE "tenant_custom_relationships"
  ADD CONSTRAINT "tenant_custom_relationships_from_kind_valid" CHECK ("from_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context', 'price_offer', 'contract', 'entitlement'));
ALTER TABLE "tenant_custom_relationships" DROP CONSTRAINT "tenant_custom_relationships_to_kind_valid";
ALTER TABLE "tenant_custom_relationships"
  ADD CONSTRAINT "tenant_custom_relationships_to_kind_valid" CHECK ("to_kind" IN ('company', 'person', 'subscription', 'product', 'person_affiliation', 'custom_record', 'account_context', 'price_offer', 'contract', 'entitlement'));

-- ---------------------------------------------------------------------------
-- 4. Canonical version 0.6 and module commercial (plan §11; Q19, Q20)
-- ---------------------------------------------------------------------------
-- 0.5 moves to `supported` before 0.6 is inserted `current` (the one-current trigger).
ALTER TABLE "canonical_model_versions" NO FORCE ROW LEVEL SECURITY;
UPDATE "canonical_model_versions" SET "status" = 'supported' WHERE "version" = '0.5';
INSERT INTO "canonical_model_versions" ("version", "major", "minor", "status", "released_at", "catalogue_hash", "adr")
VALUES ('0.6', 0, 6, 'current', '2027-02-02 12:00:00+00', 'c266c16c0e42c3dff1a4f0318b9fab3d4fd7b309dc7f406a8b59babe4ad169f8', '0032');
ALTER TABLE "canonical_model_versions" FORCE ROW LEVEL SECURITY;

-- Available at 0.6; disabled for every tenant until an operator enables it.
ALTER TABLE "canonical_modules" NO FORCE ROW LEVEL SECURITY;
UPDATE "canonical_modules" SET "available" = true, "minimum_canonical_version" = '0.6' WHERE "module_key" = 'commercial';
ALTER TABLE "canonical_modules" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 5. Policy v8: audit catalogues and the grantable capability (plan §16; Q22, Q23)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_audit_events"
  DROP CONSTRAINT "tenant_audit_events_capability_valid",
  DROP CONSTRAINT "tenant_audit_events_action_valid";
ALTER TABLE "tenant_audit_events"
  ADD CONSTRAINT "tenant_audit_events_capability_valid" CHECK ("capability" IN ('canonical.source_sync', 'canonical.import', 'processing.receipt', 'processing.dead_letter.resolve', 'config.tenant.provision', 'config.tenant.status', 'config.integration', 'config.oauth.install', 'config.oauth.grant', 'config.policy', 'config.product_model.publish', 'config.source.connection', 'config.source.schema', 'config.mapping.publish', 'config.authority.publish', 'data.sync.run', 'data.profile.run', 'data.eligibility.record', 'data.purge', 'security.key.rotate', 'security.audit.read', 'canonical.human_entry', 'config.canonical.adopt', 'config.module.change', 'config.registry.publish', 'config.data_policy.publish', 'config.mapping.draft', 'config.mapping.retire', 'security.integrity.run', 'canonical.evidence.link', 'data.provenance.read', 'data.account_structure.read', 'data.extension.read', 'data.account_context.read', 'data.account_context.read_confidential', 'security.capability.grant', 'data.commercial.read', 'data.commercial.read_confidential')),
  ADD CONSTRAINT "tenant_audit_events_action_valid" CHECK ("action" IN ('tenant.provision', 'tenant.status', 'integration.configure', 'credential_ref.save', 'credential_ref.delete', 'flow.set', 'lead_source_mapping.save', 'lead_source_mapping.delete', 'policy.save', 'qualification.update', 'oauth.install_state.issue', 'oauth.grant.store', 'oauth.grant.delete', 'oauth.grant.refresh', 'webhook.receipts.store', 'product_model.publish', 'subscription_import.run', 'subscription_import.cancel', 'source_connection.configure', 'source_connection.status', 'source_connection.test', 'source_schema.capture', 'mapping.publish', 'authority.publish', 'sync.start', 'sync.execute', 'sync.finish', 'sync.abandon', 'profile.start', 'profile.execute', 'profile.finish', 'profile.abandon', 'profile.purge', 'eligibility.record', 'dead_letter.replay', 'dead_letter.discard', 'context.backfill.start', 'context.reconcile.start', 'context.resync', 'context.receipts.process', 'security.rekey', 'security.audit.purge', 'security.audit.verify', 'security.audit.read', 'operation.denied', 'canonical.adopt', 'module.enable', 'module.disable', 'module.configure', 'registry.publish', 'data_policy.publish', 'mapping.draft.save', 'mapping.draft.validate', 'mapping.draft.discard', 'mapping.retire', 'integrity.verify', 'provenance.read', 'evidence.link', 'source_reference.observe', 'account.hierarchy.set', 'account.hierarchy.clear', 'account.hierarchy.release', 'person.affiliation.add', 'person.affiliation.end', 'person.affiliation.release', 'account_structure.read', 'extension.value.set', 'extension.value.clear', 'extension.value.release', 'extension.record.create', 'extension.record.update', 'extension.record.retire', 'extension.record.reactivate', 'extension.relationship.add', 'extension.relationship.end', 'extension.read', 'account_context.write', 'account_context.retire', 'account_context.member.set', 'account_context.line.assign', 'account_context.release', 'account_context.read', 'capability.grant', 'capability.revoke', 'commercial.price_offer.write', 'commercial.contract.write', 'commercial.contract.link', 'commercial.entitlement.write', 'commercial.line.reference', 'commercial.release', 'commercial.read'));

-- Closed grantable list = GRANTABLE_CAPABILITIES in code.
ALTER TABLE "tenant_capability_grants" DROP CONSTRAINT "tenant_capability_grants_capability_grantable";
ALTER TABLE "tenant_capability_grants"
  ADD CONSTRAINT "tenant_capability_grants_capability_grantable" CHECK ("capability" IN ('data.account_context.read_confidential', 'data.commercial.read_confidential'));

-- ---------------------------------------------------------------------------
-- 6. Tenant isolation and privileges (plan §3, §14)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_price_offers', 'tenant_contracts', 'tenant_entitlements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
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

-- Offers retire, contracts and entitlements change status: nothing disappears.
GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_price_offers" TO lip_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_contracts" TO lip_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_entitlements" TO lip_app;
