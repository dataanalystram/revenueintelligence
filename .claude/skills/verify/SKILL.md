---
name: verify
description: Verify this repository end to end before reporting any milestone or change as complete. Runs the deterministic suite (pnpm verify), runtime verification of the real API/worker against PostgreSQL and Redis, Docker image checks, live connector tests when credentials exist, and a fresh-clone run, then reports exact commands and evidence. Use whenever finishing a milestone, before opening/updating a PR, or when asked to verify, run or prove the app works.
---

# Verify

Evidence beats assertion. Every layer below must pass, and the report must
show the exact command and its result for each one. Runtime and Docker checks
**supplement** `pnpm verify`; they never replace it. Never skip, weaken or
disable a check to get green. If a check fails, fix the cause, or report it
honestly as failing.

Run every command from the repository root. Prerequisites: Docker with
compose v2, Node 22, pnpm 10 (`corepack enable`), curl.

## 1. Deterministic suite

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` = `format:check` → `lint` (type-aware ESLint) → `typecheck` →
`depcheck:boundaries` (dependency-cruiser) → unit tests → integration tests
(Testcontainers: real PostgreSQL and Redis, app connecting as the
non-privileged `lip_app` role). Record the pass counts per step.

## 2. Runtime verification (the running application)

```bash
pnpm verify:runtime
```

`scripts/verify-runtime.sh` does all of the following, on an isolated compose
project with free ports and no credentials:

- builds the app and starts PostgreSQL and Redis
- runs migrations as the schema owner (`MIGRATION_DATABASE_URL`)
- starts the API and the worker as `lip_api`
- checks readiness, HTTP behaviour, tenant provisioning and RLS as seen by the
  app role, resilience (Redis outage and recovery) and refusal of a privileged
  database role
- runs milestone-specific checks from `scripts/verify-runtime.d/*.sh`, if any
  exist (none yet; see the README there)
- shuts down gracefully, proving the real node processes exit, their DB and
  Redis connections close, and their shutdown hooks log completion, then
  removes everything

Add a check script there whenever a milestone adds runtime behaviour. The
script prints `PASS`/`FAIL` per check and exits non-zero on any failure (logs
are kept, and their path printed).

## 3. Docker

```bash
pnpm verify:docker
```

This builds the `runtime` and `migrate` images and checks that both run as a
non-root user and contain no `.env` files. It then runs the migrate job, API,
worker and provisioning CLI as containers and checks readiness. Everything it
creates carries a run-specific label; on exit it removes only those resources,
and fails if any container, volume, network or image of the run remains.
Behind a TLS-intercepting proxy, pass extra
build arguments via `LIP_DOCKER_BUILD_ARGS` or an alternative Dockerfile via
`LIP_DOCKERFILE`. Never commit such environment-specific changes.

## 4. Live connector tests

```bash
pnpm test:live
```

Read-only suites against developer/test accounts only (HubSpot since M3:
`apps/api/test/live/`). The command **fails** when it finds no test files. A
suite without its credentials skips and names the missing variables. Report
that as "live tests: not run (missing X)", never as passing. HubSpot also has
a discovery run (`docs/integrations/hubspot/setup.md` §5) whose report is the
test-account evidence. Never print credential values.

## 5. Fresh clone (mandatory before reporting a milestone complete)

This catches files missing from git (a `.gitignore` rule once hid a whole
source folder), stale generated code and local-only state:

```bash
tmp="$(mktemp -d)" && git clone -q "$(git rev-parse --show-toplevel)" "$tmp/repo" && cd "$tmp/repo" \
  && pnpm install --frozen-lockfile && pnpm verify && pnpm verify:runtime
```

Commit first; the clone only sees committed work.

## 6. Validate the checks themselves (critical guarantees)

A check that has never been seen to fail proves nothing: the original runtime
shutdown check passed while testing a wrapper shell. For each safety or
verification guarantee a change adds or touches, temporarily break the
mechanism and confirm the matching check fails _for that reason_. Look at the
failing check's name and output; a build error or a stopped dependency is not
a valid result. Then restore the code and confirm it passes again. Current
mutation evidence is recorded in `docs/milestones/M02-tenancy-data-isolation.md`.
Mutation-test critical guarantees, not everything.

## 7. Report

For each layer: the command, pass/fail, and key numbers (tests passed per
suite, runtime checks passed). Also include CI status on the PR once pushed,
anything skipped and why, and any defects found and fixed along the way. Keep
it factual. Then ask for an independent review with the `review-milestone`
skill (run in a separate subagent).
