-- Milestone 9B: the Chargebee reference adapter (ADR 0024).
--
-- 1. One reference-data row: the connector kind `chargebee` (versioned
--    mapping, external references, adapter shipped). Mirrors
--    CONNECTOR_KIND_CATALOGUE (parity-tested). Every source-system column
--    already references connector_kinds by foreign key.
-- 2. `chargebee` joins the integration systems (IntegrationSystemSchema), so
--    its read-only API key can be registered as a credential NAME (the value
--    stays in the SecretProvider). The two system CHECKs are widened by
--    exactly that value.
-- 3. Read-only by construction: a Chargebee integration can never be granted
--    `read_write` access (the adapter has no write path either).

INSERT INTO "connector_kinds" ("kind", "display_name", "has_adapter") VALUES
  ('chargebee', 'Chargebee', true);

ALTER TABLE "tenant_integrations"
  DROP CONSTRAINT "tenant_integrations_system_valid",
  ADD CONSTRAINT "tenant_integrations_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px', 'jev', 'chargebee')),
  ADD CONSTRAINT "tenant_integrations_chargebee_read_only" CHECK ("system" <> 'chargebee' OR "access" IN ('disabled', 'read_only'));

ALTER TABLE "tenant_credential_refs"
  DROP CONSTRAINT "tenant_credential_refs_system_valid",
  ADD CONSTRAINT "tenant_credential_refs_system_valid" CHECK ("system" IN ('hubspot', 'sugar', 'gainsight_cs', 'gainsight_px', 'jev', 'chargebee'));
