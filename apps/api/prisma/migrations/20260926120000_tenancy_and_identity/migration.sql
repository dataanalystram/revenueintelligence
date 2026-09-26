-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_integrations" (
    "tenant_id" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'disabled',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_integrations_pkey" PRIMARY KEY ("tenant_id","system")
);

-- CreateTable
CREATE TABLE "tenant_flow_settings" (
    "tenant_id" UUID NOT NULL,
    "flow" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'off',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_flow_settings_pkey" PRIMARY KEY ("tenant_id","flow")
);

-- CreateTable
CREATE TABLE "tenant_credential_refs" (
    "tenant_id" UUID NOT NULL,
    "tenant_slug" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secret_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_credential_refs_pkey" PRIMARY KEY ("tenant_id","system","name")
);

-- CreateTable
CREATE TABLE "tenant_qualification_config" (
    "tenant_id" UUID NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'rules',
    "ruleset_version" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_qualification_config_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "tenant_products" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_products_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateTable
CREATE TABLE "tenant_field_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "canonical_entity" TEXT NOT NULL,
    "canonical_field" TEXT NOT NULL,
    "external_field" TEXT,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'tbc',
    "value_map" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_field_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_lead_source_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "source_property" TEXT NOT NULL,
    "match_type" TEXT NOT NULL,
    "source_value" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "label" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_lead_source_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_policies" (
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_policies_pkey" PRIMARY KEY ("tenant_id","kind")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customer_status" TEXT NOT NULL DEFAULT 'unknown',
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_products" (
    "tenant_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "since" TIMESTAMPTZ(3),
    "until" TIMESTAMPTZ(3),

    CONSTRAINT "company_products_pkey" PRIMARY KEY ("tenant_id","company_id","product_key")
);

-- CreateTable
CREATE TABLE "company_external_refs" (
    "tenant_id" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "company_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_external_refs_pkey" PRIMARY KEY ("tenant_id","system","object_type","external_id")
);

