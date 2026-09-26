# ADR 0002 — API and worker process roles instead of serverless functions

- Status: Accepted (Milestone 0) — hosting target still to confirm
- Date: 2026-09-26

## Context

The sequence diagram shows a _Receiver fn (HTTP trigger)_, a queue and a _Sync
fn (Orchestrator)_, which suggests serverless functions (for example Azure
Functions). The approved architecture is a modular monolith.

## Decision

Keep the same logical separation but run it as two process roles built from
one codebase and one image:

- **API** (`dist/main.js`): verifies and persists inbound webhooks, enqueues
  work and responds quickly; also serves OAuth callbacks, the admin API and
  health.
- **Worker** (`dist/worker.js`): consumes BullMQ queues and performs fetch →
  map → cross-reference → write → write-back, with retries and auditing.

## Why

- The receiver stays fast and simple, so HubSpot's webhook timeouts and retries
  are not affected by slow Sugar calls. This is the property the diagram is
  after.
- One codebase, one domain model and one test suite, instead of shared code
  spread across several function apps.
- Portable: runs on any container host (Azure Container Apps, AWS ECS/Fargate,
  Kubernetes, Fly, a VM).
- Scales independently: add worker replicas without scaling the API.

## Open question

Which hosting platform will Wigmore use? It decides which vault-backed
`SecretProvider` and which managed PostgreSQL/Redis we add. It does not change
the code structure.
