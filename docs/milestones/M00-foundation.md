# Milestone 0 — Repository / infrastructure foundation

- Status: **Complete — awaiting review**
- Date: 2026-09-26
- Branch: `claude/blissful-mendel-urbh4r`

## Goal

A production-grade skeleton that every later milestone builds on: workspace,
tooling, configuration, secrets abstraction, logging, database and Redis
connectivity, health checks, observability hooks, containers, CI and enforced
module boundaries. **No business functionality** is included; that starts at M1.

## Delivered

| Area          | What exists                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace     | pnpm workspace (`apps/*`), Node 22, TypeScript 6 strict (`noUncheckedIndexedAccess` etc.)                                                                                      |
| Processes     | `apps/api` with two entrypoints from one codebase: `main.ts` (HTTP API) and `worker.ts` (worker; queue processors arrive in M6)                                                |
| Config        | Zod-validated env → typed, frozen `AppConfig`; fails fast; error messages never echo values                                                                                    |
| Secrets       | `SecretProvider` interface, `EnvSecretProvider`, self-redacting `Secret` type                                                                                                  |
| Logging       | Pino JSON logs, request-id generation/propagation (`x-request-id`), path-based redaction of credentials and tokens, health probes not logged                                   |
| Database      | PostgreSQL via Prisma 7 + `@prisma/adapter-pg`; migration pipeline (`prisma migrate deploy`) wired; no domain tables yet                                                       |
| Redis         | Shared ioredis client; fail-fast (no offline queue); the app boots even if Redis is down and readiness reports it                                                              |
| Health        | `GET /health/live` (liveness) and `GET /health/ready` (PostgreSQL + Redis, concurrent, per-check timeout, 503 on failure, no internals in response)                            |
| HTTP          | helmet security headers, `x-powered-by` removed, raw body kept (for webhook signatures in M5), one error shape, 5xx details hidden and reported                                |
| Observability | OpenTelemetry (HTTP/Express/Nest/pg/ioredis) and Sentry (errors only, no personal data), both opt-in by env                                                                    |
| Boundaries    | dependency-cruiser rules: module public APIs only, platform ↛ modules, vendor SDKs only in connectors, Prisma only in persistence layers, no cycles, no test code in prod      |
| Containers    | Multi-stage `Dockerfile` (runtime runs as non-root `node`, `HEALTHCHECK`; `migrate` target) and `docker-compose.yml` (postgres, redis; `--profile app` for migrate/api/worker) |
| CI            | GitHub Actions: format, lint, typecheck, boundaries, unit tests; integration tests (Testcontainers); Docker build                                                              |
| Docs          | README, architecture, 3 ADRs, credentials guide, delivery plan, this record                                                                                                    |

## Definition of Done

| #   | Criterion                                                        | Result                                                                                                                                                                    |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fresh clone installs with a frozen lockfile                      | ✅ `pnpm install --frozen-lockfile`                                                                                                                                       |
| 2   | Formatting, lint (type-aware), strict typecheck pass             | ✅                                                                                                                                                                        |
| 3   | Module-boundary rules pass **and demonstrably catch violations** | ✅ Temporary violating files triggered `platform-must-not-depend-on-modules`, `modules-use-public-api-only` and `prisma-client-only-in-persistence-layers`; files removed |
| 4   | Unit tests incl. negative cases                                  | ✅ 69 passing                                                                                                                                                             |
| 5   | Integration tests against real PostgreSQL and Redis              | ✅ 12 passing (Testcontainers)                                                                                                                                            |
| 6   | Readiness correctly degrades when each dependency fails          | ✅ Redis stopped → 503 `redis: down`; PostgreSQL stopped → 503 `database: down`; liveness stays 200                                                                       |
| 7   | Clean shutdown releases all DB connections                       | ✅ 3 boot/close cycles → 0 remaining connections (measured by an independent client)                                                                                      |
| 8   | Invalid config refuses to start without leaking values           | ✅ Unit tested; manually confirmed with the built binary                                                                                                                  |
| 9   | Built artefacts run: API, worker, Docker image                   | ✅ `node dist/main.js`, `node dist/worker.js`, and container `lip-api:m0` all report ready against PostgreSQL + Redis                                                     |
| 10  | No credentials in the repo; `.env` ignored; template provided    | ✅ `.env.example` has placeholders only                                                                                                                                   |

### Test evidence (final run)

```
pnpm verify
  prettier --check       All matched files use Prettier code style!
  eslint                 0 problems
  tsc --noEmit           0 errors
  depcruise              no dependency violations found (73 modules, 141 dependencies)
  vitest (unit)          Test Files 8 passed · Tests 69 passed
  vitest (integration)   Test Files 2 passed · Tests 12 passed
```

Unit coverage: 72% statements / 86% branches. The uncovered lines are Nest
module wiring and process entrypoints, which the integration tests exercise.

