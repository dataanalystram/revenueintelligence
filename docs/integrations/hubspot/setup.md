# HubSpot developer test environment: setup

This is what a person must create by hand before the platform can run live
discovery. It needs **no Juniper access and no Juniper credentials**. Never use
a customer's production account or token here.

## 1. Developer account and test account

1. Create a free HubSpot developer account at <https://developers.hubspot.com>.
2. In it, open **Test accounts** and create a **developer test account**. It
   comes with 90-day Enterprise trials, including Sales Hub Enterprise, which
   the **Leads** object needs.
   - A test account expires after 90 days without API calls. It can be
     renewed from the Test accounts page.
3. Note the test account's **account id** (portal id), shown in the account
   menu. It is not a secret.

## 2. Service Key with read-only scopes

For this read-only, system-to-system discovery, use a **HubSpot Service Key**.
It is an account-level credential for data-only REST integrations, in public
beta since February 2026, and it replaces legacy private apps for this use.
**Do not create a new legacy private app**: HubSpot stops supporting legacy
apps in September 2027.

In the test account: **Development → Keys → Service Keys** → create a key and
grant **only** these read scopes:

| Scope                        | Why                                          |
| ---------------------------- | -------------------------------------------- |
| `crm.objects.contacts.read`  | Read Contacts                                |
| `crm.objects.companies.read` | Read Companies                               |
| `crm.objects.leads.read`     | Read Leads                                   |
| `crm.schemas.contacts.read`  | Contact properties (schema)                  |
| `crm.schemas.companies.read` | Company properties (schema)                  |
| `crm.schemas.leads.read`     | Lead properties, if HubSpot offers the scope |

Grant **no write scopes**. If HubSpot names a scope differently, discovery
reports what is missing (each 403 carries HubSpot's `requiredGranularScopes`);
add exactly those.

A Service Key is sent as `Authorization: Bearer <key>`, exactly like an app's
static or OAuth access token. The platform therefore stores it as the tenant's
generic `hubspot.access_token` credential. Nothing outside the credential
store knows which kind of HubSpot credential it is.

Service Keys cannot receive webhooks or use other developer-platform features.
Long term:

- **Service Key or static token:** isolated test and internal integrations,
  such as this one.
- **Projects-based app with OAuth:** Juniper and future multi-tenant customer
  installs (M4/M16), including webhooks (M5).

## 3. Where to store the token and account id

Never paste them into chat, issues, PRs or code.

| Variable                             | Value               | Secret? |
| ------------------------------------ | ------------------- | ------- |
| `TENANT_HSTEST_HUBSPOT_ACCESS_TOKEN` | the Service Key     | **yes** |
| `HUBSPOT_TEST_PORTAL_ID`             | the test account id | no      |

- **Claude Code cloud session (use this):** environment menu in the session
  title bar → **Edit** → environment variables. Start a new session afterwards,
  because running sessions do not see new values.
- **Local machine:** `apps/api/.env` (git-ignored).

`hstest` is the platform tenant that represents the test account. The variable
name follows the tenant credential convention `TENANT_<SLUG>_<SYSTEM>_<NAME>`
(docs/credentials.md).

## 4. Network access

The cloud environment must allow outbound HTTPS to **`api.hubapi.com`**.
Change this under the same environment settings → **Network access** (add the
host to the allowed domains). Without it, every call fails with a connection
error before reaching HubSpot.

## 5. Run discovery (read-only)

```bash
pnpm --filter @lip/api build
pnpm --filter @lip/api tenant:provision --slug hstest --name "HubSpot test account"
pnpm --filter @lip/api hubspot:configure --tenant hstest --portal-id "$HUBSPOT_TEST_PORTAL_ID"
pnpm --filter @lip/api hubspot:discover --tenant hstest --out docs/integrations/hubspot/discovery-report.json
pnpm test:live
```

- `hubspot:configure` sets the tenant's HubSpot integration to **read_only**
  and registers the credential reference. It never reads or prints the token.
- `hubspot:discover` refuses anything but a developer test or sandbox account.
- The report contains schema, counts and sampled record **ids**, never record
  field values. For the test account it is safe to commit, and it becomes the
  evidence in the M3 record. Review a report from a customer account before
  sharing it: property names and picklist values are the customer's schema.
- For richer evidence, add a few Contacts, Companies and Leads (with
  associations) to the test account first.

## 6. OAuth app installs (Milestone 4 architecture; first real install at M5)

Customer tenants (Juniper and later) authenticate through the projects-based
app's OAuth install instead of a Service Key ([ADR 0010](../../adr/0010-crm-connector-port-and-oauth.md)).
M4 builds and tests the whole flow against a local fake; the steps below are
what M5 will run for real, once the app and a public callback URL exist.

```bash
pnpm --filter @lip/api hubspot:configure --tenant <slug> --portal-id <account id> --auth oauth
pnpm --filter @lip/api hubspot:install-url --tenant <slug>   # open the printed URL, consent
# HubSpot redirects to GET /oauth/hubspot/callback on the API → grant stored encrypted
pnpm --filter @lip/api hubspot:discover --tenant <slug>       # reads through the CrmReader port
```

- The install link targets the configured account, requests **read-only
  scopes only**, and carries a signed state that works once and expires after
  10 minutes.
- The callback stores nothing unless the account HubSpot reports equals the
  tenant's `portalId`.
- A link is burned by its first callback, even a failed one (for example
  HubSpot unavailable during the code exchange): request a new one with
  `hubspot:install-url`.
- Needs `HUBSPOT_APP_CLIENT_ID`, `HUBSPOT_APP_CLIENT_SECRET`,
  `HUBSPOT_APP_REDIRECT_URI` and `PLATFORM_TOKEN_ENCRYPTION_KEY` (see
  [credentials](../../credentials.md)). Static-token tenants such as `hstest`
  need none of them.
