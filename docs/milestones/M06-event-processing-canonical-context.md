# Milestone 6 — Event processing and canonical account context

- Status: **implemented, awaiting independent review** (plan approved
  2026-10-01: "PASS — M6 PLAN APPROVED FOR IMPLEMENTATION"). The
  [implementation record](#implementation-record) at the end lists what was
  built, deviations from this plan, evidence and open items. Live evidence on
  the test account is owner-run and still outstanding.
- Base: `main` at `51c62c9` (PR #7 merged: approved
  [charter](../product/revenue-opportunity-intelligence.md),
  [roadmap](../product/roadmap.md),
  [ADR 0012](../adr/0012-revenue-opportunity-intelligence-direction.md)).
- Independent plan review (2026-10-01): **PASS WITH CHANGES**. Two gates
  added: the search endpoint/version hard precondition (Gate 1, section 21)
  and the removal of privacy deletion from M6 (Gate 2, sections 23 and 30).
- Owner decisions already taken for this plan (2026-10-01):
  1. canonical companies may have no name;
  2. canonical people may have no email; email is not identity;
  3. HubSpot deletion, merge and association-change events: approved
     **conditionally** on documentation (section 23);
  4. HubSpot CRM search for reconciliation: approved with a strict, exact
     read-only allow-list;
  5. read-only initial backfill of Companies and Contacts: approved;
  6. processing of receipts stored during M5: approved, with explicit
     eligibility.
- Queue technology: **BullMQ + Redis** (ADR 0012).

Evidence labels used below: **DOCUMENTED** (HubSpot documentation, via web
search; direct page fetch is blocked by this environment's network policy),
**INFERRED** (follows from documented patterns, to be confirmed against the
docs before implementation), **UNCONFIRMED**.

---

## 1. Objective

Turn source data from HubSpot (webhook receipts, an initial backfill, and
reconciliation reads) into tenant-isolated canonical **Account (Company)**
and **Person** context through **one** canonical ingestion path, with
platform-owned ids, source cross-references and provenance. Processing is
durable, idempotent, retryable, dead-lettered when it cannot succeed, and
replayable.

M6 is foundational context ingestion. It does not detect opportunities.

## 2. Business capability delivered

The platform can answer, for any HubSpot event or record:

> Which canonical account or person does this represent, where did it come
> from, and can the platform process, retry, reconcile and replay it safely?

Concretely:

- existing HubSpot companies and contacts are loaded once (backfill), then
  kept current by webhooks and periodic reconciliation;
- every canonical change is traceable to its source record, triggering
  event, source time, ingestion time and adapter version;
- nothing is lost when Redis, the worker, PostgreSQL or HubSpot fails;
  failures are visible, bounded and replayable;
- the receipts stored since M5 are consumed, proving the durable intake.

## 3. Inputs from M5

| Input                     | State on `main`                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenant_webhook_receipts` | identifier-only rows: system, delivery key (SHA-256), event id, subscription id, account id, app id, subscription type, object type id, object id, property name, change source, occurred at, attempt numbers, deliveries; atomic de-duplication; forced RLS |
| Event parser              | keeps identifiers only; drops values and unknown fields (merge and association identifiers are currently dropped)                                                                                                                                            |
| App subscriptions         | `object.creation` + selected `object.propertyChange` for contact, company and lead; **no** deletion, merge, restore or association-change subscriptions                                                                                                      |
| `CrmReader` port          | `getRecord`, `listRecords` (paged `GET /crm/objects/2026-09/{type}`), `readAssociations` (batch-read POST, allow-listed), field and association definitions                                                                                                  |
| Transport guard           | GET always; POST only for `^/crm/associations/[\w-]+/[\w-]+/[\w-]+/batch/read$`; path traversal refused                                                                                                                                                      |
| Snapshots                 | person: email (normalised, optional), first/last name, job title; company: name (optional), domain; both: ref, created/updated at, archived                                                                                                                  |
| Canonical tables          | `companies` (name **required**), `persons` (primary email **required, unique per tenant**), `company_external_refs`, `person_external_refs` (PK `tenant, system, object_type, external_id`)                                                                  |
| Worker process            | starts with no processors; `ioredis` health client; Compose Redis with AOF                                                                                                                                                                                   |
| OAuth                     | per-tenant token source with cross-process refresh lock, usable from the worker                                                                                                                                                                              |

## 4. Event-processing architecture

One canonical write path after source adaptation:

```
                     ┌─ webhook receipts ──▶ receipt.process ─┐
HubSpot adapters ────┼─ initial backfill ──▶ backfill.page ───┼─▶ read-back / page snapshot (HubSpot module)
                     └─ reconciliation ────▶ reconcile.page ──┘          │
                                                                          ▼
                                            normalise → SourceObservation (vendor-neutral, domain)
                                                                          │
                                                                          ▼
                              ContextIngestionService.ingest(ctx, observation)   ← the ONLY canonical writer
                                   │  resolve identity via external refs (pure)
                                   │  apply if newer (pure)
                                   │  upsert canonical + refs + relationships
                                   │  append provenance change
                                   ▼  (one tenant transaction)
                       companies / persons / *_external_refs / tenant_context_changes
```

Lifecycle of a webhook event, with failure behaviour per transition:

| Step                                     | What happens                                                        | Failure behaviour                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. HubSpot delivery                      | M5 verifies signature, payload, app id, routes to tenant            | unchanged M5 behaviour (401/400/413; HubSpot retries non-2xx)                                                                                                                       |
| 2. Durable receipt                       | receipt stored, `processing_status = pending`                       | DB error → non-2xx → HubSpot retries; duplicates de-duplicated                                                                                                                      |
| 3. Job created                           | after commit, API enqueues `receipt.process` (best effort)          | Redis down → logged + metric; receipt stays `pending`; the sweep enqueues it later. The HTTP response is not affected                                                               |
| 4. Worker consumes                       | payload validated (Zod); tenant context issued; receipt claimed     | invalid payload → poison → dead letter; inactive tenant / not found (RLS) → dead letter; already processed → no-op                                                                  |
| 5. Eligibility + translation             | pure eligibility check; translator maps to subject(s)               | ineligible → `ineligible` + reason, no canonical write; lead/other → `deferred`                                                                                                     |
| 6. Read-back                             | `CrmReader.getRecord` (and associations) outside any DB transaction | 429/5xx/network → retry with backoff; 401 → token refresh then retry; record not found → deletion/`source_not_found` handling (never creates a record); grant revoked → dead letter |
| 7. Normalise                             | snapshot → `SourceObservation`                                      | validation failure → poison → dead letter                                                                                                                                           |
| 8. Resolve + apply + upsert + provenance | one tenant transaction, subject row locked                          | any error → whole transaction rolls back (no partial upsert) → retry; serialisation/deadlock → retry                                                                                |
| 9. Mark processed                        | in the same transaction as step 8                                   | crash after commit but before job ack → BullMQ re-delivers (stalled) → step 4 sees `processed` → no-op                                                                              |

**PostgreSQL is the source of truth; Redis is transport.** No state exists
only in Redis. Redis payloads hold identifiers only.

## 5. BullMQ + Redis design

- Dependency: `bullmq` latest 5.x at implementation (exact version and API,
  including the deduplication and job-scheduler options, verified against
  its documentation then). Not installed before plan approval.
- New `platform/queue` module owns every BullMQ import (enforced by a new
  dependency-cruiser rule). Modules use a small port: `QueueProducer.add`
  and `registerProcessor(queue, handler)`.
- Connections: separate BullMQ connections with BullMQ's recommended
  settings (`maxRetriesPerRequest: null` for workers); the existing
  fail-fast health client is unchanged.
- Prefix `QUEUE_PREFIX` (default `lip`).
- **Start-up check**: Redis `maxmemory-policy` must be `noeviction`
  (BullMQ requirement); the worker refuses to start otherwise. Compose sets
  `--maxmemory-policy noeviction` alongside AOF.
- **Concurrency** (configurable): `lip-receipts` 8, `lip-sync` 4,
  `lip-bulk` 1 per tenant (paging is sequential by design).
- **HubSpot rate limits**: existing per-tenant limiter for normal calls;
  a dedicated search limiter (≤ 3 requests/s per HubSpot account; the
  search burst limit is 5/s per account and search responses carry no
  rate-limit headers, DOCUMENTED).
- **Retention**: completed jobs removed after 1 h / 1 000; failed kept
  7 days / 10 000. The durable failure record is `tenant_dead_letters`.
- **Graceful shutdown**: on SIGTERM the worker stops taking jobs and
  `close()` waits for active jobs up to `SHUTDOWN_TIMEOUT`; then
  connections close. Integrated with the existing lifecycle hooks.
- **Stalled jobs**: re-delivered by BullMQ (`maxStalledCount` 2); handlers
  are idempotent. A job that stalls repeatedly (it crashes the worker) fails
  and is dead-lettered as a poison job.
- **Job ids** never contain `:`; they are hex hashes of tenant-scoped
  identifiers.
- **Observability hooks**: queue events feed metrics (section 25).

## 6. Queue/job definitions

All payloads are Zod-validated at the consumer; identifiers only (no names,
emails or property values; no credentials or tokens).

| Queue          | Job               | Payload                                                                                     | Id / deduplication                                                        | Producer                     |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| `lip-receipts` | `receipt.process` | `v, tenantId, system, deliveryKey, correlationId, traceparent?, replay?`                    | `rcpt-<sha256(tenant,system,deliveryKey)>`; replay adds `-r<n>`           | API after commit; sweep; CLI |
| `lip-sync`     | `subject.sync`    | `v, tenantId, system, kind (company/person), externalId, cause, correlationId, receiptKey?` | BullMQ deduplication id `sync-<sha256(tenant,system,kind,id)>`, short TTL | receipt.process; CLI         |
| `lip-bulk`     | `backfill.page`   | `v, tenantId, system, kind, checkpointId, correlationId`                                    | `bf-<checkpointId>-<pageNo>`                                              | CLI; previous page           |
| `lip-bulk`     | `reconcile.page`  | `v, tenantId, system, kind, checkpointId, correlationId`                                    | `rc-<checkpointId>-<pageNo>`                                              | scheduler; CLI               |
| `lip-bulk`     | `tenant.sweep`    | `v, tenantId`                                                                               | job scheduler per active tenant (every 5 min)                             | scheduler                    |

Page jobs read the cursor from `tenant_sync_checkpoints` (PostgreSQL), not
from the payload, so a stale job cannot rewind progress.

## 7. Tenant isolation

- A payload's `tenantId` is never trusted as a context. Every job calls
  `TenantContextService.forTenantId` (tenant exists and is **active**) and
  runs all reads and writes in `TenantDatabase.transaction(ctx, …)` as
  `lip_app` under forced RLS.
- The receipt is loaded under RLS; a job naming tenant A with tenant B's
  delivery key finds nothing → non-retryable dead letter
  (`receipt_not_found`).
- The receipt's `account_id` and `app_id` must match the tenant's connected
  portal and configured app (eligibility, section 22). A webhook from
  tenant A's portal can only ever be routed to tenant A (M5 router) and can
  only mutate tenant A's rows (RLS).
- The HubSpot reader comes from `HubSpotConnector.forTenant(ctx)`; tokens are
  fetched inside the worker from the encrypted store, never placed in Redis.
- Replays and retries carry the same tenant id and re-issue the context, so
  they cannot change scope.
- Every new table has `tenant_id`, a forced RLS policy, tenant-leading keys
  and `lip_app` grants; the schema-guard test fails otherwise.
- The sweep lists active tenants through a new tenancy-module method (the
  root client stays inside tenancy).

## 8. Idempotency

| Layer      | Mechanism                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Intake     | M5 atomic `ON CONFLICT` on `(tenant, system, delivery_key)`                                                                                                                                                                                            |
| Enqueue    | deterministic job ids / deduplication ids                                                                                                                                                                                                              |
| Claim      | conditional `UPDATE … WHERE processing_status IN ('pending','retrying')`; processed, ineligible, deferred and dead-lettered receipts are skipped                                                                                                       |
| Apply      | external ref row locked (`SELECT … FOR UPDATE`, or inserted with `ON CONFLICT DO NOTHING` then locked); observation applied only if `source_updated_at` is newer than the stored one, or equal with a different field hash; otherwise a recorded no-op |
| Provenance | one `tenant_context_changes` row per real change (no row for a no-op)                                                                                                                                                                                  |
| Bulk       | checkpoint cursor advanced in the same transaction as the page's ingestion                                                                                                                                                                             |

Duplicate, concurrent, replayed, stale and out-of-order inputs therefore
converge to the latest HubSpot state, with exactly one provenance row per
real change.

## 9. Retry/backoff

- Classification (pure function, unit-tested):
  - **retryable**: network errors and timeouts; HubSpot 429 (respects
    `Retry-After` when present); 5xx; token-refresh contention; PostgreSQL
    connection loss, serialisation failure, deadlock; Redis transient
    errors;
  - **non-retryable** (BullMQ `UnrecoverableError`, immediate dead letter):
    payload validation failure; unknown or inactive tenant; receipt not found;
    account/app mismatch; grant revoked or missing; HubSpot 4xx other than
    401-after-refresh and 429; source data failing boundary validation.
- Attempts: 8; exponential backoff 5 s × 2ⁿ with ±20 % jitter, capped at
  10 min (≈ 35 min total). The HubSpot HTTP client keeps its small inner
  retry so the layers do not multiply.
- Grant revoked: the tenant's jobs fail fast (`grant_unavailable`) and are
  replayable after reconnection; no HubSpot hammering.
- Bulk jobs retry the page, not the run; the checkpoint guarantees no gaps
  or double-advances.

## 10. Dead-letter handling

- On final failure (attempts exhausted, unrecoverable, or stalled too often)
  the worker writes `tenant_dead_letters` in the tenant transaction and sets
  the receipt to `dead_lettered` (when there is one).
- Columns (identifiers only, CHECK-constrained): id, tenant, queue, job
  name, subject (system, kind, external id), receipt delivery key,
  checkpoint id, correlation id, error code (enum), HTTP status, attempts,
  first/last failed at, state (`open` / `replayed` / `discarded`), resolved
  at, resolution note code.
- No error messages containing record content are stored; full detail goes
  to redacted logs with the correlation id.
- **Poison events**: a payload that fails validation, or a job that stalls
  past `maxStalledCount`, is dead-lettered without further attempts.
- Visibility: `context:report`, metrics (open dead letters by code).
- `context:dead-letters discard --id … --reason …` for operator decisions
  (append-only audit).

## 11. Replay

- `context:replay` (tenant required; `--dry-run` is the default and prints
  what would be enqueued):
  - `--dead-letter <id>` or `--dead-letters --code <code>`;
  - `--receipt <deliveryKey>`;
  - `--receipts --since <ts> --until <ts> [--status …] [--limit n]`;
  - `--subject hubspot:company:<id>`.
- Replay resets the receipt to `pending`, enqueues with a `-r<n>` suffix,
  marks dead letters `replayed`, and logs the operator and a new correlation
  id linked to the original.
- Safe by construction: ingestion reads current source state and applies it
  only if newer; replaying N times leaves canonical state unchanged after
  the first successful run.

## 12. Canonical Account changes

- `Company` keeps a platform UUID `id` and `tenantId`.
- `name` becomes **nullable** in the domain and database. No placeholder
  name is ever stored; display choices belong to a future UI.
- New `recordState`: `active` / `inactive` (every source ref deleted) /
  `merged` (merged forward), plus `mergedIntoId`.
- `domains`: from the HubSpot `domain` property, normalised; a value that is
  not a valid domain is not stored (the observation records it as rejected,
  by field name only).
- `customerStatus` stays `unknown`: mapping HubSpot `lifecyclestage` is
  tenant configuration and is `tbc` (never invented).
- Source-specific fields stay out of canonical tables. Only the mapped
  fields (name, domain) are canonical.
- Validation tests: company with no name, empty name, whitespace name,
  invalid domain.

## 13. Canonical Person changes

- `Person` keeps a platform UUID `id` and `tenantId`.
- `primaryEmail` becomes **nullable**; normalised (existing
  `EmailAddressSchema`) when present.
- The tenant-wide unique constraint on `primary_email` is **removed** and
  replaced by a non-unique `(tenant_id, primary_email)` index for lookup.
  Rationale: email is not identity; a unique constraint would either reject
  valid source records or force implicit merges. No two people are merged
  because their emails match; with no identity-resolution policy in M6, a
  shared email is recorded only as an informational identity conflict.
- `findByEmail` becomes `listByEmail` (may return several).
- `firstName`, `lastName`, `jobTitle` as available; `companyId` from the
  contact's **primary** company association (section 14); `roles` not
  mapped (tenant configuration, `tbc`).
- `recordState` / `mergedIntoId` as for companies.
- Validation tests: contact without email, invalid email, two contacts with
  the same email.

## 14. External identities/cross-references

The existing `company_external_refs` and `person_external_refs` tables are
the external-identity store (the table encodes the canonical entity type).
They are extended, not replaced:

| Column                                                 | Purpose                                              |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `tenant_id, system, object_type, external_id` (PK)     | uniqueness within tenant × system × object type      |
| `company_id` / `person_id`                             | canonical entity                                     |
| `state`                                                | `active` / `deleted` / `merged`                      |
| `merged_into_external_id`                              | lineage to the surviving source id                   |
| `first_seen_at`, `last_seen_at`                        | our observation times                                |
| `source_created_at`, `source_updated_at`, `deleted_at` | source timestamps                                    |
| `field_hash`                                           | hash of the last applied mapped fields (idempotency) |
| `last_change_id`                                       | latest provenance row                                |

- `system` is CHECK-limited to the canonical `ExternalSystem` values
  (`hubspot`, `sugar`, `gainsight_cs`, `gainsight_px`), so Sugar Accounts or
  Gainsight Companies attach later as further rows pointing at the same
  canonical id: **no schema redesign**.
- M6 resolution (pure function): find by `(system, object_type,
external_id)`; found → its canonical id (following `mergedIntoId`); not
  found → new canonical record with a new UUID and the ref. **No
  cross-system matching rules** are defined; they arrive with the Sugar and
  Gainsight schemas.
- Source relationships: `tenant_source_relationships` holds HubSpot
  contact↔company associations as source context (from/to refs, association
  type id, category, is-primary, state, source time, last seen). The
  canonical `Person.companyId` is the primary association only; no
  association becomes business logic.
- `tenant_identity_conflicts` (identifiers only): kind
  (`shared_email`, `merge_across_systems`, `ambiguous_primary_company`),
  canonical ids, refs, state. Recorded for later review; no automatic
  resolution.

## 15. Provenance

Append-only `tenant_context_changes`, one row per real canonical change:

| Question                            | Column(s)                                                                                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What changed?                       | `entity_kind`, `entity_id`, `change_type` (created / updated / state_changed / merged / ref_added / relationship_changed), `changed_fields` (names only) |
| Where did it come from?             | `source_system`, `source_object_type`, `source_record_id`                                                                                                |
| Which event or run caused it?       | `cause` (webhook / backfill / reconciliation / replay), `receipt_delivery_key` or `checkpoint_id`                                                        |
| When did the source say it changed? | `source_updated_at`                                                                                                                                      |
| When did we process it?             | `ingested_at`                                                                                                                                            |
| Which adapter/version?              | `adapter` (`hubspot`), `adapter_version` (mapping version, e.g. `m6.1`)                                                                                  |
| Trace                               | `correlation_id`                                                                                                                                         |

Values are not duplicated into provenance (they live in the canonical row).
This is source-record provenance for canonical context, not the M10
fact/signal model.

## 16. HubSpot adapter responsibilities

All vendor knowledge stays in `src/modules/hubspot`:

- **Event parsing**: extend the parser to keep merge identifiers
  (`primaryObjectId`, `mergedObjectIds`, `newObjectId`) and association
  identifiers (`fromObjectId`, `fromObjectTypeId`, `toObjectId`,
  `toObjectTypeId`, `associationTypeId`, `associationCategory`,
  `associationRemoved`, `isPrimaryAssociation`); still no values.
- **Translator** (`HubSpotSourceEventTranslator`): receipt → subjects or a
  classification (`deferred`, `irrelevant`); object type ids `0-1`, `0-2`,
  `0-136` mapped only here.
- **Eligibility inputs**: the tenant's connected portal id and app id.
- **Read-back**: `getRecord` for the subject, `readAssociations` for
  contact→company; mapping into `SourceObservation`.
- **Bulk**: `listRecords` paging for backfill; `searchChangedSince` for
  reconciliation (section 21).
- **Transport guard**: exact allow-list additions with body validation.
- **App definition**: new subscriptions only after section 23 conditions
  hold and the owner approves; renderer checks unchanged (no write scopes).
- **Enqueue hook**: the webhook service calls a `ReceiptsStoredListener`
  port after commit; the context module implements it (so `hubspot` does not
  depend on `context`).

## 17. Worker responsibilities

- Register the processors; nothing runs in the API process except enqueue.
- Per job: validate payload → issue tenant context → claim → work →
  mark → ack; classify failures; dead-letter; emit metrics; propagate the
  correlation id and trace context.
- HubSpot reads happen **before** the DB transaction opens; the transaction
  is short and holds the subject lock only while applying.
- Run the per-tenant schedulers: sweep (stale `pending` receipts younger
  than `SWEEP_MAX_AGE`, stalled `processing` receipts) and reconciliation.
- Shut down gracefully. Never write to HubSpot.

## 18. Database/schema changes

Altered:

- `tenant_webhook_receipts`: `processing_status` (`pending`, `processing`,
  `retrying`, `processed`, `ineligible`, `deferred`, `irrelevant`,
  `source_not_found`, `dead_lettered`), `processing_reason` (code),
  `processing_attempts`, `processed_at`, `correlation_id` (uuid),
  `primary_object_id`, `new_object_id`, `merged_object_ids` (text[]),
  `from_object_id`, `from_object_type_id`, `to_object_id`,
  `to_object_type_id`, `association_type_id`, `association_category`,
  `association_removed`, `is_primary_association`; CHECKs keep every new
  column to identifier formats; index `(tenant_id, processing_status,
received_at)`.
- `companies`: `name` nullable; `record_state`, `merged_into_id`.
- `persons`: `primary_email` nullable; unique constraint replaced by a
  non-unique index; `record_state`, `merged_into_id`.
- `company_external_refs`, `person_external_refs`: columns in section 14.

New (each: `tenant_id`, forced RLS, tenant-leading PK, CHECKs, `lip_app`
grants):

- `tenant_context_changes` (provenance);
- `tenant_source_relationships`;
- `tenant_identity_conflicts`;
- `tenant_dead_letters`;
- `tenant_sync_checkpoints` (tenant, id, system, kind, mode `backfill` /
  `reconcile`, status, cursor, watermark, window start, page number, counts,
  started/updated/completed at, correlation id).

## 19. Migrations

| Migration                                         | Content                                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `20261005120000_m6_canonical_identity_provenance` | company/person nullability and state; external-ref columns; changes, relationships, conflicts |
| `20261005130000_m6_event_processing_state`        | receipt processing and merge/association columns; dead letters; sync checkpoints              |

- Prisma schema plus hand-written SQL for RLS, CHECKs and grants (as M2–M5).
- Forward-only in shared environments. Existing receipts get
  `processing_status = 'pending'`, `processing_reason = 'pre_m6'`; the sweep
  ignores receipts older than `SWEEP_MAX_AGE` (24 h), so historical receipts
  are processed **only** by the explicit command (section 22).
- Tested from an empty database and from an M5-shaped database with data.

## 20. Backfill

- `context:backfill --tenant <slug> --kind company|person|all
[--max-records n] [--page-size 100] [--dry-run]`.
- Creates a `tenant_sync_checkpoints` row (`mode = backfill`) and enqueues
  the first `backfill.page`.
- Each page job: reads the cursor from the checkpoint → `listRecords`
  (`GET /crm/objects/2026-09/{type}`, existing read-only path, mapped
  properties only) → associations for contacts → calls
  `ContextIngestionService.ingest` for each record (the **same** function as
  webhooks) → advances cursor, counts and page number in the **same**
  transaction → enqueues the next page. No record data enters Redis.
- **Resume**: re-running the command for an unfinished checkpoint continues
  from the stored cursor; a completed checkpoint is not re-run unless
  `--restart` (which is still idempotent).
- **Bounded**: page size, `--max-records`, a per-tenant single active
  backfill per kind (unique partial index), rate-limited reads.
- **Race with webhooks** (record changes during backfill): both paths go
  through `ingest`, which locks the external ref and compares
  `source_updated_at`. A backfill snapshot older than a webhook-applied
  read-back is a no-op; a newer one wins. A deletion tombstone stores the
  source deletion time; a backfill snapshot older than it does not revive
  the record. Final state converges to HubSpot's latest state regardless of
  order.
- **After backfill**: a reconciliation run starts automatically from
  `watermark = backfill start − lookback`, closing any gap between the page
  reads and live webhooks.
- Progress: pages, records seen/created/updated/unchanged/rejected,
  rate (metrics + `context:report`).

## 21. Reconciliation

Purpose: catch changes whose webhooks were lost, delayed past retries, or
missed while the app was not subscribed, using a source-time watermark.

> **Hard precondition — search endpoint/version gate (Gate 1).** No
> reconciliation or search code, allow-list entry, request builder or test
> fixture naming a search path is written until the exact HubSpot CRM search
> endpoint and version are verified, either from current official HubSpot
> documentation or from a safe live read-only check against developer test
> account 149338734. The evidence (source, date, exact path, method, scope,
> observed response) is recorded in ADR 0015 before the code. If the version
> is still unclear after that check, the documented `2026-03` endpoint is
> used; `2026-09` is never assumed. The allow-list contains only the exact
> verified read-only search path(s) for contacts and companies and nothing
> broader. `<V>` below stands for the verified version.

- **Endpoint**: `POST /crm/objects/<V>/contacts/search` and
  `POST /crm/objects/<V>/companies/search`. Current evidence: the pattern
  `POST /crm/objects/{version}/{object}/search` and the `2026-03` version are
  DOCUMENTED; a `2026-09` search path is not confirmed. Default if Gate 1
  cannot confirm another version: `2026-03`.
- **Scopes**: `crm.objects.contacts.read` / `crm.objects.companies.read`
  (DOCUMENTED), already granted. No new scope.
- **Limits** (DOCUMENTED): 10 000 results per query (paging beyond → 400);
  request body ≤ 3 000 characters; ≤ 5 filter groups / 18 filters; burst
  5 requests/s per account; no rate-limit headers on search responses.
- **Query**: one filter `<modified property> GTE <watermark>`, sorted
  ascending by the same property, `properties` limited to mapped fields,
  `limit` ≤ 100, `after` cursor. Modified property: `lastmodifieddate`
  (contacts) and `hs_lastmodifieddate` (companies) — INFERRED, confirmed
  against the property definitions via the existing discovery CLI before
  implementation.
- **Watermark**: per tenant × kind in `tenant_sync_checkpoints`; based on
  **HubSpot source timestamps only**, never our clock. Each run starts at
  `watermark − lookback` (10 min) to cover search-index lag; idempotent
  apply absorbs the overlap. The watermark advances to the greatest source
  timestamp fully processed. When a window reaches 10 000 results, the run
  restarts the query from the last processed timestamp (window slicing);
  equal timestamps at a slice boundary are re-read, not skipped.
- **Schedule**: every 15 min per tenant (configurable), after backfill, and
  on demand (`context:reconcile`).
- **Guarding** (owner requirement):
  - exact allow-list `^/crm/objects/<V>/(contacts|companies)/search$`,
    with `<V>` the single version verified at Gate 1 (no generic POST
    exception, no other objects, no other versions);
  - request body validated against a strict schema: only `filterGroups`,
    `sorts`, `properties`, `limit`, `after`; filter operators limited to
    `GTE` / `LTE` / `EQ` on allowed properties; unknown keys refused;
  - negative tests: create (`POST /crm/objects/<V>/contacts`), batch
    create/update/upsert/archive, merge, GDPR delete, deals/tickets search,
    trailing-slash, case and traversal variants, bodies with `inputs` or
    `properties` objects — all refused;
  - breadth test: the allow-list is compared with an exact expected list,
    and a corpus of HubSpot write paths is asserted refused;
  - mutation proof: widening the pattern (e.g. `/search$` suffix only, or
    `[\w-]+` object, or any version) makes the breadth and negative tests
    fail.

## 22. Existing M5 receipt processing

- **Eligible receipt** (pure function, every branch tested):
  - `system = hubspot`;
  - `app_id` equals the tenant's configured app id;
  - `account_id` equals the tenant's connected portal id;
  - `subscription_type` in the supported set;
  - `object_type_id` is `0-1` or `0-2` (leads `0-136` → `deferred`);
  - `object_id` (or merge/association ids) present.

  Anything else → `ineligible` with a reason code
  (`app_mismatch`, `account_mismatch`, `unsupported_type`, `missing_object`).

- **Read-back as truth**: an eligible receipt only creates or changes
  canonical data if HubSpot returns the record. A synthetic or test event
  naming a non-existent object becomes `source_not_found` — it can never
  create a canonical record.
- In M5, requests with an invalid or missing signature, invalid payloads,
  other apps' events and unroutable accounts were refused before storage
  (`hubspot-webhook.service.ts`), so they are not receipts. Correctly signed
  test deliveries can be receipts (for example the M5 duplicate/retry
  evidence); eligibility plus read-back ensures they cannot create canonical
  records unless HubSpot confirms the object exists in the tenant's portal.
- **Command**: `context:receipts process --tenant <slug> --since <ts>
--until <ts> [--status pending] [--limit n] [--dry-run]`. The dry run
  reports counts by eligibility outcome without enqueuing.
- **Same path** as new receipts (`receipt.process` jobs).
- **Checkpoint**: each receipt's `processing_status`; re-running skips
  finished receipts; `--include-processed` re-processes deliberately
  (still idempotent).
- **Proof of repeatability**: `context:state-hash --tenant <slug>` computes a
  deterministic hash over canonical rows, refs and relationships (ids and
  field hashes, no values printed). Evidence: hash after first replay =
  hash after second replay; provenance row count unchanged by the second
  replay; no duplicate canonical records.

## 23. Deletion/merge/association-event research

Sources: HubSpot developer documentation and changelog, via web search on
2026-10-01 (direct fetch blocked by the network policy). To be re-checked
against the live docs and the HubSpot CLI's upload validation before the
app definition changes.

| Event              | Subscription name (projects `crmObjects`) | Objects                                                                       | Payload identifiers                                                                                                                                          | Read-back?                                                  | Scopes                                                              | Evidence                                                                                       | M6?                                                                  |
| ------------------ | ----------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Deletion           | `object.deletion`                         | contact, company (and other CRM objects)                                      | `objectId`, `objectTypeId`, common fields                                                                                                                    | notification; read-back confirms (record absent / archived) | `crm.objects.contacts.read`, `crm.objects.companies.read`           | DOCUMENTED                                                                                     | **yes**                                                              |
| Restore            | `object.restore`                          | contact, company                                                              | `objectId`, `objectTypeId`                                                                                                                                   | read-back (record returns)                                  | same read scopes                                                    | DOCUMENTED (type exists); scopes INFERRED                                                      | **yes** (deletion is otherwise irreversible; restore window 90 days) |
| Merge              | `object.merge`                            | contact (DOCUMENTED); company (generic `object.merge`, INFERRED for projects) | `primaryObjectId`, `mergedObjectIds[]`, `newObjectId` (when a new record results), `numberOfPropertiesMoved`, `objectTypeId`                                 | read-back of the surviving record                           | `crm.objects.contacts.read` (DOCUMENTED); companies read (INFERRED) | DOCUMENTED for contacts                                                                        | **yes** for contacts; companies if the CLI accepts the subscription  |
| Association change | `object.associationChange`                | contact, company (with contact, company, deal, ticket, line item, product)    | `fromObjectId`, `fromObjectTypeId`, `toObjectId`, `toObjectTypeId`, `associationTypeId`, `associationCategory`, `associationRemoved`, `isPrimaryAssociation` | read-back of the contact's company associations             | object read scopes (DOCUMENTED); association reads already allowed  | DOCUMENTED; user-defined labels not supported by generic subscriptions; fires for both objects | **yes**, contact↔company only; other pairs → `irrelevant`            |

**Privacy deletion is out of scope for M6 (Gate 2).** HubSpot's
`contact.privacyDeletion` subscription is not added, handled or
approval-gated in M6. Ordinary `object.deletion` and `object.restore` remain
in M6 where verified. Privacy/GDPR erasure will be handled through a
separate future privacy and data-retention ADR, tracked as technical-debt
item 15. That design must decide what personal data is erased, what
identifiers and provenance may legally remain, and how erasure is proven
across source data, canonical records, logs, provenance, signals,
opportunities and downstream systems.

Canonical semantics:

- **Delete**: the external ref becomes `deleted` with `deleted_at` (source
  time). Canonical history and provenance are kept. A canonical record whose
  refs are all deleted becomes `recordState = inactive`; it is never
  hard-deleted by M6.
- **Restore**: read-back finds the record; ref returns to `active`; record
  state recomputed; provenance `state_changed`.
- **Merge**: survivor = `newObjectId` if present, else `primaryObjectId`.
  Each merged id's ref → `merged` with `merged_into_external_id = survivor`.
  If a merged ref points at a different canonical record whose refs are all
  from the same system, that record becomes `merged` with `mergedIntoId`
  (lineage kept; refs re-pointed; provenance `merged`). If that record also
  carries refs from another system, no canonical merge happens: an identity
  conflict is recorded (`merge_across_systems`).
- **Association change**: re-reads the contact's company associations and
  updates `tenant_source_relationships` and `Person.companyId` (primary
  association only); no opportunity or business logic.
- **Replay/idempotency**: deletion and restore are decided by read-back
  state plus source timestamps, so order does not matter; merge application
  is idempotent (ref states are set, not toggled); association changes
  re-read current associations.

Conditions for changing the app (owner rule): each subscription is added
only if (a) the HubSpot CLI accepts it for a projects-based app, (b) no new
scope is required — the renderer's exact-scope check stays unchanged and
must pass, and (c) semantics are as above. If any subscription requires a
scope beyond read-only, work stops and is reported before the app changes.

## 24. API/CLI/admin tooling

No new public HTTP endpoints. Built CLIs, run as `pnpm --filter @lip/api …`:

| Command                    | Purpose                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `context:report`           | queue depths, lag, receipts by status, dead letters by code, checkpoints, conflicts, recent changes                                        |
| `context:receipts process` | historical/bounded receipt processing (section 22)                                                                                         |
| `context:backfill`         | section 20                                                                                                                                 |
| `context:reconcile`        | on-demand reconciliation run                                                                                                               |
| `context:replay`           | section 11                                                                                                                                 |
| `context:dead-letters`     | list / discard                                                                                                                             |
| `context:show`             | one canonical record: refs, relationships, provenance trail (field names and timestamps; values only with `--values` for the test account) |
| `context:state-hash`       | deterministic canonical-state hash (section 22)                                                                                            |

All tenant-scoped (`--tenant` required); mutating commands default to
`--dry-run`. Worker readiness includes queue connectivity.

## 25. Observability

- **Correlation id**: generated per webhook request (or per CLI run /
  scheduler tick), stored on receipts, carried in job data, pino child
  bindings, provenance and dead letters. W3C `traceparent` in job data links
  API and worker traces.
- **Metrics** (OpenTelemetry; labels: queue, job, outcome, tenant slug —
  never record ids or values):
  - receipts received / queued / enqueue failures;
  - jobs started / succeeded / retried / failed / dead-lettered / replayed;
  - receipts by processing status;
  - processing latency (`received_at` → `processed_at`) and job duration;
  - queue depth (waiting, active, delayed, failed);
  - backfill pages and records by outcome; reconciliation records found,
    applied, unchanged; watermark lag;
  - HubSpot read calls, 429s, search calls;
  - identity conflicts raised.
- **Logs**: identifiers, codes and correlation ids only; existing redaction;
  a test asserts that no property value reaches logs, Redis payloads, dead
  letters or provenance.

## 26. Security

| Requirement                                  | How it is proven                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Jobs cannot cross tenants                    | integration test: tenant A job with tenant B's delivery key → `receipt_not_found`, no B mutation    |
| External ids unique in the right dimensions  | PK `(tenant, system, object_type, external_id)`; test: same HubSpot id in two tenants → two records |
| Worker always establishes tenant DB context  | all repositories require `TenantTransaction`; RLS denies queries without context (existing guard)   |
| Webhook from tenant A cannot mutate tenant B | M5 router + eligibility account check + RLS; integration test with two portals                      |
| No credentials in Redis                      | payload schemas have no token fields; test inspects stored job data                                 |
| RLS stays enforced                           | schema guard over new tables; `lip_app` unchanged; mutation proofs                                  |
| Retries/replays stay in scope                | context re-issued per attempt; replay test across tenants                                           |
| Read-only HubSpot                            | transport guard + exact search allow-list + body validation; zero-write test over every worker path |
| No new scopes                                | renderer exact-scope check; OAuth scope test unchanged                                              |
| No PII outside canonical tables              | CHECK constraints; payload and log tests                                                            |

Production Redis uses TLS and authentication (Azure Cache for Redis); the
connection URL is a secret supplied through configuration, never committed.

## 27. Test strategy

**Unit (pure):** eligibility; translator classification; identity
resolution (including merge-forward); apply (newer / older / equal hash /
tombstone vs older snapshot); observation normalisation (missing name,
missing email, invalid email, invalid domain); error classification; backoff
schedule; job-id building; search request builder and body validator;
watermark and window-slicing logic; state hash.

**Integration (Testcontainers PostgreSQL + Redis, real BullMQ, fake HubSpot
server):**

| #   | Scenario                                                                                      |
| --- | --------------------------------------------------------------------------------------------- |
| 1   | receipt → canonical company/person + refs + provenance                                        |
| 2   | duplicate receipt (redelivery) → one change                                                   |
| 3   | duplicate job (same id enqueued twice; concurrent same-subject syncs) → one change            |
| 4   | stale / out-of-order snapshots → older never overwrites newer                                 |
| 5   | worker killed mid-job → stalled job re-runs, no duplicate                                     |
| 6   | Redis down at intake → receipt `pending` → sweep recovers                                     |
| 7   | PostgreSQL interrupted during a job → retried → succeeds                                      |
| 8   | partial upsert: failure injected after canonical write, before provenance → full rollback     |
| 9   | poison job (invalid payload; repeatedly stalling) → dead letter                               |
| 10  | transient HubSpot 429/5xx → retry → success; permanent 4xx → dead letter                      |
| 11  | dead letter → replay → processed                                                              |
| 12  | cross-tenant job; two tenants with identical HubSpot ids                                      |
| 13  | inactive tenant; account/app mismatch → ineligible / dead letter                              |
| 14  | lead, unsupported, irrelevant association events → classified, no write                       |
| 15  | company without name; contact without email; two contacts sharing email                       |
| 16  | deletion → tombstone; restore → active; merge → lineage; association change → primary company |
| 17  | backfill multi-page; kill and resume from checkpoint; rerun → no change                       |
| 18  | webhook + backfill race on the same record → converges to latest                              |
| 19  | reconciliation pagination, 10 000-window slicing, lookback overlap                            |
| 20  | search allow-list negative and breadth tests                                                  |
| 21  | historical M5 receipts: dry run, process, process again → equal state hash                    |
| 22  | graceful shutdown waits for the active job                                                    |
| 23  | `noeviction` start-up check                                                                   |
| 24  | migrations from empty and from M5 data; schema guard covers new tables                        |
| 25  | zero HubSpot writes across all worker paths; no values in logs/Redis                          |

**Mutation proofs** (each run and recorded failing for the right reason,
then restored):

| Mechanism                 | Break                                    | Must fail               |
| ------------------------- | ---------------------------------------- | ----------------------- |
| Out-of-order guard        | apply regardless of `source_updated_at`  | 4, 18                   |
| Subject lock              | remove the row lock                      | 3                       |
| Single transaction        | commit canonical write before provenance | 8                       |
| RLS on each new table     | disable the policy                       | schema guard, 12        |
| Tenant re-issue           | trust the payload tenant                 | 12, 13                  |
| Eligibility account check | skip the portal comparison               | 13, 21                  |
| Read-back gate            | create from receipt without read-back    | 21 (`source_not_found`) |
| Retry classification      | everything retryable                     | 9, 10                   |
| Dead-letter write         | skip the handler                         | 9, 11                   |
| Sweep                     | disable                                  | 6                       |
| Bulk checkpoint atomicity | advance cursor outside the transaction   | 17                      |
| Search allow-list         | widen the pattern                        | 20                      |
| Search body validator     | accept unknown keys                      | 20                      |
| Graceful shutdown         | close without waiting                    | 22                      |
| `noeviction` check        | skip                                     | 23                      |
| Tombstone guard           | ignore deletion time vs snapshot time    | 16, 18                  |

## 28. Runtime/Docker/fresh-clone/live verification

- **Runtime**: `scripts/verify-runtime.d/50-context-processing.sh` — real
  API + worker + PostgreSQL + Redis + fake HubSpot; signed synthetic
  webhooks → canonical rows, provenance, receipt status; stop the worker
  mid-run and restart → no loss or duplication; permanent failure → dead
  letter → replay; backfill against the fake → resume after kill.
- **Docker**: Compose Redis with AOF + `noeviction`; `verify:docker` asserts
  the worker registers processors and becomes ready.
- **Fresh clone**: `pnpm install` → `pnpm verify` → `verify:runtime` →
  `verify:docker` from a clean checkout.
- **Live** (test account 149338734 only, no writes): backfill; create and
  edit a company and a contact in the HubSpot UI → canonical update via
  webhook; delete and restore a test contact; merge two test contacts;
  change a contact's primary company; reconciliation catches a change made
  while the worker was stopped; historical M5 receipts processed twice with
  equal state hashes. Evidence recorded with identifiers only.

## 29. Acceptance criteria and independent-review evidence

Acceptance criteria:

1. One canonical write path (`ContextIngestionService.ingest`) used by
   webhooks, backfill and reconciliation (verified by code structure and a
   dependency rule).
2. Platform UUIDs canonical; HubSpot ids only as refs; name and email
   nullable with no placeholders.
3. Every eligible receipt ends in a terminal status with a reason; none
   stays `pending` beyond the sweep interval while the worker runs.
4. Duplicates, concurrency, replays, stale events and backfill races
   converge with one provenance row per real change.
5. Retry, dead-letter, poison handling and replay behave as specified.
6. Redis, worker and PostgreSQL interruptions lose nothing.
7. Backfill is resumable and idempotent; reconciliation honours watermarks
   and the 10 000-result window.
8. Historical M5 receipts processed through the same path; second replay
   changes nothing (equal state hash).
9. Deletion, restore, merge and association semantics as section 23 (for
   the subscriptions that pass the conditions).
10. Tenant isolation proven; zero HubSpot writes; no new scopes; no values
    in Redis, logs, receipts, dead letters or provenance.
11. Metrics and `context:report` show the flow end to end.
12. All mutation proofs recorded; `pnpm verify`, runtime, Docker and
    fresh-clone runs pass; CI green.
13. ADRs 0013–0015, this record (scope, DoD, evidence) and runbooks updated.

Evidence for independent review: exact commands and outputs for every gate;
the mutation-proof table with failing output; live evidence (identifiers
only); state-hash comparison; migration-from-M5 output; zero-write and
no-values test output; the HubSpot research record with sources.

## 30. Risks/open questions and explicit out-of-scope

Open questions / approval points:

1. **Gate 1 (hard precondition)**: the search endpoint/version must be
   verified and recorded in ADR 0015 before any reconciliation/search code
   (section 21); otherwise the documented `2026-03` endpoint is used.
2. Company `object.merge` in projects apps: INFERRED; included only if the
   CLI accepts it.
3. Modified-date property names for search: INFERRED; confirmed via
   discovery.
4. Re-uploading the app to the test account (manual step, as in M5).

Future work (not M6): privacy/GDPR erasure, including HubSpot
`contact.privacyDeletion`, through a separate privacy and data-retention
ADR (section 23; technical-debt item 15).

Risks:

- BullMQ open source has no per-tenant group fairness; one large tenant can
  delay others. Mitigation: per-tenant limits and modest concurrency;
  revisit at the second tenant.
- `object.associationChange` also fires for contact/company associations
  with deals, tickets and products: extra volume, classified `irrelevant`
  cheaply.
- HubSpot search index lag; mitigated by lookback and idempotent apply.
- HubSpot rate limits during backfill; mitigated by limiters and sequential
  paging.
- Redis misconfiguration in production; mitigated by the start-up check and
  PostgreSQL as source of truth.
- Table growth (receipts, provenance, relationships): retention policy
  `tbc` (identifier data only).

Explicitly out of scope: product catalogue; subscriptions/entitlements;
eligibility; whitespace; candidate opportunities; qualification; Jev;
prioritisation; routing; Sugar; Gainsight; CRM writes; operator UI; AI/LLM
soft-signal analysis; sales action creation; cross-system matching rules;
automatic canonical merges across systems; privacy/GDPR erasure and
`contact.privacyDeletion` (future privacy and data-retention ADR); Lead
object processing (receipts
`deferred`); custom-field and lifecycle mapping (`tbc`).

---

## Proposed files and modules

| Area            | Files (new unless marked)                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue platform  | `src/platform/queue/{queue.module,connections,queue-producer,processor-registry,redis-policy-check,queue-metrics,index}.ts`; `platform/config/config.schema.ts` (changed: `QUEUE_*`, `SWEEP_*`, `RECONCILE_*`)                                                                                                                                                                                                    |
| Domain (pure)   | `domain/source-observation.ts`, `domain/canonical-identity.ts` (resolve, apply, merge-forward), `domain/context-provenance.ts`, `domain/receipt-eligibility.ts`; changed: `company.ts` (nullable name, record state), `person.ts` (nullable email, record state), `external-ref.ts` (state)                                                                                                                       |
| Context module  | `src/modules/context/{context.module,context-worker.module,index}.ts`; `application/{context-ingestion,receipt-processing,backfill,reconciliation,replay,dead-letter,sweep}.service.ts`; `infrastructure/{context-change,dead-letter,sync-checkpoint,identity-conflict,source-relationship}.repository.ts`; `processors/{receipt,sync,bulk}.processor.ts`; `ports.ts` (`SourceAdapter`, `ReceiptsStoredListener`) |
| Identity module | changed: repositories and Prisma repositories (nullable fields, ref state, `listByEmail`)                                                                                                                                                                                                                                                                                                                         |
| Tenancy module  | changed: `listActiveTenants`                                                                                                                                                                                                                                                                                                                                                                                      |
| HubSpot module  | `application/hubspot-source-adapter.ts`, `application/hubspot-source-event-translator.ts`; changed: `webhook-events.ts`, `webhook-receipt.repository.ts`, `hubspot-webhook.service.ts` (listener), `hubspot-reader.ts` (search), `http-client.ts` (exact allow-list + body validator), `mappers.ts`                                                                                                               |
| Worker          | changed: `worker.ts`, `worker.module.ts`                                                                                                                                                                                                                                                                                                                                                                          |
| CLIs            | `src/cli/context-{report,receipts,backfill,reconcile,replay,dead-letters,show,state-hash}.ts`; `package.json` scripts                                                                                                                                                                                                                                                                                             |
| Boundaries      | changed: `.dependency-cruiser.cjs` (`bullmq-only-in-platform-queue`, `context-must-not-import-vendor-modules`, `single-canonical-writer`)                                                                                                                                                                                                                                                                         |
| Prisma          | changed: `schema.prisma`; two migrations (section 19)                                                                                                                                                                                                                                                                                                                                                             |
| HubSpot app     | changed (after approval point): `hubspot-app/template/src/app/webhooks/webhooks-hsmeta.json`; `render.mjs` checks unchanged                                                                                                                                                                                                                                                                                       |
| Tests           | unit specs beside sources; `test/context/*.int.spec.ts`; fake HubSpot extended (search, list paging, merge/deletion read-back); `test/tenancy` schema guard (automatic)                                                                                                                                                                                                                                           |
| Ops             | `docker-compose.yml` (Redis `noeviction`); `scripts/verify-runtime.d/50-context-processing.sh`; `scripts/verify-docker.sh`                                                                                                                                                                                                                                                                                        |
| Docs            | this record; ADRs 0013–0015; `docs/integrations/hubspot/m6-context-runbook.md`; `docs/operations/` queue operations; `docs/architecture.md`                                                                                                                                                                                                                                                                       |

## Proposed ADRs

- **ADR 0013** — Event processing on BullMQ: queue topology, PostgreSQL as
  source of truth, idempotency layers, retry classification, dead letters,
  replay, shutdown, Redis policy.
- **ADR 0014** — Canonical identity, cross-references and provenance:
  platform ids, nullable name/email, removal of email uniqueness, ref
  state, delete/restore/merge semantics, single canonical writer.
- **ADR 0015** — HubSpot lifecycle subscriptions and reconciliation search:
  research record, subscription additions, the **Gate 1 evidence** for the
  exact search endpoint and version (written before any search code), exact
  search allow-list and body validation, watermark rules.

## Implementation sequence

1. ADRs 0013–0015 drafts and the HubSpot research re-check (property
   names, merge for companies, deletion/restore/association scopes).
   **Approval point** if anything differs from section 23.
2. `platform/queue`: install BullMQ, connections, producer/registry,
   `noeviction` check, shutdown, metrics; tests and mutation proofs.
3. Migrations, schema guard, domain changes (nullable name/email, states),
   repositories.
4. `ContextIngestionService` (pure resolve/apply + transactional write +
   provenance); tests 4, 8, 15; mutation proofs.
5. Receipt path: parser extension, eligibility, translator, listener,
   sweep; tests 1–3, 5–7, 12–14, 21.
6. Retry classification, dead letters, replay, poison handling; tests 9–11.
7. Backfill; tests 17–18.
8. **Gate 1 first**: verify the search endpoint/version (official docs or a
   safe live read-only check on test account 149338734) and record the
   evidence in ADR 0015; use `2026-03` if unclear. Only then: search
   allow-list (exact verified path), body validator, reconciliation; tests
   19–20.
9. Deletion/restore/merge/association handling against the fake; test 16.
   **Approval point**: app subscription change and re-upload to the test
   account.
10. CLIs and observability; test 25.
11. Runtime script, Docker, live evidence on the test account, fresh clone,
    milestone record, PR, independent review.

## Rollback strategy

- **Runtime switch**: `CONTEXT_PROCESSING_ENABLED=false` stops enqueueing and
  processors; webhooks keep producing `pending` receipts exactly as in M5,
  ready for later processing. No data is lost.
- **Queues**: Redis queues can be drained or removed without data loss;
  PostgreSQL holds all state, and the receipt command or sweep re-creates
  jobs.
- **Database**: migrations are additive except the two relaxations
  (nullable name/email, dropped email uniqueness). Production policy is
  forward-fix; a tested down-script is provided for development and
  staging (`apps/api/prisma/rollback/`, tested in
  `test/tenancy/migrations.int.spec.ts`). Pre-M6 code cannot read rows with
  null name/email, so once such rows exist the rollback path is the runtime
  switch, not a code downgrade; the identity down-script refuses to run on
  such data.
- **HubSpot app**: re-upload the previous template to remove the new
  subscriptions; no scope changes are involved.
- **Canonical data**: every change has provenance; records created by M6 can
  be identified by `cause` and correlation id if a clean-up is ever needed.

## Points where human approval may be needed

1. This plan (before any code, dependency or schema change).
2. Research re-check results if any differ from section 23, and any scope
   that is not read-only (work stops).
3. Gate 1 evidence for the search endpoint/version, if the live check is
   used or the result differs from the documented `2026-03` path.
4. The app subscription change and its manual re-upload to test account 149338734.
5. Live test actions on the test account (delete/restore/merge of test
   records only).
6. The PR and independent review before merge.

---

## Implementation record

Branch `claude/blissful-mendel-urbh4r`, from the approved plan (`869ddae`).
The exact head SHA, CI result and fresh-clone output are in the M6 pull
request description, since they are bound to the final commit.

### What was built

| Area                    | Implementation                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADRs                    | [0013](../adr/0013-event-processing-on-bullmq.md) BullMQ processing, [0014](../adr/0014-canonical-identity-references-provenance.md) identity/references/provenance, [0015](../adr/0015-hubspot-lifecycle-subscriptions-and-reconciliation-search.md) lifecycle subscriptions and Gate 1 search evidence                                              |
| Gate 1 (search)         | Official docs (2026-09 "latest" page titled `POST /crm/objects/2026-03/{objectType}/search`) → **2026-03**. Exact allow-list `^/crm/objects/2026-03/(contacts\|companies)/search$`, strict body schema per object, 3 req/s per tenant. Written before any search code (commit order: ADR 0015 → `5d4bf55`)                                            |
| Gate 2 (privacy)        | `contact.privacyDeletion` not subscribed, parsed or handled; a test refuses it in the app template; tech-debt item 15                                                                                                                                                                                                                                 |
| Queue platform          | `platform/queue` (only module importing BullMQ, dependency rule): queues `lip-receipts`, `lip-sync`, `lip-bulk`; deterministic job ids; strict identifier-only payloads; 8 attempts, 5 s × 2ⁿ (≤ 10 min, ±20 %, ≥ Retry-After); `noeviction` check; graceful shutdown; stalled-job recovery; tick scheduler                                           |
| Migrations              | `20261005120000_m6_canonical_identity_provenance`, `20261005130000_m6_event_processing_state` (RLS, tenant keys, CHECKs, immutability triggers on all five new tables); development/staging down-scripts in `apps/api/prisma/rollback/`                                                                                                               |
| Identity                | Platform UUIDs canonical; refs carry `state` (`active`/`deleted`/`merged`), `merged_into_external_id`, source times, field hash; nullable company name and person email (no placeholders); email not unique, never used to merge; `shared_email`, `merge_across_systems`, `ambiguous_primary_company` conflicts                                       |
| Single writer           | `ContextIngestionService.ingest` / `ingestMerge` (dependency rule `context-store-only-from-ingestion`); pure `decideApply` (create/apply/restore/delete/unchanged/stale/not_found); per-record and per-email advisory locks; one tenant transaction per record including provenance and receipt/checkpoint state                                      |
| Provenance              | `tenant_context_changes`: change type, changed **field names**, cause, receipt/checkpoint, correlation id, adapter version. No values (CHECK constraints)                                                                                                                                                                                             |
| Receipts                | Eligibility (app, portal, object type), leads `deferred:lead_out_of_scope`, read-back before any canonical write (`source_not_found` otherwise), sweep for recent receipts, `pre_m6` receipts only via the bounded command                                                                                                                            |
| Backfill/reconciliation | Paginated, checkpointed, resumable, rate-limited, same writer. Reconciliation on the Gate-1 path only: watermark, lookback, 10 000-result window splitting, `needs_backfill` without a baseline                                                                                                                                                       |
| Lifecycle               | `object.deletion`, `object.restore`, `object.merge`, `object.associationChange` for contacts and companies (template only; scopes unchanged). Merge forward within one system; contact↔company associations only                                                                                                                                      |
| Operations              | CLI `context:report/receipts/backfill/reconcile/replay/dead-letters/show/state-hash` (dry run unless `--execute`); [operations guide](../operations/context-processing.md); [live-evidence runbook](../integrations/hubspot/m6-live-evidence-runbook.md); runtime switch `CONTEXT_PROCESSING_ENABLED`                                                 |
| Metrics                 | `lip_receipts_received/outcome/swept/enqueue_failed/skipped_finished`, `lip_receipt_latency_ms`, `lip_jobs_queued/started/succeeded/failed_final`, `lip_job_duration_ms`, `lip_dead_letters`, `lip_replayed`, `lip_context_ingest/merge`, `lip_backfill_records`, `lip_reconcile_records`, `lip_source_requests/rate_limited` (labels are codes only) |

### Deviations from the plan

| Plan                                        | Implemented                                                                                   | Why                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| BullMQ 5.x                                  | BullMQ 6.3.11                                                                                 | Current major at implementation time; API used is the same (ADR 0013)                                     |
| Separate sweep and reconciliation schedules | One `context.tick` job scheduler (sweep + due reconciliations)                                | One scheduler, one interval to operate                                                                    |
| Shared HubSpot limiter                      | Per-process limiter; one worker process per environment                                       | Tech-debt item 7 (corrected); revisit before horizontal scaling                                           |
| Live evidence before the PR                 | Owner-run after the PR opens ([runbook](../integrations/hubspot/m6-live-evidence-runbook.md)) | This environment has no HubSpot credentials and its egress policy blocks HubSpot; never requested in chat |

### Definition of Done (section 29)

| #   | Criterion                                              | Status                                                                                     |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | One canonical write path                               | Met: dependency rule + mutation proof                                                      |
| 2   | Platform ids canonical; nullable name/email            | Met: migrations, domain, upgrade test                                                      |
| 3   | Every eligible receipt terminal with a reason          | Met against the fake (integration + runtime script 50); live pending                       |
| 4   | Duplicates/concurrency/replay/stale converge           | Met: concurrency, out-of-order, tombstone and shared-email race tests + mutation proofs    |
| 5   | Retry, dead letter, poison, replay                     | Met: integration tests + mutation proofs                                                   |
| 6   | Redis/worker/PostgreSQL interruptions lose nothing     | Met: sweep test, runtime script (Redis/worker restarts), stalled-job recovery              |
| 7   | Backfill resumable/idempotent; reconciliation window   | Met against the fake                                                                       |
| 8   | Historical M5 receipts; second replay equal hash       | Met against the fake; live pending                                                         |
| 9   | Delete/restore/merge/association semantics             | Met against the fake; live pending (company `object.merge` upload unconfirmed, item 18)    |
| 10  | Isolation; zero writes; no new scopes; no values       | Met: RLS tests, read-only guard, zero-write counters in runtime scripts, value-free checks |
| 11  | Metrics and `context:report`                           | Met                                                                                        |
| 12  | Mutation proofs; verify/runtime/Docker/fresh clone; CI | Mutation proofs, verify, runtime, Docker: met (below). Fresh clone and CI: PR description  |
| 13  | ADRs, record, runbooks                                 | Met                                                                                        |

### Mutation proofs (final code)

Each mechanism was broken, its guarding test run (must fail for the stated
reason), then restored and re-run (must pass). Script output, verbatim
summaries:

| Mechanism broken                                                | Result with the mutation                                                                                                                                                                                                                                                                                                                                                        | After restore                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Search allow-list breadth                                       | fails: “refuses POST to write-like association and batch paths”; “allows exactly the verified 2026-03 contacts and companies search with a read body”; “the allow-list is exactly the expected set (breadth check)”                                                                                                                                                             | 53 passed (53) (exit 0)                                                           |
| Search body validator                                           | fails: “refuses search bodies that are not a modified-since read”; “a refused search sends nothing”                                                                                                                                                                                                                                                                             | 53 passed (53) (exit 0)                                                           |
| Redis noeviction check                                          | fails: “refuses to process when Redis may evict keys (maxmemory-policy)”                                                                                                                                                                                                                                                                                                        | 1 passed, 5 skipped (6) (exit 0)                                                  |
| Graceful shutdown (waits for active jobs)                       | fails: “graceful shutdown waits for the active job to finish”                                                                                                                                                                                                                                                                                                                   | 1 passed, 5 skipped (6) (exit 0)                                                  |
| Single canonical writer (dependency rule)                       | fails: 1 dependency violations (1 errors, 0 warnings); error context-store-only-from-ingestion                                                                                                                                                                                                                                                                                  | ✔ no dependency violations found (219 modules, 858 dependencies cruised) (exit 0) |
| Out-of-order guard (source time)                                | fails: “stale (older) observations never overwrite newer state”; “a newer webhook read-back wins over an older backfill snapshot processed later”                                                                                                                                                                                                                               | 2 passed, 33 skipped (35) (exit 0)                                                |
| Tombstone guard (read time vs deletion)                         | fails: “an old snapshot cannot resurrect a record whose deletion was recorded after it was read”                                                                                                                                                                                                                                                                                | 2 passed, 7 skipped (9) (exit 0)                                                  |
| Per-record advisory lock                                        | fails: “concurrent ingestion of one new source record creates exactly one canonical record”                                                                                                                                                                                                                                                                                     | 1 passed, 25 skipped (26) (exit 0)                                                |
| Single transaction (afterApply inside the canonical write)      | fails: “a failure after the canonical write rolls back the record, reference and provenance”                                                                                                                                                                                                                                                                                    | 1 passed, 25 skipped (26) (exit 0)                                                |
| Eligibility: account check                                      | fails: “account mismatch”                                                                                                                                                                                                                                                                                                                                                       | 1 passed, 25 skipped (26) (exit 0)                                                |
| Read-back gate (never create from a receipt alone)              | fails: “a synthetic id HubSpot does not have”                                                                                                                                                                                                                                                                                                                                   | 1 passed, 25 skipped (26) (exit 0)                                                |
| Read-back gate, historical receipts                             | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯; × are processed explicitly through the same path; a second replay changes nothing (equal state hash) 445ms; FAIL test/context/bulk.int.spec.ts > context bulk sync: backfill, reconciliation, historical receipts > historical M5 receipts > are processed explicitly through the same path; a second replay changes nothing (equal state hash) | 1 passed, 8 skipped (9) (exit 0)                                                  |
| Retry classification (permanent errors)                         | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯; × a permanent source error dead-letters the receipt (code only); replay processes it 5147ms; FAIL test/context/processing.int.spec.ts > context processing: webhook receipts → canonical context > failures: retries, dead letters, replay, poison jobs > a permanent source error dead-letters the receipt (code only); replay processes it    | 1 passed, 25 skipped (26) (exit 0)                                                |
| Dead-letter write                                               | fails: “a poison job (invalid payload) fails without retries and is dead-lettered with invalid_payload”; “a job for tenant A naming tenant B's receipt finds nothing (RLS) and changes nothing in B”                                                                                                                                                                            | 4 passed, 22 skipped (26) (exit 0)                                                |
| Sweep (durability after Redis loss)                             | fails: “a receipt stored while the queue was unreachable stays pending and the sweep processes it”                                                                                                                                                                                                                                                                              | 1 passed, 25 skipped (26) (exit 0)                                                |
| Runtime switch (CONTEXT_PROCESSING_ENABLED=false)               | fails: “job payloads in Redis hold identifiers only: no credentials, tokens or record values”                                                                                                                                                                                                                                                                                   | 1 passed, 25 skipped (26) (exit 0)                                                |
| Merge lineage (cross-system guard)                              | fails: “never merges canonical records across systems automatically: a conflict is recorded”                                                                                                                                                                                                                                                                                    | 1 passed, 9 skipped (10) (exit 0)                                                 |
| Email is not identity (no merge on shared email)                | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯; × two contacts with the same email stay two people; a shared_email conflict is recorded 20212ms; FAIL test/context/processing.int.spec.ts > context processing: webhook receipts → canonical context > missing values and email is not identity > two contacts with the same email stay two people; a shared_email conflict is recorded         | 1 passed, 25 skipped (26) (exit 0)                                                |
| RLS on a new M6 table                                           | fails: “every table has row-level security enabled and forced”; “every tenant-owned table has NOT NULL tenant_id and a policy on app_current_tenant()”                                                                                                                                                                                                                          | 17 passed (17) (exit 0)                                                           |
| Email lock (shared-email conflict under concurrency)            | fails: “people sharing an email ingested at the same time still raise one conflict per email”                                                                                                                                                                                                                                                                                   | 1 passed, 25 skipped (26) (exit 0)                                                |
| Worker starts while Redis is unreachable (registration retried) | fails: “allows a superuser only with the explicit development override”; “starts with the application role”                                                                                                                                                                                                                                                                     | 2 passed, 5 skipped (7) (exit 0)                                                  |
| Down-script restores the M5 schema (unique email index)         | fails: “the M6 down-scripts restore exactly the M5 schema, refuse data M5 cannot hold, and M6 re-applies”                                                                                                                                                                                                                                                                       | 1 passed, 16 skipped (17) (exit 0)                                                |
| Down-script refuses data M5 cannot hold                         | fails: “the M6 down-scripts restore exactly the M5 schema, refuse data M5 cannot hold, and M6 re-applies”                                                                                                                                                                                                                                                                       | 1 passed, 16 skipped (17) (exit 0)                                                |

The shared-email race test was first written as a plain concurrent run and
**did not fail** without the email lock (the race window was never hit). It
was rewritten to force the race (an admin session holds the provenance
table, so every ingestion stops between inserting its person and the email
check) and then failed without the lock (`expected [ …(2) ] to have a length
of 5 but got 2`) and passed with it.

### Verification (local, before the PR)

| Gate                  | Result                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`         | pass: lint, format, typecheck, dependency rules; unit 36 files / 434 tests; integration 16 files / 226 tests (before the down-script test, +1) |
| `pnpm verify:runtime` | pass: 105 passed, 0 failed (includes script 40 with processing disabled and script 50 context processing)                                      |
| `pnpm verify:docker`  | pass: 14 passed, 0 failed; cleanup verified (sandbox CA added through `LIP_DOCKERFILE`, not committed)                                         |
| Fresh clone, CI       | In the PR description (bound to the final SHA)                                                                                                 |
| Live (test account)   | **Outstanding**: owner-run per the [runbook](../integrations/hubspot/m6-live-evidence-runbook.md)                                              |

### Open items

- Live evidence on test account 149338734 (runbook steps 1–7), including the
  app re-upload with the lifecycle subscriptions and confirmation that
  scopes stay read-only.
- Technical debt added or updated: items 7, 15–19 in the
  [register](../tech-debt.md).
- Explicitly not in M6: privacy deletion/erasure, leads processing, signals,
  scoring, routing, CRM writes, UI, per-tenant fairness, retention policy.
