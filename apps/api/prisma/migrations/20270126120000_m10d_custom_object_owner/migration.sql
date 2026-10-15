-- M10D hardening #83 (ADR 0030 addendum "Q14 single owner, structural";
-- tech debt #83, M10D review m1): a custom object is source-fed by ONE
-- connection, enforced by the database.
--   1. tenant_custom_object_owners: one row per (tenant, custom object key) —
--      the PRIMARY KEY makes a second owner a unique violation, so two
--      connections publishing the same custom object concurrently cannot both
--      commit. Composite same-tenant FKs to the registry entry (kind
--      extension), the owning connection and the owner's published mapping
--      version. Release (mapping retire, or a new version that no longer maps
--      the object) sets connection_id NULL: no DELETE.
--   2. CHECKs (key format, registry kind, held / released shape) and the guard
--      trigger (identity immutable; an owner change passes through released —
--      no direct handover from one connection to another).
--   3. Backfill from the currently published mappings (lifecycle state
--      `published`), refused with a clear error when existing data already
--      violates single ownership or names a custom object the registry lacks.
--   4. Forced RLS, the tenant policy, tenant-id immutability and privileges
--      (SELECT / INSERT / UPDATE; no DELETE).

-- ---------------------------------------------------------------------------
-- Prisma-generated structure
-- ---------------------------------------------------------------------------
-- CreateTable
CREATE TABLE "tenant_custom_object_owners" (
    "tenant_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "registry_kind" TEXT NOT NULL DEFAULT 'extension',
    "connection_id" UUID,
    "mapping_version" INTEGER,
    "claimed_at" TIMESTAMPTZ(3),
    "released_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- MUTATION VM2: primary key dropped (non-unique index instead)
CREATE INDEX "mut_owner_key" ON "tenant_custom_object_owners"("tenant_id", "object_key");

-- CreateIndex
CREATE INDEX "tenant_custom_object_owners_tenant_id_connection_id_mapping_idx" ON "tenant_custom_object_owners"("tenant_id", "connection_id", "mapping_version");

-- AddForeignKey
ALTER TABLE "tenant_custom_object_owners" ADD CONSTRAINT "tenant_custom_object_owners_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_object_owners" ADD CONSTRAINT "tenant_custom_object_owners_tenant_id_registry_kind_object_fkey" FOREIGN KEY ("tenant_id", "registry_kind", "object_key") REFERENCES "tenant_registry_entries"("tenant_id", "kind", "key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_object_owners" ADD CONSTRAINT "tenant_custom_object_owners_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "tenant_source_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "tenant_custom_object_owners" ADD CONSTRAINT "tenant_custom_object_owners_tenant_id_connection_id_mappin_fkey" FOREIGN KEY ("tenant_id", "connection_id", "mapping_version") REFERENCES "tenant_source_mapping_versions"("tenant_id", "connection_id", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 2. CHECKs and the guard trigger
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_custom_object_owners"
  ADD CONSTRAINT "tenant_custom_object_owners_key_format" CHECK ("object_key" ~ '^[a-z][a-z0-9_]{0,62}$'),
  ADD CONSTRAINT "tenant_custom_object_owners_registry_kind" CHECK ("registry_kind" = 'extension'),
  -- Held: an owner, its published mapping version, claimed, not released.
  -- Released: no owner, no version, released_at set.
  ADD CONSTRAINT "tenant_custom_object_owners_state_shape" CHECK (
    ("connection_id" IS NOT NULL AND "mapping_version" IS NOT NULL AND "claimed_at" IS NOT NULL AND "released_at" IS NULL)
    OR ("connection_id" IS NULL AND "mapping_version" IS NULL AND "released_at" IS NOT NULL));

CREATE FUNCTION "app_custom_object_owner_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.object_key IS DISTINCT FROM OLD.object_key OR NEW.registry_kind IS DISTINCT FROM OLD.registry_kind THEN
    RAISE EXCEPTION 'custom_object_owner_identity_immutable' USING ERRCODE = 'check_violation',
      DETAIL = format('custom object %s', OLD.object_key);
  END IF;
  -- Q14: ownership moves only through released (publish / retire of the owner).
  IF OLD.connection_id IS NOT NULL AND NEW.connection_id IS NOT NULL
     AND NEW.connection_id IS DISTINCT FROM OLD.connection_id THEN
    RAISE EXCEPTION 'custom_object_owned_by_other_connection' USING ERRCODE = 'check_violation',
      DETAIL = format('custom object %s', OLD.object_key);
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION "app_custom_object_owner_guard"() FROM PUBLIC;
CREATE TRIGGER "tenant_custom_object_owners_guard" BEFORE UPDATE ON "tenant_custom_object_owners"
  FOR EACH ROW EXECUTE FUNCTION app_custom_object_owner_guard();

-- ---------------------------------------------------------------------------
-- 3. Backfill from the currently published mappings (refused on violation)
-- ---------------------------------------------------------------------------
-- A connection's published mapping is the version whose latest lifecycle
-- event is `published` (M10A2: at most one per connection). Each of its
-- `custom_object:<key>` objects is a claim; claimed_at is that version's
-- published_at.
DO $$
DECLARE
  bad record;
  claims bigint;
  rows_n bigint;
BEGIN
  CREATE TEMP TABLE m10d_h83_claims ON COMMIT DROP AS
  WITH states AS (
    SELECT DISTINCT ON (l."tenant_id", l."connection_id", l."version")
           l."tenant_id", l."connection_id", l."version", l."state"
      FROM "tenant_source_mapping_lifecycle" l
     ORDER BY l."tenant_id", l."connection_id", l."version", l."seq" DESC
  )
  SELECT DISTINCT v."tenant_id", substr(o ->> 'entity', 15) AS "object_key", v."connection_id",
         v."version", v."published_at"
    FROM states s
    JOIN "tenant_source_mapping_versions" v
      ON v."tenant_id" = s."tenant_id" AND v."connection_id" = s."connection_id" AND v."version" = s."version"
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v."document" -> 'objects') = 'array'
                                                THEN v."document" -> 'objects' ELSE '[]'::jsonb END) o
   WHERE s."state" = 'published' AND o ->> 'entity' LIKE 'custom\_object:%';

  -- Q14 already violated: two connections' published mappings source one custom object.
  FOR bad IN
    SELECT "tenant_id", "object_key", count(DISTINCT "connection_id") AS n
      FROM m10d_h83_claims GROUP BY "tenant_id", "object_key"
    HAVING count(DISTINCT "connection_id") > 1
     ORDER BY 1, 2 LIMIT 1
  LOOP
    RAISE EXCEPTION 'M10D hardening #83 refused: custom object % of tenant % is sourced by % connections'' published mappings (Q14 single owner); retire all but one of those mappings, then re-run the migration',
      bad."object_key", bad."tenant_id", bad.n;
  END LOOP;

  -- A published mapping naming a custom object the tenant's registry does not hold.
  FOR bad IN
    SELECT c."tenant_id", c."object_key"
      FROM m10d_h83_claims c
     WHERE NOT EXISTS (SELECT 1 FROM "tenant_registry_entries" e
                        WHERE e."tenant_id" = c."tenant_id" AND e."kind" = 'extension' AND e."key" = c."object_key")
     ORDER BY 1, 2 LIMIT 1
  LOOP
    RAISE EXCEPTION 'M10D hardening #83 refused: a published mapping of tenant % sources custom object %, which has no extension registry entry',
      bad."tenant_id", bad."object_key";
  END LOOP;

  INSERT INTO "tenant_custom_object_owners"
    ("tenant_id", "object_key", "registry_kind", "connection_id", "mapping_version", "claimed_at", "updated_at")
  SELECT "tenant_id", "object_key", 'extension', "connection_id", "version", "published_at", CURRENT_TIMESTAMP
    FROM m10d_h83_claims;

  -- Parity: one owner row per claimed (tenant, object).
  SELECT count(*) INTO claims FROM (SELECT DISTINCT "tenant_id", "object_key" FROM m10d_h83_claims) x;
  SELECT count(*) INTO rows_n FROM "tenant_custom_object_owners";
  IF claims <> rows_n THEN
    RAISE EXCEPTION 'M10D hardening #83 backfill mismatch: % claims, % owner rows', claims, rows_n;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Tenant isolation and privileges
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_custom_object_owners" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_custom_object_owners" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_custom_object_owners"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE TRIGGER "tenant_custom_object_owners_tenant_immutable" BEFORE UPDATE ON "tenant_custom_object_owners"
  FOR EACH ROW EXECUTE FUNCTION app_prevent_tenant_change();
REVOKE ALL ON TABLE "tenant_custom_object_owners" FROM lip_app;
-- Owners are claimed and released in place, never deleted.
GRANT SELECT, INSERT, UPDATE ON TABLE "tenant_custom_object_owners" TO lip_app;
