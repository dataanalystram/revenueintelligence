# Architecture

## 1. What the platform does

```
 Gainsight PX / CS ──┐                       ┌──> Sugar CRM (Sales works the Lead)
 (usage, accounts)   │                       │         │
                     ▼                       │         │ stage changes
 HubSpot ───────> Lead Intelligence Platform ┤         ▼
 (forms, score,      │  connectors · sync ·  └──< back to HubSpot (stage, reason,
  Leads)             │  qualification ·            dates) for attribution reporting
                     │  policy · audit
```

The HubSpot → Sugar handover (the Fuelius brief) is the operational pipeline.
The Gainsight signal and qualification work (the Labs working doc) adds new
ways of discovering and qualifying Leads on top of that pipeline. We build the
full platform. The Fuelius documents are the requirements baseline, and the
platform can either coexist with or replace an existing Fuelius integration,
per tenant ([ADR 0004](adr/0004-product-scope-and-fuelius-coexistence.md)).

## Key decisions

| Topic              | Decision                                                                                                                   | ADR                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Stack and versions | TypeScript 6, NestJS 12, Prisma 7, Zod 4, BullMQ                                                                           | [0001](adr/0001-stack-and-version-choices.md)               |
| Hosting            | Cloud-neutral Docker images; preferred Azure Container Apps + PostgreSQL + Redis + Key Vault + App Insights; no Kubernetes | [0002](adr/0002-api-and-worker-process-roles.md)            |
| Secrets            | `SecretProvider` abstraction; Key Vault first vault provider                                                               | [0003](adr/0003-secret-provider.md)                         |
| Scope              | Full platform; coexist with or replace Fuelius per tenant                                                                  | [0004](adr/0004-product-scope-and-fuelius-coexistence.md)   |
| Qualification      | Pluggable providers (rules / Jev / hybrid); humans override; policy separate                                               | [0005](adr/0005-qualification-architecture.md)              |
| Lead creation      | HubSpot owns marketing-sourced Leads; platform owns intelligence-sourced Leads after duplicate checks; true origin kept    | [0006](adr/0006-lead-creation-ownership-and-attribution.md) |
| Domain model       | Immutable canonical entities, Zod schemas, pure behaviour functions                                                        | [0007](adr/0007-canonical-domain-model.md)                  |
| Tenant isolation   | PostgreSQL RLS + mandatory TenantContext/TenantTransaction + composite keys; app runs as a non-privileged role             | [0008](adr/0008-tenant-isolation.md)                        |

## 2. Architectural style: modular monolith

One deployable codebase with strict internal module boundaries, run as two
**process roles** from the same image:

| Role   | Entrypoint      | Responsibility                                                                            |
| ------ | --------------- | ----------------------------------------------------------------------------------------- |
| API    | `src/main.ts`   | Receive webhooks (verify, persist, enqueue, 2xx fast), OAuth callbacks, admin API, health |
| Worker | `src/worker.ts` | Consume queues: fetch, map, cross-reference, write, retry, audit                          |

This maps directly onto the sequence diagram in the brief — _Receiver fn (HTTP
trigger)_ → queue → _Sync fn (orchestrator)_ — without the operational cost of
separate functions or services. See [ADR 0002](adr/0002-api-and-worker-process-roles.md).

## 3. Module boundaries

```
src/
  platform/     config · secrets · logging · database · redis · health · telemetry · http
  modules/      domain · tenancy · hubspot · sugar · gainsight · identity · signals ·
                qualification · policy · orchestration · sync · crossref · mapping · audit
```

