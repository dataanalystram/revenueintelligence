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
ways of discovering and qualifying Leads on top of that pipeline.

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
  modules/      domain · tenancy · hubspot · sugar · gainsight · crossref · mapping ·
                sync · identity · signals · qualification · policy · audit
```

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

## 5. Tenancy

Juniper is tenant #1. From M2 every persistent integration record carries a
`tenant_id`, every query is tenant-scoped, and credentials are stored per
tenant through the secret provider. HubSpot OAuth is implemented as a
multi-account app so future customers install the same app.

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
