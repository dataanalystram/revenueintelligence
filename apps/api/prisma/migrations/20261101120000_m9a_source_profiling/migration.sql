-- Milestone 9A (ADR 0022, ADR 0023): source data profiling, the
-- seen-but-rejected ownership-gap reasons and stable-snapshot proof
-- acceptances.
--
-- * Profile runs (mutable until terminal), profiles and findings (immutable)
--   and the purge audit (append-only). Every table: tenant-leading keys,
--   composite tenant FKs, forced RLS, tenant immutability.
-- * Profile documents hold aggregates only (no raw values except the
--   safe-category rule); size and secret-like-key CHECKs.
-- * Deleting profiles is possible only through the privileged purge (owner
--   credentials, never a member of lip_app) with an audit row.
-- * Ownership gaps gain three reasons (record-level protection, §9-§10).
-- * Authority versions gain `proof_acceptances` (stable-snapshot acceptances;
--   content hash unchanged while empty).

-- ---------------------------------------------------------------------------
-- 1. Profile runs
-- ---------------------------------------------------------------------------
CREATE TABLE "tenant_source_profile_runs" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "schema_snapshot_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "active_key" TEXT,
    "request" JSONB NOT NULL,
    "sampling" JSONB,
    "error_code" TEXT,
    "requested_by" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "tenant_source_profile_runs_pkey" PRIMARY KEY ("tenant_id","id")
);

ALTER TABLE "tenant_source_profile_runs"
  ADD CONSTRAINT "tenant_source_profile_runs_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenant_source_profile_runs_snapshot_fkey" FOREIGN KEY ("tenant_id", "connection_id", "schema_snapshot_hash") REFERENCES "tenant_source_schema_snapshots"("tenant_id", "connection_id", "hash") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenant_source_profile_runs_status_valid" CHECK ("status" IN ('requested', 'running', 'completed', 'failed', 'abandoned')),
  ADD CONSTRAINT "tenant_source_profile_runs_request_object" CHECK (jsonb_typeof("request") = 'object' AND octet_length("request"::text) <= 65536 AND NOT app_jsonb_has_secret_like_key("request")),
  ADD CONSTRAINT "tenant_source_profile_runs_sampling_object" CHECK ("sampling" IS NULL OR (jsonb_typeof("sampling") = 'object' AND octet_length("sampling"::text) <= 65536)),
  ADD CONSTRAINT "tenant_source_profile_runs_error_code_format" CHECK ("error_code" IS NULL OR "error_code" ~ '^[a-z0-9_]{1,64}$'),
  ADD CONSTRAINT "tenant_source_profile_runs_requested_by_format" CHECK ("requested_by" ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  -- One active run per connection: the active key is the connection id while
  -- requested/running and NULL once terminal (unique; same pattern as M6/M8 runs).
  ADD CONSTRAINT "tenant_source_profile_runs_active_key_consistent" CHECK (
    ("status" IN ('requested', 'running')) = ("active_key" IS NOT NULL)
    AND ("active_key" IS NULL OR "active_key" = "connection_id"::text)),
  ADD CONSTRAINT "tenant_source_profile_runs_terminal_consistent" CHECK (
    ("status" IN ('completed', 'failed', 'abandoned')) = ("finished_at" IS NOT NULL)
    AND ("status" NOT IN ('failed', 'abandoned') OR "error_code" IS NOT NULL));

CREATE INDEX "tenant_source_profile_runs_tenant_id_connection_id_created_idx" ON "tenant_source_profile_runs"("tenant_id", "connection_id", "created_at" DESC);
CREATE UNIQUE INDEX "tenant_source_profile_runs_tenant_id_active_key_key" ON "tenant_source_profile_runs"("tenant_id", "active_key");

-- Forward-only lifecycle; identity and request never change; terminal rows are frozen.
CREATE FUNCTION "app_profile_run_transition"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'profile runs are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('completed', 'failed', 'abandoned') THEN
    RAISE EXCEPTION 'profile run % is terminal', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."connection_id" IS DISTINCT FROM OLD."connection_id"
     OR NEW."schema_snapshot_hash" IS DISTINCT FROM OLD."schema_snapshot_hash"
     OR NEW."request" IS DISTINCT FROM OLD."request"
     OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
     OR NEW."correlation_id" IS DISTINCT FROM OLD."correlation_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'profile run identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    (OLD."status" = NEW."status")
    OR (OLD."status" = 'requested' AND NEW."status" IN ('running', 'abandoned'))
    OR (OLD."status" = 'running' AND NEW."status" IN ('completed', 'failed', 'abandoned'))
  ) THEN
    RAISE EXCEPTION 'profile run transition % -> % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tenant_source_profile_runs_transition" BEFORE UPDATE OR DELETE ON "tenant_source_profile_runs"
  FOR EACH ROW EXECUTE FUNCTION app_profile_run_transition();