| Module                          | Role                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain`                        | Canonical entities: Person, Company, LeadCandidate, Lead, MarketingSignal, ProductSignal, AccountSignal, QualificationDecision, HumanOverride, SalesOutcome (M1) |
| `hubspot`, `sugar`, `gainsight` | Connectors: the only code that knows vendor payloads                                                                                                             |
| `identity`                      | Resolve the same person/company across systems                                                                                                                   |
| `signals`                       | Aggregate signals into LeadCandidates; duplicate/requalification checks                                                                                          |
| `qualification`                 | `QualificationProvider` implementations and mode selection                                                                                                       |
| `policy`                        | SLA, routing and sequence eligibility from the effective decision                                                                                                |
| `orchestration`                 | Drives a Lead's journey across modules                                                                                                                           |
| `sync` / `crossref` / `mapping` | Queues, idempotency, external-ID links, tenant field mappings                                                                                                    |
| `audit`                         | Append-only history of decisions, overrides and outbound writes                                                                                                  |
| `tenancy`                       | Tenants, per-tenant configuration and credentials                                                                                                                |

Rules, enforced in CI by dependency-cruiser (`apps/api/.dependency-cruiser.cjs`):

1. Modules talk to each other only through their `index.ts` public API.
2. `platform` never depends on `modules`.
3. Vendor SDKs are imported only inside their connector module; everything
   else speaks the **canonical domain model**, never HubSpot/Sugar/Gainsight
   native objects.
4. Only persistence layers (`platform/database`, `modules/*/infrastructure/`)
   import the Prisma client.
5. No circular dependencies.

### Connector pattern (from M3/M7/M10)

```
business logic ──> SugarConnector (interface, canonical types)
                      ├── MockSugarConnector   (realistic, based on Sugar REST API)
                      └── RestSugarConnector   (real; swapped in at M17 via config)
```

All external payloads are validated with Zod at the connector edge before they
are translated into canonical types.

## 4. Cross-cutting guarantees (built up over M5–M9)

| Guarantee                              | Mechanism                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Duplicate webhook delivery is safe     | Persist inbound event with a unique (tenant, source, event id) key before enqueueing                  |
| Every write is idempotent              | Idempotency keys + external-ID cross-reference checked before create                                  |
| Transient failures recover             | BullMQ retries with exponential backoff, dead-letter queue                                            |
| Every outbound CRM write is audited    | Audit record per write: tenant, target, payload hash, result, correlation id                          |
| Qualification is explainable           | Store inputs, result, confidence, provider + model version, timestamp                                 |
| AI never acts directly                 | The qualification provider classifies; deterministic policy code decides SLA, routing and CRM actions |
| Unknown customer schema is not guessed | Sugar field names are configuration (field-mapping engine), not code                                  |

## 5. Tenancy and productisation

Juniper is tenant #1. Isolation is enforced in three layers
([ADR 0008](adr/0008-tenant-isolation.md)):

```
module code ──> TenantConfigService / repositories(tx)
                      │ require TenantContext (issued only by TenantContextService)
                      ▼
               TenantDatabase.transaction(ctx, tx => …)
                      │ BEGIN; set_config('app.current_tenant', id, local); status check
                      ▼
               PostgreSQL (app role, RLS forced)
                 tenant_id = app_current_tenant() on every tenant table,
                 composite FKs (tenant_id, id), tenant-scoped unique keys
```

HubSpot OAuth will be implemented as a multi-account app, so future customers
install the same app.

Tenant-specific, never hard-coded:

- credentials and enabled integrations (including coexistence switches)
- field mappings, picklist translations and lead source mappings
  (e.g. HubSpot "Recent conversion" values → canonical channels)
- product catalogue keys
- qualification mode (rules / Jev / hybrid), rule thresholds and ruleset versions
- SLA policy, routing and sequence rules, requalification cool-off windows
- disqualification reason codes and lead type values

## 5a. Qualification and human overrides

See [ADR 0005](adr/0005-qualification-architecture.md). Providers classify
(HOT / WARM / COLD / NEEDS_REVIEW). An active human override always wins, and
later automated results are recorded but never applied over it. Deterministic
policy code turns the effective decision into SLAs and routing.

## 5b. Traceability: "What happened to Lead X?"

Every signal carries a `correlationId` that is propagated to the
LeadCandidate, qualification decisions, the Lead, outbound writes, audit
records, logs and traces. One id reconstructs the journey:

```
source signal → HubSpot Lead → enrichment → qualification (+ overrides)
  → policy / routing → Sugar Lead → stage changes → sales outcome
```

## 6. Configuration and secrets

- Process configuration is validated with Zod at start-up
  (`platform/config`); the process refuses to start on invalid config and
  never prints configuration values.
- Credentials are resolved through the `SecretProvider` interface using
  logical keys (`hubspot.app.client_secret`, `tenant.<id>.sugar.password`).
  The `env` implementation serves local/CI; a vault-backed provider can be
  added without changing callers. See [ADR 0003](adr/0003-secret-provider.md).
- `Secret` values redact themselves in logs, JSON and `util.inspect`.

## 7. Observability

- Structured JSON logs (Pino) with a request id on every line and echoed in
  the `x-request-id` header; credentials and tokens are redacted by path.
- OpenTelemetry tracing (HTTP, Express, NestJS, pg, ioredis) — opt-in via
  `OTEL_ENABLED`.
- Sentry error reporting — opt-in via `SENTRY_DSN`; configured to collect no
  personal data (CRM payloads contain names and emails).
- `/health/live` (process up) and `/health/ready` (PostgreSQL and Redis
  reachable; 503 otherwise) for orchestrators.
