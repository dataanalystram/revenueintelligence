# ADR 0003 — Credentials via a SecretProvider abstraction

- Status: Accepted (Milestone 0)
- Date: 2026-09-26

## Context

Credentials must never be committed, must support external secret management,
and will be tenant-scoped (each customer installs the HubSpot app and connects
its own Sugar and Gainsight instances).

## Decision

- Code asks for secrets by logical key, e.g. `hubspot.app.client_secret` or
  `tenant.<tenantId>.sugar.password`, through the `SecretProvider` interface
  (`get` throws `SecretNotFoundError`; `find` returns `undefined`).
- Values come back wrapped in `Secret`, which prints as `[REDACTED]` in
  strings, JSON and `util.inspect`. `reveal()` is called only where the value
  is actually used.
- `EnvSecretProvider` maps keys to environment variables
  (`hubspot.app.client_secret` → `HUBSPOT_APP_CLIENT_SECRET`). It serves local
  development, CI and simple deployments.
- Vault providers are added behind the same interface and selected with
  `SECRETS_PROVIDER`. **Azure Key Vault is the first one** (preferred hosting,
  ADR 0002). It authenticates with a managed identity, so no bootstrap secret
  is needed. AWS Secrets Manager or a customer's vault can follow for other
  deployments.
- OAuth tokens obtained at runtime (HubSpot refresh tokens per installed
  account) will be stored encrypted and tenant-scoped (Milestone 2/3). The
  design for that is part of those milestones.

## Consequences

Business code never reads `process.env` for credentials, so changing where
secrets live does not touch business logic or tests.
