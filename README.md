# Juniper / Wigmore Lead Intelligence Platform

An integration and decision layer that turns buying signals (HubSpot forms and
lead score, Gainsight PX/CS product and account data) into well-formed Leads,
hands them to Sales in Sugar CRM with the right SLA, and records what happened
next so Marketing can see which activity produces revenue.

- **HubSpot** — marketing system; Leads are created and prepared here.
- **Sugar CRM** — where Sales works the Lead (New → Attempting → Connected → Qualified / Disqualified).
- **Gainsight CS / PX** — product-usage and account signals that enrich and qualify Leads.
- **This platform** — connectors, sync, idempotency, audit, qualification and
  business policy (SLA, routing), multi-tenant from day one (Juniper is tenant #1).

See [docs/architecture.md](docs/architecture.md) for the design and
[docs/milestones/README.md](docs/milestones/README.md) for the delivery plan.

## Status

| Milestone                                   | State                                                     |
| ------------------------------------------- | --------------------------------------------------------- |
| M0 — Repository / infrastructure foundation | ✅ Complete — [record](docs/milestones/M00-foundation.md) |
| M1 — Canonical domain model                 | Not started (awaiting M0 review)                          |

## Stack

TypeScript · NestJS (modular monolith) · PostgreSQL + Prisma · Zod · BullMQ +
Redis · Pino · OpenTelemetry · Sentry · Vitest + Testcontainers · Docker ·
GitHub Actions. Next.js + Tailwind/shadcn for the dashboard (Milestone 21).

## Repository layout

```
apps/api/                 Backend: one codebase, two process roles
  src/main.ts             HTTP API process (webhooks, OAuth, admin API)
  src/worker.ts           Background worker process (queue consumers from M6)
  src/platform/           Cross-cutting infrastructure (config, secrets, logging,
                          database, redis, health, telemetry, http)
  src/modules/            Business modules / bounded contexts (added per milestone)
  prisma/                 Schema and migrations
  test/                   Integration tests (real PostgreSQL + Redis via Testcontainers)
docs/                     Architecture, ADRs, milestone records, credentials guide
```

## Getting started

Prerequisites: Node.js 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker.

```bash
pnpm install
cp .env.example apps/api/.env          # local only; git-ignored
docker compose up -d postgres redis
pnpm --filter @lip/api prisma:migrate:deploy
pnpm --filter @lip/api dev             # API on http://localhost:3000
pnpm --filter @lip/api dev:worker      # worker process
curl localhost:3000/health/ready
```

Run everything in containers instead: `docker compose --profile app up --build`.

## Quality gates

| Command                    | What it checks                                           |
| -------------------------- | -------------------------------------------------------- |
| `pnpm format:check`        | Prettier formatting                                      |
| `pnpm lint`                | ESLint with type-aware rules (e.g. no floating promises) |
| `pnpm typecheck`           | TypeScript strict mode                                   |
| `pnpm depcheck:boundaries` | Module-boundary rules (dependency-cruiser)               |
| `pnpm test:unit`           | Unit tests                                               |
| `pnpm test:integration`    | Integration tests — needs Docker                         |
| `pnpm verify`              | All of the above                                         |

CI (`.github/workflows/ci.yml`) runs every gate plus a Docker image build on
each pull request.

## Credentials

No external credentials are needed for Milestone 0. What is needed later, where
to obtain it and where to put it is in [docs/credentials.md](docs/credentials.md).
Never commit credentials; `.env` files are git-ignored.
