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

## 2. App with a static access token (read-only scopes)

Create an app **inside the test account**. Choose **private distribution** and
**static auth**, using HubSpot's current developer platform: the HubSpot CLI
(`hs project create`) or the in-app project creation. Grant **only** these
read scopes:

| Scope                        | Why                                          |
| ---------------------------- | -------------------------------------------- |
| `crm.objects.contacts.read`  | Read Contacts                                |
| `crm.objects.companies.read` | Read Companies                               |
| `crm.objects.leads.read`     | Read Leads                                   |
| `crm.schemas.contacts.read`  | Contact properties (schema)                  |
| `crm.schemas.companies.read` | Company properties (schema)                  |
| `crm.schemas.leads.read`     | Lead properties, if HubSpot offers the scope |

If HubSpot names a scope differently, discovery reports what it is missing:
each 403 carries HubSpot's `requiredGranularScopes`. Add exactly those. Grant
**no write scopes**. Install the app in the test account and copy its
**access token** (the app's Auth page).

A legacy _private app_ (Settings → Integrations → Private Apps) also yields a
static token. HubSpot stops supporting legacy apps in September 2027, so prefer
the project app.

## 3. Where to store the token and account id

Never paste them into chat, issues, PRs or code.

| Variable                             | Value                         | Secret? |
| ------------------------------------ | ----------------------------- | ------- |
| `TENANT_HSTEST_HUBSPOT_ACCESS_TOKEN` | the app's static access token | **yes** |
| `HUBSPOT_TEST_PORTAL_ID`             | the test account id           | no      |

- **Claude Code cloud session:** environment menu in the session title bar →
  **Edit** → environment variables. A new session picks them up.
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
- The report contains schema and counts only. It is safe to commit, and it
  becomes the evidence in the M3 record.
- For richer evidence, add a few Contacts, Companies and Leads (with
  associations) to the test account first.
