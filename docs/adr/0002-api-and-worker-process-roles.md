# ADR 0002 — Cloud-portable containers: API and worker process roles

- Status: Accepted (updated after M0 review)
- Date: 2026-09-26

## Context

One diagram shows a _Receiver fn (HTTP trigger)_, a queue and a _Sync fn
(Orchestrator)_, which suggests serverless functions. Juniper/Wigmore may use
Azure, but the platform is also meant to become a reusable Wigmore product that
could run for other customers or inside a customer's own environment.

## Decision

1. **Docker-based modular monolith, cloud-neutral.** The same images must run
   on Azure, AWS, another managed container platform, or customer
   infrastructure. The application code contains no cloud-specific SDKs outside
   pluggable adapters (for example a Key Vault `SecretProvider`).
2. **Two process roles from one codebase and one image:**
   - **API** (`dist/main.js`): verifies, persists and enqueues inbound
     webhooks and responds quickly. It also serves OAuth callbacks, the admin
     API and health checks.
   - **Worker** (`dist/worker.js`): consumes queues and does fetch → identity
     → qualification → policy → CRM write → write-back, with retries and audit.
3. **Preferred hosting: Azure Container Apps**, with:
   - Azure Database for PostgreSQL (Flexible Server)
   - Azure Cache for Redis (or Azure Managed Redis)
   - Azure Key Vault (via a `KeyVaultSecretProvider`, added when deployment
     work starts)
   - Azure Monitor / Application Insights, fed through the existing
     OpenTelemetry OTLP export, so no vendor SDK goes into business code
4. **No Kubernetes** unless scale or a customer requirement genuinely needs it.
   Container Apps (or ECS/Fargate on AWS) covers the expected load.
5. **No Azure Functions lock-in.** The receiver → queue → orchestrator
   separation from the diagram is kept as process roles.

## Horizontal scaling without duplicate processing

API and worker replicas must scale out freely. Correctness must never depend
on there being exactly one instance. The mechanisms, introduced in the
milestones noted:

| Risk                                                     | Mechanism                                                                                                                                                    | Milestone |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| The same webhook delivered twice, or to two API replicas | Inbound events are persisted with a unique `(tenant, source, external event id)` key before enqueueing; duplicates are acknowledged and dropped              | M5/M6     |
| Two workers processing the same job                      | BullMQ job locks, plus deterministic job IDs derived from the event key, so a re-enqueue is a no-op                                                          | M6        |
| Two workers acting on the same Lead concurrently         | Per-entity serialisation (job grouping / advisory lock keyed by tenant + entity) and optimistic concurrency (`version` column) on writes                     | M6/M8     |
| A crash after an external write but before recording it  | External-ID cross-reference is checked before any create; outbound writes carry idempotency keys; audit records are written in the same transaction as state | M6–M8     |
| Scheduled jobs (SLA timers, polling) firing N times      | BullMQ repeatable/scheduled jobs with fixed job IDs, not in-process timers                                                                                   | M6/M14    |
| Worker restart mid-job                                   | BullMQ stalled-job recovery and retries with backoff; jobs are idempotent, so replay is safe                                                                 | M6        |

## Consequences

- Ops runs two container apps (API, worker) and a migration job from one image.
- Scaling rules differ: the API scales on HTTP concurrency, workers on queue
  depth (KEDA-style scaling is built into Container Apps).
