# ADR 0001 — Stack and version choices

- Status: Accepted (Milestone 0)
- Date: 2026-09-26

## Context

The approved stack is TypeScript, NestJS, PostgreSQL, Prisma, Zod, BullMQ,
Redis, a provider abstraction for AI qualification, Next.js, Tailwind/shadcn,
Docker, Vitest/Testcontainers, Pino, OpenTelemetry/Sentry and GitHub Actions.
Within that stack several version choices had to be made.

## Decisions

| Choice         | Version                       | Why                                                                                                                                                                                                                                    |
| -------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js        | 22 LTS                        | Current LTS line supported by every dependency.                                                                                                                                                                                        |
| TypeScript     | **6.0.x (pinned), not 7.0**   | TypeScript 7 (native compiler) is released, but `typescript-eslint` supports `<6.1` and `@nestjs/cli` targets `~6.0`. NestJS DI depends on `emitDecoratorMetadata`; we move to 7 once the tooling supports it.                         |
| NestJS         | 12.x                          | Current major.                                                                                                                                                                                                                         |
| Prisma         | **7.10 (stable), not 8.0-rc** | npm's `latest` tag for the `prisma` CLI points at an 8.0 release candidate; `@prisma/client` latest is 7.10. We pin both to 7.10. Prisma 7 uses the TypeScript `prisma-client` generator with the `@prisma/adapter-pg` driver adapter. |
| Zod            | 4.x                           | Config, and (from M3) every external payload.                                                                                                                                                                                          |
| Vitest         | 5.x + `unplugin-swc`          | SWC is needed because esbuild does not emit the decorator metadata NestJS relies on.                                                                                                                                                   |
| Testcontainers | 12.x                          | Real PostgreSQL and Redis in integration tests. Image names can be overridden (`TEST_POSTGRES_IMAGE`, `TEST_REDIS_IMAGE`) for mirrors.                                                                                                 |
| Pino           | via `nestjs-pino`             | Structured logs, path-based redaction.                                                                                                                                                                                                 |
| Module system  | CommonJS output               | Most battle-tested option for NestJS and its ecosystem.                                                                                                                                                                                |

## Additions (small, mature, low-risk)

- **dependency-cruiser** — enforces module boundaries in CI. Without it, a
  modular monolith gradually loses its boundaries.
- **helmet** — standard security headers on the public webhook/OAuth endpoints.

## Deliberately not used

- `@nestjs/config` — a ~60-line Zod loader gives typed, frozen config with no
  extra abstraction.
- `@nestjs/terminus` — two health checks do not justify the dependency; the
  small health module is fully tested.

## Deferred

- Next.js dashboard — Milestone 21, per the brief ("keep the frontend minimal
  until the backend pipeline is demonstrably working").
- BullMQ — installed and wired in Milestone 6. BullMQ 6 takes `ioredis` as a
  peer dependency, so the `ioredis` 6 client used for health checks is
  compatible.

## Consequences

- Upgrading to TypeScript 7 and Prisma 8 are planned, explicit follow-ups.
- The runtime Docker image is ~800 MB because `@prisma/client`'s optional peer
  pulls in the Prisma CLI. Trimming it is a follow-up and does not affect
  correctness.
