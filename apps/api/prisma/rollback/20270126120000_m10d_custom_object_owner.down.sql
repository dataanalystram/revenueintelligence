-- Down-script for 20270126120000_m10d_custom_object_owner (M10D hardening #83,
-- ADR 0030 addendum). Development and staging only: production policy is
-- forward-fix. Run with the owner credentials, before the M10E down-script:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/rollback/20270126120000_m10d_custom_object_owner.down.sql
--
-- The owner table is a structural guard over a fact the published mappings
-- already hold, so dropping it loses no data the pre-#83 schema cannot hold:
-- without it, the Q14 owner is derived from the published mappings again.
-- The script therefore refuses (and changes nothing) only when the two
-- disagree, because rolling back would then silently change which connection
-- may source a custom object:
--   * a held owner row that the owner's published mapping does not support
--     (no published mapping, another version, or the object not mapped), or
--   * a published mapping sourcing a custom object without the matching held
--     owner row.
-- Released rows (history) are dropped with the table; the mapping.publish /
-- mapping.retire audit events keep who claimed and released what.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  CREATE TEMP TABLE m10d_h83_down_claims ON COMMIT DROP AS
  WITH states AS (
    SELECT DISTINCT ON (l."tenant_id", l."connection_id", l."version")
           l."tenant_id", l."connection_id", l."version", l."state"
      FROM "tenant_source_mapping_lifecycle" l
     ORDER BY l."tenant_id", l."connection_id", l."version", l."seq" DESC
  )
  SELECT DISTINCT v."tenant_id", substr(o ->> 'entity', 15) AS "object_key", v."connection_id", v."version"
    FROM states s
    JOIN "tenant_source_mapping_versions" v
      ON v."tenant_id" = s."tenant_id" AND v."connection_id" = s."connection_id" AND v."version" = s."version"
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v."document" -> 'objects') = 'array'
                                                THEN v."document" -> 'objects' ELSE '[]'::jsonb END) o
   WHERE s."state" = 'published' AND o ->> 'entity' LIKE 'custom\_object:%';

  SELECT count(*) INTO n FROM "tenant_custom_object_owners" w
   WHERE w."connection_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM m10d_h83_down_claims c
                      WHERE c."tenant_id" = w."tenant_id" AND c."object_key" = w."object_key"
                        AND c."connection_id" = w."connection_id" AND c."version" = w."mapping_version");
  IF n > 0 THEN
    RAISE EXCEPTION 'refusing rollback: % custom object owner rows are not supported by their owner''s published mapping', n;
  END IF;

  SELECT count(*) INTO n FROM m10d_h83_down_claims c
   WHERE NOT EXISTS (SELECT 1 FROM "tenant_custom_object_owners" w
                      WHERE w."tenant_id" = c."tenant_id" AND w."object_key" = c."object_key"
                        AND w."connection_id" = c."connection_id" AND w."mapping_version" = c."version");
  IF n > 0 THEN
    RAISE EXCEPTION 'refusing rollback: % published custom object mappings have no matching owner row', n;
  END IF;
END
$$;

DROP TABLE "tenant_custom_object_owners";
DROP FUNCTION "app_custom_object_owner_guard"();

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270126120000_m10d_custom_object_owner';

COMMIT;
