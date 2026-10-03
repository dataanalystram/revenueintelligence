# ADR 0019: Source connectors — connector-kind catalogue, source connections, generic port, schema snapshots (Milestone 8)

- Status: accepted (M8 implementation; plan approved 2026-10-02, `a8b61fb`)
- Date: 2026-10-03

## Context

Until M7 the platform knew a closed list of systems (`hubspot`, `sugar`,
`gainsight_cs`, `gainsight_px`, plus `import` for M7 subscriptions), repeated
as a TypeScript enum and as database CHECK lists on about ten tables. HubSpot
reached the platform through a CRM-shaped port (`CrmReader`, ADR 0010). The
approved [canonical extension and source mapping design](../architecture/canonical-extension-and-source-mapping.md)
requires that a new source (Salesforce, Snowflake, …) is onboarded by adding an
adapter and configuration, never by changing the canonical core.

## Decision

1. **Connector-kind catalogue.** Connector kinds are declared in code
   (`domain/connector-kinds.ts`) and mirrored by the platform reference table
   `connector_kinds` (no tenant; the application role may only read it). Every
   source-system column references `connector_kinds(kind)` by foreign key; the
   duplicated CHECK lists are gone. Values are unchanged (`sugar` stays
   `sugar`); no stored data is rewritten. A new kind is one catalogue entry, one
   `INSERT` migration and its adapter module. Arbitrary strings are impossible:
   the foreign key refuses an unknown kind.
2. **Source connections.** `tenant_source_connections` holds one row per
   tenant and connector kind (one connection per kind in M8): label, status
   (`enabled`/`disabled`), mapping mode (`versioned` for adapters driven by
   mapping versions, `code` for HubSpot and `import`), adapter-validated
   non-secret configuration, and a **credential name** registered through
   `tenant_credential_refs`. Credential values are only ever read through
   `SecretProvider`. Tenant ownership is immutable, RLS is forced.
3. **Generic connector port** (`domain/source-connector.ts`):
   `capabilities()`, `testConnection()`, `describeSchema()`,
   `readRecords(request)` and an optional, capability-dependent
   `readRecord()`. Capabilities are declared per object (pagination, change
   field, delete visibility, counts). Normal synchronisation never depends on
   `readRecord`. Coverage is **not** part of the port: completeness is a
   platform decision (ADR 0020). The existing `CrmReader` stays as the CRM
   specialisation for M6 context processing.
4. **Adapter registration.** Adapters register under their kind
   (`SOURCE_ADAPTERS`). A process that synchronises refuses to start a run for
   a connection whose kind has no registered adapter.
5. **Schema snapshots.** `describeSchema()` output is normalised into an
   immutable, hashed, metadata-only snapshot per connection: objects, fields,
   types, enum options, relationships, identity indicators, per-object change
   and delete capabilities. Snapshots never hold record values. Mapping
   versions reference the snapshot they were validated against.
6. **Schema drift.** Before any canonical write, a run compares the mapped
   surface of the current schema with the mapping's snapshot. A removed or
   retyped mapped field or object stops the run (`schema_drift`), coverage
   unchanged. Drift detected inside a run (a page missing a mapped field) fails
   the run safely. Nothing is reinterpreted. Live-schema atomicity is not
   claimed.

## Consequences

- Customer B's Salesforce or Snowflake needs a catalogue entry, an adapter,
  a connection and a mapping; Product, Subscription and Eligibility are
  untouched.
- One migration replaces the CHECK lists with foreign keys; existing HubSpot,
  context and M7 behaviour is unchanged.
- Several connections of one kind (two Salesforce orgs, sandbox and
  production) are deferred.

## Alternatives considered

- Free-text system strings validated only in code: rejected (no database
  guarantee).
- Regenerating CHECK lists per new kind: rejected (ten constraints to rewrite
  per adapter).
- Making Sugar implement `CrmReader`: rejected (a CRM context port, not a
  subscription-source contract).
