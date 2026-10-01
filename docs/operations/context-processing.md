# Context processing operations (Milestone 6)

How canonical account and person context is processed, and how to run,
pause, inspect and recover it. Design:
[ADR 0013](../adr/0013-event-processing-on-bullmq.md) (queues, retries, dead
letters), [ADR 0014](../adr/0014-canonical-identity-references-provenance.md)
(identity, references, provenance),
[ADR 0015](../adr/0015-hubspot-lifecycle-subscriptions-and-reconciliation-search.md)
(HubSpot lifecycle events and reconciliation search).

## Moving parts

| Part             | Where                      | Notes                                                                                        |
| ---------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| Durable state    | PostgreSQL                 | receipts (`processing_status`), `tenant_sync_checkpoints`, `tenant_dead_letters`, provenance |
| Job coordination | Redis (BullMQ)             | queues `lip-receipts`, `lip-sync`, `lip-bulk`; payloads hold identifiers only                |
| Producer         | API (after receipt commit) | best effort, ≤ 1.5 s; Redis down → receipt stays `pending`                                   |
| Consumers        | worker only                | concurrency 8 / 4 / 2; tick every `CONTEXT_SWEEP_INTERVAL_MS` (sweep + due reconciliations)  |

## Redis requirements (production: Azure Cache for Redis)

- `maxmemory-policy noeviction` — the worker **refuses to start** otherwise
  (`RedisPolicyError`). Compose sets it explicitly.
- Persistence (AOF/RDB) recommended; PostgreSQL remains the source of truth,
  so a Redis loss is recovered by the sweep (recent receipts) or the commands
  below (historical receipts, failed runs).
- TLS + authentication in production via `REDIS_URL` (`rediss://…`), supplied
  as a secret by the environment. Never committed.
- `QUEUE_PREFIX` (default `lip`) separates environments sharing a Redis.

## Configuration

| Variable                        | Default  | Meaning                                                                                         |
| ------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `CONTEXT_PROCESSING_ENABLED`    | `true`   | **Runtime switch / rollback.** `false`: receipts stored as in M5, nothing queued, no processors |
| `QUEUE_PREFIX`                  | `lip`    | BullMQ key prefix                                                                               |
| `WORKER_SHUTDOWN_TIMEOUT_MS`    | `25000`  | how long SIGTERM waits for active jobs                                                          |
| `CONTEXT_SWEEP_INTERVAL_MS`     | `300000` | tick interval                                                                                   |
| `CONTEXT_SWEEP_STALE_MS`        | `120000` | a receipt pending longer than this is re-queued by the sweep                                    |
| `CONTEXT_SWEEP_MAX_AGE_MS`      | 24 h     | the sweep ignores older receipts (historical ones need the command)                             |
| `CONTEXT_RECONCILE_INTERVAL_MS` | `900000` | automatic reconciliation per tenant and kind (0 = off)                                          |
| `CONTEXT_RECONCILE_LOOKBACK_MS` | `600000` | overlap before the watermark (search-index lag)                                                 |

## Commands

All take `--tenant <slug>`; anything that changes state is a **dry run unless
`--execute`**. Output is JSON with identifiers, counts, states and hashes —
never names or emails. Work is processed by the worker.

| Command                | Use                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context:report`       | queue depths, receipts by status, records, references, conflicts, checkpoints, dead letters                                                       |
| `context:receipts`     | process stored receipts in a bounded range (e.g. `--only-reason pre_m6` for M5 receipts); `--include-finished` replays finished ones (idempotent) |
| `context:backfill`     | initial read-only load (`--kind company                                                                                                           | person | all`, `--page-size`, `--max-records`); `--resume <checkpointId>` reopens a failed run at its cursor |
| `context:reconcile`    | start a reconciliation now (`--since` to override the watermark)                                                                                  |
| `context:replay`       | replay dead letters (`--dead-letter <ids>` or `--code <code>`) or re-read one record (`--subject hubspot:person:<id>`)                            |
| `context:dead-letters` | list dead letters; `--discard <ids> --reason <code> --execute` records an operator decision                                                       |
| `context:show`         | one canonical record: references, states, provenance trail (field names only)                                                                     |
| `context:state-hash`   | deterministic hash of canonical state (repeatability evidence)                                                                                    |

## Runbook

- **Pause processing (rollback):** set `CONTEXT_PROCESSING_ENABLED=false` on
  API and worker and restart them. Webhooks keep being stored as `pending`.
  To resume, set it back to `true`; recent receipts are picked up by the sweep,
  older ones with `context:receipts`.
- **Dead letters:** `context:dead-letters` → fix the cause (e.g. reinstall the
  app for `grant_unavailable`) → `context:replay --dead-letter <ids> --execute`.
- **Failed backfill/reconciliation:** `context:report` shows the checkpoint
  and its error code → fix → `context:backfill --resume <checkpointId> --execute`.
- **Redis flushed/lost:** recent receipts return through the sweep; for older
  ones run `context:receipts --since <time> --execute`; restart failed runs
  with `--resume`.
- **Shutdown:** SIGTERM stops taking jobs and waits up to
  `WORKER_SHUTDOWN_TIMEOUT_MS` for active ones; a killed worker's job is
  re-delivered by BullMQ (stalled-job recovery) and processed idempotently.

## Limits (see technical-debt register)

- One worker process per environment: the HubSpot rate limiter is per process
  (item 7). Open-source BullMQ has no per-tenant fairness (item 16).
- Retention of receipts, provenance and dead letters is `tbc` (item 17).
- Privacy/GDPR erasure is out of scope for M6 (item 15).