-- CreateTable
CREATE TABLE "persons" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "primary_email" TEXT NOT NULL,
    "additional_emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "first_name" TEXT,
    "last_name" TEXT,
    "job_title" TEXT,
    "company_id" UUID,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_external_refs" (
    "tenant_id" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "person_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_external_refs_pkey" PRIMARY KEY ("tenant_id","system","object_type","external_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_id_slug_key" ON "tenants"("id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_field_mappings_tenant_id_id_key" ON "tenant_field_mappings"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_field_mappings_tenant_id_system_object_type_canonica_key" ON "tenant_field_mappings"("tenant_id", "system", "object_type", "canonical_entity", "canonical_field");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_lead_source_mappings_tenant_id_id_key" ON "tenant_lead_source_mappings"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_lead_source_mappings_tenant_id_system_source_propert_key" ON "tenant_lead_source_mappings"("tenant_id", "system", "source_property", "match_type", "source_value");

-- CreateIndex
CREATE INDEX "companies_tenant_id_name_idx" ON "companies"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "companies_tenant_id_id_key" ON "companies"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "company_external_refs_tenant_id_company_id_idx" ON "company_external_refs"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "persons_tenant_id_company_id_idx" ON "persons"("tenant_id", "company_id");

-- CreateIndex
CREATE UNIQUE INDEX "persons_tenant_id_id_key" ON "persons"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "persons_tenant_id_primary_email_key" ON "persons"("tenant_id", "primary_email");

-- CreateIndex
CREATE INDEX "person_external_refs_tenant_id_person_id_idx" ON "person_external_refs"("tenant_id", "person_id");

-- AddForeignKey
ALTER TABLE "tenant_integrations" ADD CONSTRAINT "tenant_integrations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_flow_settings" ADD CONSTRAINT "tenant_flow_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_credential_refs" ADD CONSTRAINT "tenant_credential_refs_tenant_id_tenant_slug_fkey" FOREIGN KEY ("tenant_id", "tenant_slug") REFERENCES "tenants"("id", "slug") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_qualification_config" ADD CONSTRAINT "tenant_qualification_config_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_products" ADD CONSTRAINT "tenant_products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_field_mappings" ADD CONSTRAINT "tenant_field_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_lead_source_mappings" ADD CONSTRAINT "tenant_lead_source_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_policies" ADD CONSTRAINT "tenant_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_tenant_id_company_id_fkey" FOREIGN KEY ("tenant_id", "company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_tenant_id_product_key_fkey" FOREIGN KEY ("tenant_id", "product_key") REFERENCES "tenant_products"("tenant_id", "key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_external_refs" ADD CONSTRAINT "company_external_refs_tenant_id_company_id_fkey" FOREIGN KEY ("tenant_id", "company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "persons" ADD CONSTRAINT "persons_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "persons" ADD CONSTRAINT "persons_tenant_id_company_id_fkey" FOREIGN KEY ("tenant_id", "company_id") REFERENCES "companies"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "person_external_refs" ADD CONSTRAINT "person_external_refs_tenant_id_person_id_fkey" FOREIGN KEY ("tenant_id", "person_id") REFERENCES "persons"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;


-- =============================================================================
-- Hand-written section (ADR 0008). Prisma does not model row-level security,
-- CHECK constraints, triggers or roles, so they are maintained here.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Value constraints: the database rejects invalid values even if
--    application validation were bypassed.
-- ---------------------------------------------------------------------------
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_slug_format" CHECK ("slug" ~ '^[a-z][a-z0-9]{1,39}$'),
  ADD CONSTRAINT "tenants_status_valid" CHECK ("status" IN ('active', 'suspended', 'offboarded')),
  ADD CONSTRAINT "tenants_name_present" CHECK (length(btrim("name")) > 0);

ALTER TABLE "tenant_integrations"
  ADD CONSTRAINT "tenant_integrations_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px', 'jev')),
  ADD CONSTRAINT "tenant_integrations_access_valid" CHECK ("access" IN ('disabled', 'read_only', 'read_write')),
  ADD CONSTRAINT "tenant_integrations_settings_object" CHECK (jsonb_typeof("settings") = 'object'),
  ADD CONSTRAINT "tenant_integrations_version_positive" CHECK ("version" >= 1);

ALTER TABLE "tenant_flow_settings"
  ADD CONSTRAINT "tenant_flow_settings_flow_valid" CHECK ("flow" IN ('hubspot_to_sugar_handover', 'sugar_to_hubspot_outcomes', 'gainsight_lead_creation', 'hubspot_enrichment')),
  ADD CONSTRAINT "tenant_flow_settings_mode_valid" CHECK ("mode" IN ('off', 'shadow', 'coexist', 'active')),
  ADD CONSTRAINT "tenant_flow_settings_version_positive" CHECK ("version" >= 1);

ALTER TABLE "tenant_credential_refs"
  ADD CONSTRAINT "tenant_credential_refs_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px', 'jev')),
  ADD CONSTRAINT "tenant_credential_refs_name_format" CHECK ("name" ~ '^[a-z][a-z0-9_]{1,62}$'),
  -- A tenant's credential reference can only point at that tenant's secrets.
  ADD CONSTRAINT "tenant_credential_refs_key_owned" CHECK (starts_with("secret_key", 'tenant.' || "tenant_slug" || '.')),
  ADD CONSTRAINT "tenant_credential_refs_key_format" CHECK ("secret_key" ~ '^[a-z0-9]+([._-][a-z0-9]+)*$');

ALTER TABLE "tenant_qualification_config"
  ADD CONSTRAINT "tenant_qualification_config_mode_valid" CHECK ("mode" IN ('rules', 'jev', 'hybrid')),
  ADD CONSTRAINT "tenant_qualification_config_settings_object" CHECK (jsonb_typeof("settings") = 'object'),
  ADD CONSTRAINT "tenant_qualification_config_version_positive" CHECK ("version" >= 1);

ALTER TABLE "tenant_products"
  ADD CONSTRAINT "tenant_products_key_format" CHECK ("key" ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  ADD CONSTRAINT "tenant_products_name_present" CHECK (length(btrim("name")) > 0);

ALTER TABLE "tenant_field_mappings"
  ADD CONSTRAINT "tenant_field_mappings_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px')),
  ADD CONSTRAINT "tenant_field_mappings_direction_valid" CHECK ("direction" IN ('inbound', 'outbound', 'bidirectional')),
  ADD CONSTRAINT "tenant_field_mappings_status_valid" CHECK ("status" IN ('tbc', 'proposed', 'confirmed')),
  -- TBC means "not known yet": no external field may be recorded, and a known field is never TBC.
  ADD CONSTRAINT "tenant_field_mappings_tbc_has_no_field" CHECK (("status" = 'tbc') = ("external_field" IS NULL)),
  ADD CONSTRAINT "tenant_field_mappings_value_map_object" CHECK (jsonb_typeof("value_map") = 'object');

ALTER TABLE "tenant_lead_source_mappings"
  ADD CONSTRAINT "tenant_lead_source_mappings_system_valid" CHECK ("system" IN ('hubspot', 'gainsight_cs', 'gainsight_px')),
  ADD CONSTRAINT "tenant_lead_source_mappings_match_valid" CHECK ("match_type" IN ('equals', 'contains')),
  ADD CONSTRAINT "tenant_lead_source_mappings_priority_valid" CHECK ("priority" >= 0),
  ADD CONSTRAINT "tenant_lead_source_mappings_value_present" CHECK (length("source_value") > 0);

ALTER TABLE "tenant_policies"
  ADD CONSTRAINT "tenant_policies_kind_valid" CHECK ("kind" IN ('sla', 'routing', 'requalification')),
  ADD CONSTRAINT "tenant_policies_document_object" CHECK (jsonb_typeof("document") = 'object'),
  ADD CONSTRAINT "tenant_policies_version_positive" CHECK ("version" >= 1);

ALTER TABLE "companies"
  ADD CONSTRAINT "companies_customer_status_valid" CHECK ("customer_status" IN ('prospect', 'customer', 'former_customer', 'unknown'));

ALTER TABLE "company_products"
  ADD CONSTRAINT "company_products_status_valid" CHECK ("status" IN ('active', 'trial', 'expired', 'churned')),
  ADD CONSTRAINT "company_products_period_valid" CHECK ("since" IS NULL OR "until" IS NULL OR "since" <= "until");

ALTER TABLE "company_external_refs"
  ADD CONSTRAINT "company_external_refs_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px'));

ALTER TABLE "persons"
  ADD CONSTRAINT "persons_email_normalised" CHECK ("primary_email" = lower(btrim("primary_email")));

ALTER TABLE "person_external_refs"
  ADD CONSTRAINT "person_external_refs_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px'));

-- ---------------------------------------------------------------------------
-- 2. Immutability: a row can never move between tenants, and a tenant's slug
--    (embedded in its secret keys) can never change.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "app_prevent_tenant_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" THEN
    RAISE EXCEPTION 'tenant_id is immutable on %', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "app_prevent_slug_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."slug" IS DISTINCT FROM OLD."slug" THEN
    RAISE EXCEPTION 'tenant slug is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "tenants_slug_immutable" BEFORE UPDATE ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION "app_prevent_slug_change"();

-- ---------------------------------------------------------------------------
-- 3. Row-level security. The current tenant is a transaction-local setting
--    (set_config('app.current_tenant', <uuid>, true)), so it cannot leak to
--    another request through a pooled connection. With no tenant set,
--    tenant-owned rows are invisible and cannot be written.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "app_current_tenant"() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_integrations', 'tenant_flow_settings', 'tenant_credential_refs',
    'tenant_qualification_config', 'tenant_products', 'tenant_field_mappings',
    'tenant_lead_source_mappings', 'tenant_policies',
    'companies', 'company_products', 'company_external_refs',
    'persons', 'person_external_refs'
  ] LOOP
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

-- The registry: platform code (no tenant set) sees and manages all tenants;
-- inside a tenant transaction only the own tenant is visible and nothing can
-- be written.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_registry" ON "tenants"
  USING (app_current_tenant() IS NULL OR "id" = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL);

-- ---------------------------------------------------------------------------
-- 4. Application role. The runtime connects as a LOGIN role that is a member
--    of lip_app (never the owner, never a superuser); migrations run as the
--    owner. See docs/operations/database-roles.md.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lip_app') THEN
    CREATE ROLE lip_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO lip_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lip_app;
REVOKE ALL ON TABLE "_prisma_migrations" FROM lip_app;
GRANT EXECUTE ON FUNCTION "app_current_tenant"() TO lip_app;
-- Tables created by later migrations are granted automatically; each still
-- needs its own RLS policy, which the schema-guard test enforces.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lip_app;