CREATE TRIGGER "tenant_source_profile_runs_tenant_immutable" BEFORE UPDATE ON "tenant_source_profile_runs"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();

-- ---------------------------------------------------------------------------
-- 2. Profiles (immutable; deletion only through the privileged purge)
-- ---------------------------------------------------------------------------
CREATE TABLE "tenant_source_profiles" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "run_id" UUID,
    "sync_run_id" UUID,
    "connection_id" UUID NOT NULL,
    "object" TEXT NOT NULL,
    "schema_snapshot_hash" TEXT NOT NULL,
    "sampling_family" TEXT NOT NULL,
    "previous_profile_id" UUID,
    "document" JSONB NOT NULL,
    "document_version" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_source_profiles_pkey" PRIMARY KEY ("tenant_id","id")
);

ALTER TABLE "tenant_source_profiles"
  ADD CONSTRAINT "tenant_source_profiles_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "tenant_source_profile_runs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenant_source_profiles_tenant_id_sync_run_id_fkey" FOREIGN KEY ("tenant_id", "sync_run_id") REFERENCES "tenant_sync_checkpoints"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenant_source_profiles_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenant_source_profiles_tenant_id_connection_id_snapshot_fkey" FOREIGN KEY ("tenant_id", "connection_id", "schema_snapshot_hash") REFERENCES "tenant_source_schema_snapshots"("tenant_id", "connection_id", "hash") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenant_source_profiles_tenant_id_previous_profile_id_fkey" FOREIGN KEY ("tenant_id", "previous_profile_id") REFERENCES "tenant_source_profiles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenant_source_profiles_one_origin" CHECK (("run_id" IS NULL) <> ("sync_run_id" IS NULL)),
  ADD CONSTRAINT "tenant_source_profiles_family_valid" CHECK ("sampling_family" IN ('profile', 'sync') AND ("sampling_family" = 'profile') = ("run_id" IS NOT NULL)),
  ADD CONSTRAINT "tenant_source_profiles_object_format" CHECK ("object" ~ '^[A-Za-z][A-Za-z0-9_]{0,99}$'),
  ADD CONSTRAINT "tenant_source_profiles_document_object" CHECK (jsonb_typeof("document") = 'object' AND octet_length("document"::text) <= 1048576),
  ADD CONSTRAINT "tenant_source_profiles_document_no_secrets" CHECK (NOT app_jsonb_has_secret_like_key("document")),
  ADD CONSTRAINT "tenant_source_profiles_document_version_valid" CHECK ("document_version" = 1),
  ADD CONSTRAINT "tenant_source_profiles_hash_format" CHECK ("content_hash" ~ '^[0-9a-f]{64}$');

CREATE INDEX "tenant_source_profiles_baseline_idx" ON "tenant_source_profiles"("tenant_id", "connection_id", "object", "sampling_family", "created_at" DESC);
-- NULLs are distinct, so each constraint binds only profiles of its origin.
CREATE UNIQUE INDEX "tenant_source_profiles_tenant_id_run_id_object_key" ON "tenant_source_profiles"("tenant_id", "run_id", "object");
CREATE UNIQUE INDEX "tenant_source_profiles_tenant_id_sync_run_id_object_key" ON "tenant_source_profiles"("tenant_id", "sync_run_id", "object");

-- Immutable, except DELETE inside the privileged purge: the transaction sets
-- lip.profile_purge = 'on' and the session is not a member of lip_app.
CREATE FUNCTION "app_profile_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('lip.profile_purge', true) = 'on'
     AND NOT pg_has_role(session_user, 'lip_app', 'MEMBER') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% on % is not allowed (%)', TG_OP, TG_TABLE_NAME, TG_ARGV[0]
    USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "tenant_source_profiles_immutable" BEFORE UPDATE OR DELETE ON "tenant_source_profiles"
  FOR EACH ROW EXECUTE FUNCTION app_profile_refuse_change('source profiles are immutable');

