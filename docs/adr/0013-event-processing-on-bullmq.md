# ADR 0013: Event processing on BullMQ and Redis (Milestone 6)

- Status: accepted
- Date: 2026-10-01

## Context

M5 stores verified HubSpot webhook receipts durably in PostgreSQL but
processes nothing. M6 turns receipts, an initial backfill and periodic
reconciliation into canonical account and person context
([plan](../milestones/M06-event-processing-canonical-context.md)). ADR 0012
approved **BullMQ on Redis** for job coordination; a PostgreSQL job system is
not built unless a concrete need appears. Redis already runs (M0, AOF on).

## Decision

### 1. PostgreSQL is the source of truth; Redis carries coordination only

- Every unit of work has a durable record in PostgreSQL: the receipt row
  (`processing_status`), a sync checkpoint row (backfill/reconciliation) or a
  dead letter. A job lost from Redis is re-created from that record (the
  sweep, or an explicit command). Nothing exists only in Redis.
- Job payloads hold identifiers only: tenant id, system, delivery key or
  subject id, checkpoint id, correlation id. No names, emails, property
  values, tokens or credentials (payload schemas have no such fields; a test
  inspects stored job data).

### 2. Queues and jobs

| Queue          | Job               | Purpose                                                                     |
| -------------- | ----------------- | --------------------------------------------------------------------------- |
| `lip-receipts` | `receipt.process` | classify one receipt, read back its subject(s), ingest                      |
| `lip-sync`     | `subject.sync`    | read back one company/contact and ingest it (replays, merges, associations) |
| `lip-bulk`     | `backfill.page`   | one page of the initial backfill                                            |
| `lip-bulk`     | `reconcile.page`  | one page of a watermark reconciliation run                                  |
| `lip-bulk`     | `tenant.sweep`    | re-enqueue stale `pending` receipts; start scheduled reconciliation         |

- Job ids are deterministic hex hashes of tenant-scoped identifiers (BullMQ
  ids must not contain `:`); a replay appends a replay counter.
- Page jobs read their cursor from the checkpoint row, never from the
  payload, so a stale or duplicated page job cannot rewind progress.
- All BullMQ imports live in `src/platform/queue` (dependency rule
  `bullmq-only-in-platform-queue`). Business modules use the platform's
  `QueueService` (`add`, `registerProcessor`) with their own queue names.

### 3. Tenant context per job

Every job re-issues its tenant context through `TenantContextService`
(tenant exists and is active) and does all reads and writes in
`TenantDatabase.transaction(ctx, …)` under forced RLS. The payload's tenant id
is never trusted as a context.

### 4. Idempotency

1. Intake: M5's atomic receipt de-duplication.
2. Enqueue: deterministic job ids.
3. Claim: conditional update of the receipt's `processing_status`;
   finished receipts are skipped.
4. Apply: the canonical writer locks the external reference and applies a
   source observation only if it is newer (source timestamp, then field
   hash) — ADR 0014.
5. Bulk: the checkpoint cursor advances in the same transaction as the
   page's ingestion.

### 5. Retries, dead letters, poison jobs

- A pure classifier decides retryable versus permanent. Retryable: network
  and timeouts, HubSpot 429 and 5xx, PostgreSQL connection loss,
  serialisation failures and deadlocks, Redis transient errors. Permanent
  (BullMQ `UnrecoverableError`): invalid payload, unknown or inactive tenant,
  missing receipt, account mismatch, revoked or missing grant, other HubSpot
  4xx, source data failing validation.
- Up to 8 attempts, exponential backoff from 5 s, capped at 10 min, with
  jitter.
- On final failure the worker writes `tenant_dead_letters` (identifiers and
  an error code only) and marks the receipt `dead_lettered`. Stalled jobs are
  re-delivered (`maxStalledCount` 2); a job that keeps stalling is failed and
  dead-lettered as poison.
- Dead letters are replayed or discarded explicitly by an operator command.

### 6. Worker lifecycle

- Processors run only in the worker process. The API only enqueues, after
  the receipt transaction commits; if Redis is unavailable the receipt stays
  `pending` and the sweep enqueues it later.
- The worker refuses to start unless Redis `maxmemory-policy` is
  `noeviction` (BullMQ requirement).
- Graceful shutdown: on SIGTERM workers stop taking jobs and wait for active
  jobs (bounded) before connections close.

### 7. Runtime switch

`CONTEXT_PROCESSING_ENABLED` (default `true`). When `false`, the API stores
receipts exactly as in M5 and enqueues nothing, and the worker registers no
processors. Receipts stay `pending` for later processing. This is the
operational rollback.

### 8. Version

`bullmq` 6.x (latest at implementation, 6.3.x). The plan named "latest 5.x";
6.x was current when installed and its API (queues, workers,
`UnrecoverableError`, job schedulers, stalled-job handling) covers the design.

## Consequences

- One new runtime dependency (`bullmq`) and Redis configuration requirements
  (`noeviction`, AOF) documented for production (Azure Cache for Redis).
- Open-source BullMQ has no per-tenant fairness groups; a large tenant can
  delay others. Mitigated with per-tenant HubSpot rate limits and modest
  concurrency; revisit at the second tenant.
