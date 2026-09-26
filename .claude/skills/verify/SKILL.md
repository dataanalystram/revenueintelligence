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
- runs milestone-specific checks from `scripts/verify-runtime.d/*.sh`
- shuts down gracefully and removes everything

Add a check script there whenever a milestone adds runtime behaviour. The
script prints `PASS`/`FAIL` per check and exits non-zero on any failure (logs
are kept, and their path printed).

## 3. Docker

```bash
pnpm verify:docker
```

This builds the `runtime` and `migrate` images, checks the runtime image runs
as a non-root user, runs the migrate job, API, worker and provisioning CLI as
containers, and checks readiness. Behind a TLS-intercepting proxy, pass extra
build arguments via `LIP_DOCKER_BUILD_ARGS` or an alternative Dockerfile via
`LIP_DOCKERFILE`. Never commit such environment-specific changes.

## 4. Live connector tests (only when credentials are configured)

```bash
pnpm test:live
```

These run against real external test environments (e.g. a HubSpot developer
test account). They skip, reporting the missing variable names, when
credentials are absent. Say explicitly which ones ran and which were skipped.
Never print or log credential values.

## 5. Fresh clone (mandatory before reporting a milestone complete)

This catches files missing from git (a `.gitignore` rule once hid a whole
source folder), stale generated code and local-only state:

```bash
tmp="$(mktemp -d)" && git clone -q "$(git rev-parse --show-toplevel)" "$tmp/repo" && cd "$tmp/repo" \
  && pnpm install --frozen-lockfile && pnpm verify && pnpm verify:runtime
```

Commit first; the clone only sees committed work.

## 6. Report

For each layer: the command, pass/fail, and key numbers (tests passed per
suite, runtime checks passed). Also include CI status on the PR once pushed,
anything skipped and why, and any defects found and fixed along the way. Keep
it factual. Then ask for an independent review with the `review-milestone`
skill (run in a separate subagent).
