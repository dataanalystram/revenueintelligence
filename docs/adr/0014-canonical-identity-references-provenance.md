# ADR 0014: Canonical identity, external references and provenance (Milestone 6)

- Status: accepted
- Date: 2026-10-01

## Context

M6 creates canonical companies and people from HubSpot. The charter requires
platform-owned identity with external systems as cross-references, and every
fact traceable to its source. The M1/M2 model required `Company.name` and a
tenant-unique `Person.primaryEmail`, which HubSpot data does not guarantee
and which would make email an identity key. The owner approved (2026-10-01):
nullable company name, nullable person email, no email-based merging.

## Decision

### 1. Platform ids are canonical; external ids are references

- `companies.id` and `persons.id` are platform UUIDs. A HubSpot id appears
  only in `company_external_refs` / `person_external_refs`, unique per
  `(tenant, system, object_type, external_id)`.
- Future Sugar Accounts or Gainsight Companies attach as further reference
  rows pointing at the same canonical record (`system` is limited to the
  canonical `ExternalSystem` values). No schema change is needed.
- M6 resolves identity **only** by external reference: found → that record
  (following merge lineage); not found → a new canonical record. No
  cross-system matching rules exist in M6.

### 2. Nullable name and email; email is not identity

- `Company.name` is nullable; no placeholder is ever stored.
- `Person.primaryEmail` is nullable and normalised when present. The
  tenant-wide unique constraint is replaced by a non-unique lookup index.
  Two people are never merged because their emails match; a shared email is
  recorded in `tenant_identity_conflicts` (`shared_email`) for later review.

### 3. Record state and lineage

- `record_state`: `active`, `inactive` (every source reference deleted),
  `merged` (with `merged_into_id`). Canonical records are never hard-deleted
  by ingestion.
- References carry `state` (`active` / `deleted` / `merged`),
  `merged_into_external_id`, `first_seen_at`, `last_seen_at`,
  `source_created_at`, `source_updated_at`, `deleted_at`, `field_hash` and
  `last_change_id`.

### 4. One canonical writer

`ContextIngestionService.ingest(ctx, observation)` is the only code that
writes canonical companies, people, references and relationships. Webhook
receipts, backfill pages and reconciliation pages all produce
vendor-neutral `SourceObservation`s and call it (a dependency rule keeps
the repository private to it).

Inside one tenant transaction it:

1. locks the reference row (inserting it first if new);
2. compares the observation with the stored `source_updated_at` and
   `field_hash` (pure function): newer → apply; older → stale no-op; same
   time and hash → unchanged no-op; a deletion tombstone is not revived by an
   observation older than its deletion time;
3. writes the canonical record, the reference and relationships;
4. appends one provenance row per real change.

Any failure rolls back the whole transaction.

### 5. Lifecycle semantics

- **Delete**: reference → `deleted` (`deleted_at` = source time); the record
  becomes `inactive` when no active reference remains. History stays.
- **Restore**: read-back confirms the record; reference → `active`.
- **Merge**: survivor = `newObjectId` or `primaryObjectId`; merged
  references → `merged` with `merged_into_external_id`. A canonical record
  whose references all come from the same system is merged forward
  (`record_state = merged`, `merged_into_id`, references re-pointed). If it
  also has references from another system, nothing is merged and an
  identity conflict (`merge_across_systems`) is recorded.
- **Association change**: re-read the contact's company associations;
  update `tenant_source_relationships` and `Person.companyId` (primary
  association only). No business logic.

### 6. Provenance

Append-only `tenant_context_changes`, one row per real canonical change:
entity kind and id, change type, changed field **names** (no values), source
system, object type and record id, cause (`webhook`, `backfill`,
`reconciliation`, `replay`), receipt delivery key or checkpoint id, source
timestamp, ingestion timestamp, adapter and adapter version, correlation id.
Values live only in the canonical record. This is source-record provenance
for context, not the M10 fact/signal model.

### 7. Read-back is the truth

A webhook receipt never creates or changes canonical data by itself: the
subject is read from HubSpot first. A receipt naming an object HubSpot does
not return is recorded `source_not_found` and changes nothing.

## Consequences

- Pre-M6 code cannot read rows with a null name or email; rollback after
  such rows exist uses the runtime switch (ADR 0013), not a code downgrade.
- `PersonRepository.findByEmail` becomes `listByEmail`.
- Customer lifecycle mapping (`customerStatus`, roles) stays tenant
  configuration (`tbc`); M6 leaves `customerStatus` as `unknown`.
