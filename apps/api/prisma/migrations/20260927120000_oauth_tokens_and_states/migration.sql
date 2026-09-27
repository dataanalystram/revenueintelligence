-- Milestone 4 (ADR 0010): encrypted OAuth grants and single-use OAuth install states.
-- Both tables are tenant-owned: forced RLS, tenant-scoped keys (ADR 0008).

-- CreateTable
CREATE TABLE "tenant_oauth_tokens" (
    "tenant_id" UUID NOT NULL,
    "system" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "refresh_token_enc" TEXT NOT NULL,
    "access_token_enc" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_oauth_tokens_pkey" PRIMARY KEY ("tenant_id","system")
);

-- CreateTable
CREATE TABLE "tenant_oauth_states" (
    "tenant_id" UUID NOT NULL,
    "nonce_hash" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_oauth_states_pkey" PRIMARY KEY ("tenant_id","nonce_hash")
);

-- AddForeignKey
ALTER TABLE "tenant_oauth_tokens" ADD CONSTRAINT "tenant_oauth_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_oauth_states" ADD CONSTRAINT "tenant_oauth_states_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Integrity. Token columns can only ever hold the cipher's output format
-- ("v1:" + base64url of iv | ciphertext | tag), so a plaintext token cannot be
-- stored even by mistake.
ALTER TABLE "tenant_oauth_tokens"
  ADD CONSTRAINT "tenant_oauth_tokens_system_valid" CHECK ("system" IN ('hubspot')),
  ADD CONSTRAINT "tenant_oauth_tokens_account_id_format" CHECK ("account_id" ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT "tenant_oauth_tokens_refresh_encrypted" CHECK ("refresh_token_enc" ~ '^v1:[A-Za-z0-9_-]{38,}$'),
  ADD CONSTRAINT "tenant_oauth_tokens_access_encrypted" CHECK ("access_token_enc" IS NULL OR "access_token_enc" ~ '^v1:[A-Za-z0-9_-]{38,}$'),
  ADD CONSTRAINT "tenant_oauth_tokens_access_expiry_pair" CHECK (("access_token_enc" IS NULL) = ("access_token_expires_at" IS NULL));

ALTER TABLE "tenant_oauth_states"
  ADD CONSTRAINT "tenant_oauth_states_system_valid" CHECK ("system" IN ('hubspot')),
  ADD CONSTRAINT "tenant_oauth_states_nonce_hash_format" CHECK ("nonce_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "tenant_oauth_states_expiry_after_creation" CHECK ("expires_at" > "created_at");

-- Row-level security, exactly as for every other tenant-owned table.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_oauth_tokens', 'tenant_oauth_states'] LOOP
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
