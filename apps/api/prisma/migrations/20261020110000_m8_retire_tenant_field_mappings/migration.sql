-- Milestone 8 (ADR 0020 §19): retire the M2 legacy table tenant_field_mappings.
--
-- Its only content in any environment is the Juniper template's ten Sugar
-- Leads rows: OUTBOUND/BIDIRECTIONAL write intent for the future lead
-- handover (M15), not inbound source mappings. That intent is preserved
-- verbatim in docs/integrations/sugar/lead-handover-field-intent.md and is not
-- converted into M8 mapping versions.
--
-- No data loss: the migration refuses (and changes nothing) unless every
-- stored row is exactly one of the documented template rows, none is
-- `confirmed`, and none carries a value map. Every dropped row is therefore
-- reproducible from the intent document. Operators who want a raw export
-- first can run prisma/rollback/20261020110000_m8_retire_tenant_field_mappings.export.sql.

DO $$
DECLARE
  total integer;
  unexpected integer;
BEGIN
  CREATE TEMP TABLE m8_legacy_template_rows (
    system text, object_type text, canonical_entity text, canonical_field text,
    external_field text, direction text, status text, notes text
  ) ON COMMIT DROP;
  INSERT INTO m8_legacy_template_rows VALUES
    ('sugar', 'Leads', 'lead', 'stage', 'status', 'bidirectional', 'proposed', 'Brief D.2: existing static Status field. Picklist translation and velocity reporting via the stage-date fields still to be confirmed.'),
    ('sugar', 'Leads', 'lead', 'lead_type', NULL, 'outbound', 'tbc', 'Brief D.2: check whether an equivalent picklist already exists.'),
    ('sugar', 'Leads', 'lead', 'source_label', NULL, 'outbound', 'tbc', 'Brief: Heat indicators; values should match the Pathway 1 trigger list.'),
    ('sugar', 'Leads', 'lead', 'temperature', NULL, 'bidirectional', 'tbc', 'Brief: Lead Label (Hot/Warm/Cold). Sales edits in Sugar sync back.'),
    ('sugar', 'Leads', 'lead', 'disqualified_reason', NULL, 'bidirectional', 'tbc', 'Brief: picklist only, identical values both sides.'),
    ('sugar', 'Leads', 'lead', 'date_entered_new', NULL, 'outbound', 'tbc', 'Brief: new field required in Sugar.'),
    ('sugar', 'Leads', 'lead', 'date_entered_attempting', NULL, 'outbound', 'tbc', 'Brief: new field required in Sugar.'),
    ('sugar', 'Leads', 'lead', 'date_entered_connected', NULL, 'outbound', 'tbc', 'Brief: new field required in Sugar.'),
    ('sugar', 'Leads', 'lead', 'date_entered_qualified', NULL, 'outbound', 'tbc', 'Brief: new field required in Sugar.'),
    ('sugar', 'Leads', 'lead', 'date_entered_disqualified', NULL, 'outbound', 'tbc', 'Brief: new field required in Sugar.');

  SELECT count(*) INTO total FROM "tenant_field_mappings";
  IF EXISTS (SELECT 1 FROM "tenant_field_mappings" WHERE "status" = 'confirmed') THEN
    RAISE EXCEPTION 'M8 legacy retirement refused: confirmed field mappings exist (export and review them first)';
  END IF;
  IF EXISTS (SELECT 1 FROM "tenant_field_mappings" WHERE "value_map" <> '{}'::jsonb) THEN
    RAISE EXCEPTION 'M8 legacy retirement refused: field mappings with value maps exist (export and review them first)';
  END IF;
  SELECT count(*) INTO unexpected
    FROM "tenant_field_mappings" f
   WHERE NOT EXISTS (
     SELECT 1 FROM m8_legacy_template_rows t
      WHERE t.system = f."system" AND t.object_type = f."object_type"
        AND t.canonical_entity = f."canonical_entity" AND t.canonical_field = f."canonical_field"
        AND t.external_field IS NOT DISTINCT FROM f."external_field"
        AND t.direction = f."direction" AND t.status = f."status"
        AND t.notes IS NOT DISTINCT FROM f."notes");
  IF unexpected > 0 THEN
    RAISE EXCEPTION 'M8 legacy retirement refused: % field mapping row(s) differ from the documented template rows (export and review them first)', unexpected;
  END IF;
  RAISE NOTICE 'M8 legacy retirement: % template field mapping row(s) verified against the intent document; dropping tenant_field_mappings', total;
END
$$;

DROP TABLE "tenant_field_mappings";
