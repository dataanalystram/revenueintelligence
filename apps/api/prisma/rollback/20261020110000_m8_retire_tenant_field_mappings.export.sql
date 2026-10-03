-- Optional raw export of tenant_field_mappings BEFORE applying
-- 20261020110000_m8_retire_tenant_field_mappings (Milestone 8). Owner credentials:
--
--   psql "$MIGRATION_DATABASE_URL" -At -f prisma/rollback/20261020110000_m8_retire_tenant_field_mappings.export.sql > legacy-field-mappings.json
--
-- Prints one JSON array (identifiers, field names, statuses and notes; no
-- customer record values exist in this table).
SELECT coalesce(json_agg(json_build_object(
  'tenantId', "tenant_id", 'system', "system", 'objectType', "object_type",
  'canonicalEntity', "canonical_entity", 'canonicalField', "canonical_field",
  'externalField', "external_field", 'direction', "direction", 'status', "status",
  'valueMap', "value_map", 'notes', "notes") ORDER BY "tenant_id", "canonical_field"), '[]'::json)
FROM "tenant_field_mappings";