-- ---------------------------------------------------------------------------
-- 3. Findings (immutable; acknowledgements live on mapping versions)
-- ---------------------------------------------------------------------------
CREATE TABLE "tenant_source_profile_findings" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "object" TEXT NOT NULL,
    "field" TEXT,
    "evidence" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_source_profile_findings_pkey" PRIMARY KEY ("tenant_id","id")
);

ALTER TABLE "tenant_source_profile_findings"
  ADD CONSTRAINT "tenant_source_profile_findings_tenant_id_profile_id_fkey" FOREIGN KEY ("tenant_id", "profile_id") REFERENCES "tenant_source_profiles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Mirrors domain/profiling/findings.ts FINDING_CODES (parity test).
  ADD CONSTRAINT "tenant_source_profile_findings_code_valid" CHECK ("code" IN (
    'high_null_ratio', 'required_but_null', 'empty_string_vs_null', 'mixed_type',
    'mixed_representation', 'malformed_json', 'invalid_date', 'ambiguous_date', 'number_locale',
    'ambiguous_delimiter', 'leading_zero_numeric', 'declared_type_mismatch',
    'value_not_in_declared_enum', 'high_cardinality_identifier', 'undeclared_field_in_data',
    'field_absent_in_data', 'identifier_not_unique', 'sensitive_values_detected',
    'head_sample_biased', 'low_coverage_sample', 'findings_truncated',
    'profile_drift_null_ratio', 'profile_drift_type_distribution', 'profile_drift_type_compatible',
    'profile_drift_type_incompatible', 'profile_drift_representation', 'profile_drift_new_category',
    'profile_drift_category_vanished', 'profile_drift_cardinality', 'profile_drift_row_count',
    'profile_drift_parse_failures', 'identity_field_absent', 'holding_filter_value_unreviewed')),
  ADD CONSTRAINT "tenant_source_profile_findings_class_valid" CHECK ("class" IN ('advisory', 'existing_fail_closed', 'm9a_fail_closed')),
  ADD CONSTRAINT "tenant_source_profile_findings_severity_valid" CHECK ("severity" IN ('info', 'warning', 'review_required')),
  ADD CONSTRAINT "tenant_source_profile_findings_names_format" CHECK ("object" ~ '^[A-Za-z][A-Za-z0-9_]{0,99}$' AND ("field" IS NULL OR "field" ~ '^[A-Za-z][A-Za-z0-9_]{0,99}$')),
  ADD CONSTRAINT "tenant_source_profile_findings_evidence_object" CHECK (jsonb_typeof("evidence") = 'object' AND octet_length("evidence"::text) <= 4096 AND NOT app_jsonb_has_secret_like_key("evidence"));

CREATE INDEX "tenant_source_profile_findings_profile_idx" ON "tenant_source_profile_findings"("tenant_id", "profile_id");
CREATE INDEX "tenant_source_profile_findings_code_idx" ON "tenant_source_profile_findings"("tenant_id", "code");

CREATE TRIGGER "tenant_source_profile_findings_immutable" BEFORE UPDATE OR DELETE ON "tenant_source_profile_findings"
  FOR EACH ROW EXECUTE FUNCTION app_profile_refuse_change('profile findings are immutable');

-- ---------------------------------------------------------------------------
-- 4. Purge audit (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE "tenant_source_profile_purges" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "object" TEXT NOT NULL,
    "kept" INTEGER NOT NULL,
    "deleted_profiles" INTEGER NOT NULL,
    "deleted_findings" INTEGER NOT NULL,
    "actor" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_source_profile_purges_pkey" PRIMARY KEY ("tenant_id","id")
);

ALTER TABLE "tenant_source_profile_purges"
  ADD CONSTRAINT "tenant_source_profile_purges_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "tenant_source_profile_purges_counts_valid" CHECK ("kept" >= 0 AND "deleted_profiles" >= 0 AND "deleted_findings" >= 0),
  ADD CONSTRAINT "tenant_source_profile_purges_object_format" CHECK ("object" ~ '^[A-Za-z][A-Za-z0-9_]{0,99}$'),
  ADD CONSTRAINT "tenant_source_profile_purges_actor_format" CHECK ("actor" ~ '^[A-Za-z0-9_.:@-]{1,128}$');

CREATE TRIGGER "tenant_source_profile_purges_immutable" BEFORE UPDATE OR DELETE ON "tenant_source_profile_purges"
  FOR EACH ROW EXECUTE FUNCTION app_refuse_change('profile purge audit is append-only');