### Test inventory

- **Config** (16): defaults, coercion, both URL schemes, immutability, every
  required var reported, 9 invalid-value cases, OTLP cross-field rule, no
  value leakage.
- **Secrets** (16): key→env mapping, 7 malformed keys rejected (including path
  traversal), get/find semantics, redaction in string/JSON/inspect.
- **Logging** (12): request-id reuse/regeneration (6 hostile inputs), header and
  nested-payload redaction, level mapping, probe suppression.
- **Health** (6): all up, partial failure, no error leakage, timeout of a hanging
  check, concurrency, empty set.
- **HTTP errors** (6): 4xx pass-through, validation arrays, string exceptions,
  hidden 5xx internals + Sentry report, non-Error throws.
- **Telemetry** (5): disabled by default, Sentry PII-free config, OTel service
  naming, shutdown tolerates exporter failure, error forwarding.
- **Redis** (8): boot with Redis down, error events handled, graceful vs forced
  shutdown, PING validation, fail-fast client options.
- **Integration — API** (10): migrations apply and re-apply, liveness,
  readiness, request-id propagation/generation, security headers, error shape,
  Redis outage, PostgreSQL outage.
- **Integration — Worker** (2): boots without HTTP, DB reachable, secret
  provider wired, no connection leaks.

## Decisions and deviations

See [ADR 0001](../adr/0001-stack-and-version-choices.md),
[ADR 0002](../adr/0002-api-and-worker-process-roles.md) and
[ADR 0003](../adr/0003-secret-provider.md). In short:

- TypeScript is pinned to **6.0**, not 7.0: the lint tooling and Nest CLI don't support 7 yet.
- Prisma is pinned to **7.10**, the stable release, not the 8.0 RC on npm's `latest` tag.
- Added **dependency-cruiser** (boundary enforcement) and **helmet** (security headers).
- Skipped `@nestjs/config` and `@nestjs/terminus`; small, tested in-house equivalents.
- The Next.js app is deferred to M21.

## Conflicts / gaps found in the supplied documents

These don't block M0. They need an answer before the milestone in brackets.

1. **Serverless vs modular monolith** [hosting, before M5]: the diagram shows
   "Receiver fn" and "Sync fn". We keep that separation as API and worker
   processes (ADR 0002). Which hosting platform is the target?
2. **Two Lead creators** [M11/M14]: in the Fuelius brief, HubSpot workflows
   create Leads (form / score > 65). In the Labs vision, the platform creates
   Leads from Gainsight signals. Proposal: HubSpot workflows stay the creator
   for form and score triggers, and the platform only syncs those; the platform
   creates HubSpot Leads through the API only for signal-based triggers (PX/CS).
   One rule set also stops duplicates.
3. **Who owns the temperature (Lead Label)?** [M12–M14]: the brief sets
   Hot/Warm/Cold in HubSpot workflows and lets Sales edit it in Sugar (two-way).
   The qualification provider will also classify. We need a precedence rule,
   e.g. a human edit always wins and the AI value is advisory.
4. **"Lead type" values collide with stage names** [M1]: "New business /
   Up-sell / Attempting". The whiteboard asks whether "Still being attempted"
   is needed. The canonical model will treat Lead Type values as configurable
   until confirmed.
5. **HubSpot webhooks for the Leads object** [M3/M5 risk]: we must confirm that
   the Projects platform's webhook subscriptions support Lead (`0-136`)
   creation events. Fallbacks: a workflow "send webhook" action (needs
   Operations Hub) or polling with a `hs_lastmodifieddate` watermark.
6. **Sugar return path** [M19]: the diagram assumes Sugar sends a "stage
   changed" hook. That needs a Sugar logic hook / web logic hook configured on
   Juniper's instance. We must confirm it's allowed; polling is the fallback.
7. **Sequence enrolment** [M14]: API enrolment into HubSpot Sequences needs
   connected Sales inboxes and Sales Hub seats. The brief already lists this as
   a dependency.
8. **Relationship to Fuelius** [now]: the brief is addressed to Fuelius as the
   implementer. Does this platform replace that build, or complement it (for
   example, Fuelius configures HubSpot workflows and Sugar fields while this
   platform does sync and intelligence)?

## Open questions for the reviewer

- What exactly is **"TypeSafe AI/Jev"**? Is Jev an internal model or service,
  or should M12 use a provider abstraction over a hosted LLM (for example
  Claude via the Anthropic SDK) with structured, schema-validated output?
- Target hosting platform (decides the vault `SecretProvider`, managed Postgres/Redis).
- Confirm the pinned TypeScript 6 / Prisma 7 choices.

## Follow-ups (non-blocking)

- Trim the runtime image (~800 MB): `@prisma/client`'s optional peer pulls in the Prisma CLI.
- Upgrade to TypeScript 7 and Prisma 8 once the tooling supports them.
