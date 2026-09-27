-- Milestone 5 (ADR 0011): HubSpot webhook receipts and account-to-tenant routing.

-- CreateTable
CREATE TABLE "tenant_webhook_receipts" (
    "tenant_id" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "delivery_key" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "subscription_type" TEXT NOT NULL,
    "object_type_id" TEXT,
    "object_id" TEXT,
    "property_name" TEXT,
    "change_source" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "first_attempt_number" INTEGER NOT NULL,
    "last_attempt_number" INTEGER NOT NULL,
    "deliveries" INTEGER NOT NULL DEFAULT 1,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_webhook_receipts_pkey" PRIMARY KEY ("tenant_id","system","delivery_key")
);

-- CreateIndex
CREATE INDEX "tenant_webhook_receipts_tenant_id_received_at_idx" ON "tenant_webhook_receipts"("tenant_id", "received_at");

-- AddForeignKey
ALTER TABLE "tenant_webhook_receipts" ADD CONSTRAINT "tenant_webhook_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Integrity. Every column holds an identifier, a type name or a number: there
-- is no column a property value or a request body could be written to.
ALTER TABLE "tenant_webhook_receipts"
  ADD CONSTRAINT "tenant_webhook_receipts_system_valid" CHECK ("system" IN ('hubspot')),
  ADD CONSTRAINT "tenant_webhook_receipts_delivery_key_format" CHECK ("delivery_key" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_webhook_receipts_event_id_format" CHECK ("event_id" ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT "tenant_webhook_receipts_subscription_id_format" CHECK ("subscription_id" ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT "tenant_webhook_receipts_account_id_format" CHECK ("account_id" ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT "tenant_webhook_receipts_app_id_format" CHECK ("app_id" ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT "tenant_webhook_receipts_subscription_type_format" CHECK ("subscription_type" ~ '^[A-Za-z_]{1,40}\.[A-Za-z_]{1,40}$'),
  ADD CONSTRAINT "tenant_webhook_receipts_object_type_id_format" CHECK ("object_type_id" IS NULL OR "object_type_id" ~ '^[0-9]{1,5}-[0-9]{1,12}$'),
  ADD CONSTRAINT "tenant_webhook_receipts_object_id_format" CHECK ("object_id" IS NULL OR "object_id" ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT "tenant_webhook_receipts_property_name_format" CHECK ("property_name" IS NULL OR "property_name" ~ '^[A-Za-z0-9_]{1,100}$'),
  ADD CONSTRAINT "tenant_webhook_receipts_change_source_format" CHECK ("change_source" IS NULL OR "change_source" ~ '^[A-Z0-9_]{1,64}$'),
  ADD CONSTRAINT "tenant_webhook_receipts_attempts_valid" CHECK ("first_attempt_number" >= 0 AND "last_attempt_number" >= "first_attempt_number"),
  ADD CONSTRAINT "tenant_webhook_receipts_deliveries_valid" CHECK ("deliveries" >= 1);

-- Row-level security, exactly as for every other tenant-owned table.
ALTER TABLE "tenant_webhook_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_webhook_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_webhook_receipts"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE TRIGGER "tenant_webhook_receipts_tenant_immutable" BEFORE UPDATE ON "tenant_webhook_receipts"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();

-- ---------------------------------------------------------------------------
-- Routing: which tenant does a webhook from external account X belong to?
--
-- A webhook arrives before any tenant is known, and forced RLS hides every
-- grant from the app role until a tenant is set. Instead of weakening that,
-- one narrow function answers exactly this question. It runs as a dedicated
-- NOLOGIN role that can read only three non-secret columns of the grants
-- (never a token) and the status of tenants, and it returns at most two
-- tenant ids: 0 = unknown account, 2 = ambiguous; the caller never guesses.
-- Only active tenants holding an OAuth grant for that exact account qualify,
-- so a tenant using a static token (no grant) is never a routing target.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lip_webhook_router') THEN
    CREATE ROLE lip_webhook_router NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO lip_webhook_router;
GRANT SELECT ("tenant_id", "system", "account_id") ON "tenant_oauth_tokens" TO lip_webhook_router;
GRANT SELECT ("id", "status") ON "tenants" TO lip_webhook_router;
CREATE POLICY "webhook_routing" ON "tenant_oauth_tokens" FOR SELECT TO lip_webhook_router USING (true);
CREATE POLICY "webhook_routing" ON "tenants" FOR SELECT TO lip_webhook_router USING (true);

CREATE FUNCTION "app_route_oauth_account"(p_system text, p_account_id text)
RETURNS TABLE ("tenant_id" uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT g.tenant_id
    FROM public.tenant_oauth_tokens g
    JOIN public.tenants t ON t.id = g.tenant_id
   WHERE g.system = p_system
     AND g.account_id = p_account_id
     AND t.status = 'active'
   ORDER BY g.tenant_id
   LIMIT 2
$$;

-- The migration owner hands the function to the router role (PostgreSQL 16:
-- changing an owner requires being able to act as the new owner).
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'lip_webhook_router', 'MEMBER') THEN
    EXECUTE format('GRANT lip_webhook_router TO %I', current_user);
  END IF;
END
$$;
ALTER FUNCTION "app_route_oauth_account"(text, text) OWNER TO lip_webhook_router;
REVOKE ALL ON FUNCTION "app_route_oauth_account"(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app_route_oauth_account"(text, text) TO lip_app;