-- ---------------------------------------------------------------------------
-- 5. Row-level security and grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_source_profile_runs', 'tenant_source_profiles',
                           'tenant_source_profile_findings', 'tenant_source_profile_purges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t);
  END LOOP;
END
$$;
CREATE TRIGGER "tenant_source_profiles_tenant_immutable" BEFORE UPDATE ON "tenant_source_profiles"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();
CREATE TRIGGER "tenant_source_profile_findings_tenant_immutable" BEFORE UPDATE ON "tenant_source_profile_findings"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();
CREATE TRIGGER "tenant_source_profile_purges_tenant_immutable" BEFORE UPDATE ON "tenant_source_profile_purges"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();

-- Default privileges give lip_app SELECT/INSERT/UPDATE/DELETE on new tables.
-- Immutable tables: no UPDATE or DELETE for the app (the purge uses the owner).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_source_profiles" FROM lip_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_source_profile_findings" FROM lip_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "tenant_source_profile_purges" FROM lip_app;
REVOKE DELETE, TRUNCATE ON TABLE "tenant_source_profile_runs" FROM lip_app;

-- ---------------------------------------------------------------------------
-- 6. Ownership-gap reasons (record-level protection, ADR 0023)
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_ownership_gaps"
  DROP CONSTRAINT "tenant_ownership_gaps_reason_valid",
  ADD CONSTRAINT "tenant_ownership_gaps_reason_valid" CHECK ("reason" IN (
    'missing_product_reference', 'orphan_product_reference',
    'observation_rejected', 'holding_filter_value_unreviewed', 'account_reference_orphaned'));

-- ---------------------------------------------------------------------------
-- 7. Stable-snapshot proof acceptances on authority versions
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_source_authority_versions"
  ADD COLUMN "proof_acceptances" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "tenant_source_authority_versions"
  ADD CONSTRAINT "tenant_source_authority_versions_acceptances_shape" CHECK (
    jsonb_typeof("proof_acceptances") = 'array'
    AND jsonb_array_length("proof_acceptances") <= 16
    AND octet_length("proof_acceptances"::text) <= 16384
    AND NOT app_jsonb_has_secret_like_key("proof_acceptances"));

-- Every acceptance names a stable_snapshot tier and a connection of the same tenant
-- (JSON cannot carry a composite FK; RLS limits the lookup to the tenant).
CREATE FUNCTION "app_check_proof_acceptances"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a jsonb;
  cid uuid;
BEGIN
  FOR a IN SELECT * FROM jsonb_array_elements(NEW."proof_acceptances") LOOP
    IF jsonb_typeof(a) <> 'object' OR a->>'tier' IS DISTINCT FROM 'stable_snapshot'
       OR a->>'connectionId' IS NULL OR a->>'reason' IS NULL OR a->>'actor' IS NULL THEN
      RAISE EXCEPTION 'invalid proof acceptance' USING ERRCODE = 'check_violation';
    END IF;
    BEGIN
      cid := (a->>'connectionId')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'invalid proof acceptance connection' USING ERRCODE = 'check_violation';
    END;
    IF NOT EXISTS (SELECT 1 FROM "tenant_source_connections" c
                    WHERE c."tenant_id" = NEW."tenant_id" AND c."id" = cid) THEN
      RAISE EXCEPTION 'proof acceptance names a connection of another tenant or none'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
CREATE TRIGGER "tenant_source_authority_versions_acceptances" BEFORE INSERT ON "tenant_source_authority_versions"
  FOR EACH ROW EXECUTE FUNCTION app_check_proof_acceptances();

-- Hash parity: every existing version still hashes as before (acceptances empty).
DO $$
DECLARE
  bad bigint;
BEGIN
  SELECT count(*) INTO bad FROM "tenant_source_authority_versions"
   WHERE "content_hash" <> encode(sha256(convert_to(concat_ws('|',
           coalesce("account_profile_connection_id"::text, '-'),
           coalesce("person_profile_connection_id"::text, '-'),
           coalesce("subscription_lines_connection_id"::text, '-'),
           coalesce("subscription_state_connection_id"::text, '-'),
           coalesce("subscription_terms_connection_id"::text, '-')), 'UTF8')), 'hex')
      OR "proof_acceptances" <> '[]'::jsonb;
  IF bad <> 0 THEN
    RAISE EXCEPTION 'authority hash parity failed for % versions', bad;
  END IF;
END
$$;
