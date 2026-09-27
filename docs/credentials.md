# Credentials: what is needed, when, and where to put it

**Milestone 3 needs one credential that you create yourself:** a HubSpot
developer test account app token (see M3 below). No Juniper credentials are
needed until M16.

## Where to put credentials

| Where you run it          | Where credentials go                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Local machine             | `apps/api/.env` (copy from `.env.example`; git-ignored)                                                                                    |
| Claude Code cloud session | The cloud environment's settings: environment menu in the session title bar → **Edit** → environment variables. New sessions pick them up. |
| Deployed environment      | The hosting platform's secret manager (Key Vault / Secrets Manager); selected with `SECRETS_PROVIDER` once a vault provider exists         |

**Never** paste credentials into chat, issues, PRs, commit messages or code.
Use the exact variable names below. The app reads them through the
`SecretProvider`, which maps logical keys to these names.

### Platform credentials vs tenant credentials (Milestone 2)

- **Platform credentials** belong to Wigmore's own HubSpot app and are the
  same for every customer: `HUBSPOT_APP_*`.
- **Tenant credentials** belong to one customer: its Sugar login, its
  Gainsight access key, and later its HubSpot refresh token. Each is:
  1. **registered** for the tenant, which stores only a reference (e.g.
     `tenant.juniper.sugar.password`) in the database, and
  2. **supplied** under the matching name, `TENANT_<SLUG>_<SYSTEM>_<NAME>`,
     e.g. `TENANT_JUNIPER_SUGAR_PASSWORD`.

  A tenant can only ever resolve its own credentials. The key is derived from
  its slug, and the database enforces this. Non-secret connection details
  (base URLs, API versions, portal ids) are tenant _integration settings_, not
  environment variables.

### Database credentials (Milestone 2)

Two per environment: `MIGRATION_DATABASE_URL` (schema owner, migrations only)
and `DATABASE_URL` (a non-privileged member of `lip_app`, used by the API,
worker and CLI). See [operations/database-roles.md](operations/database-roles.md).

## By milestone

### M3 — HubSpot developer test account (we create this ourselves; no Juniper access needed)

Full steps: [integrations/hubspot/setup.md](integrations/hubspot/setup.md). In
short: a free developer account, a **developer test account** (includes a
Sales Hub Enterprise trial, so Leads exist), and a **Service Key** with
**read-only scopes** (Development → Keys → Service Keys). No legacy private app.

| Variable                             | Where it comes from                      | Secret? |
| ------------------------------------ | ---------------------------------------- | ------- |
| `TENANT_HSTEST_HUBSPOT_ACCESS_TOKEN` | The test account's read-only Service Key | yes     |
| `HUBSPOT_TEST_PORTAL_ID`             | The test account's id                    | no      |

`hstest` is the platform tenant that represents the test account. The key is
its generic tenant credential `hubspot.access_token` (any bearer credential:
Service Key, static app token or, later, OAuth access token), registered by
`hubspot:configure`. The cloud environment must also allow outbound HTTPS to
`api.hubapi.com` (environment settings → Network access).

### M4 — OAuth architecture (built; nothing to set for M4)

M4 builds the complete OAuth install and refresh flow and tests it against a
local fake HubSpot ([ADR 0010](adr/0010-crm-connector-port-and-oauth.md)).
**No new credentials were needed for M4**: tests generate their own keys, and
the live checks keep using the test account's Service Key.

When the first real install happens (M5), the environment needs:

| Variable                        | Where it comes from                                                                        | Secret? |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ------- |
| `HUBSPOT_APP_CLIENT_ID`         | The projects-based app → Auth                                                              | no      |
| `HUBSPOT_APP_CLIENT_SECRET`     | The projects-based app → Auth (also verifies webhook signatures, M5)                       | **yes** |
| `HUBSPOT_APP_REDIRECT_URI`      | We choose it (the public callback, `…/oauth/hubspot/callback`); must match the app exactly | no      |
| `PLATFORM_TOKEN_ENCRYPTION_KEY` | Generated once per environment: `openssl rand -base64 32`                                  | **yes** |

`PLATFORM_TOKEN_ENCRYPTION_KEY` encrypts every tenant's stored OAuth tokens
(AES-256-GCM) and signs install states. Losing or changing it makes stored
grants unreadable, and those tenants must reinstall the app. Tenants' refresh
and access tokens are never set by hand: the platform stores them, encrypted,
in `tenant_oauth_tokens` when a tenant installs the app.

### M5 — Webhooks (planned)

Webhooks need a public HTTPS URL. For local testing we will use a tunnel
(for example `cloudflared` or `ngrok`); that is decided at M5, together with
the first real OAuth install.

### M10 — Gainsight CS (read-only)

| Setting                                  | Where it goes                                        | Where it comes from                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL                                 | Tenant integration settings (`gainsight_cs.baseUrl`) | Your Gainsight CS tenant URL, e.g. `https://<tenant>.gainsightcloud.com`                                                                     |
| `TENANT_JUNIPER_GAINSIGHT_CS_ACCESS_KEY` | Secret (env / Key Vault)                             | Gainsight CS → Administration → Connectors 2.0 → Gainsight API → generate an access key. Use a read-only / least-privilege integration user. |

### M16 — Juniper's real HubSpot (when customer access arrives)

No new variables. Juniper installs our HubSpot app through the OAuth flow, and
the per-account refresh token is stored tenant-scoped by the platform. Nobody
copies tokens by hand.

### M17–M18 — Juniper's real Sugar CRM (when customer access arrives)

Until then M7 uses a realistic mock of Sugar's REST API.

| Setting                                                                 | Where it goes                                                                       | Where it comes from                                                                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL, API version, platform                                         | Tenant integration settings (`sugar.baseUrl`, `sugar.apiVersion`, `sugar.platform`) | Juniper's Sugar instance. The platform is a custom name registered in Sugar Admin → Configure API Platforms, so our sessions don't log out real users |
| `TENANT_JUNIPER_SUGAR_CLIENT_ID` / `TENANT_JUNIPER_SUGAR_CLIENT_SECRET` | Secret                                                                              | Sugar Admin → OAuth Keys (a dedicated key for this integration)                                                                                       |
| `TENANT_JUNIPER_SUGAR_USERNAME` / `TENANT_JUNIPER_SUGAR_PASSWORD`       | Secret                                                                              | A dedicated Sugar API user (least privilege; read-only for M17)                                                                                       |

## Handling rules

- One credential per environment. Never reuse production credentials in development.
- Integration users are dedicated and least-privilege (read-only until M18).
- Rotate immediately if a credential is ever exposed, then tell the team.
