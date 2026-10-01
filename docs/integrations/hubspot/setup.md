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

## 7. Milestone 5: the projects-based app

The first real install of the app, and its webhooks ([ADR 0011](../../adr/0011-hubspot-webhooks-and-routing.md)).
Everything here is read-only towards the CRM: the app requests read scopes
only, and the platform only records webhook receipts (identifiers, never
values).

### 7.1 Public HTTPS URL

HubSpot needs a public HTTPS URL for the OAuth redirect and the webhook
target. In development this is a tunnel to the API (port 3000 by default).
The hostname is **never committed**: it goes into two environment variables
and into the rendered app (7.3).

| Option                              | Command                                                          | Credentials               |
| ----------------------------------- | ---------------------------------------------------------------- | ------------------------- |
| Cloudflare Quick Tunnel (preferred) | `cloudflared tunnel --no-autoupdate --url http://localhost:3000` | none                      |
| ngrok (fallback)                    | `ngrok http 3000`                                                | `NGROK_AUTHTOKEN` (yours) |

A Quick Tunnel prints `https://<random>.trycloudflare.com`; the name changes
every time the tunnel starts. **Whenever it changes**, update
`HUBSPOT_APP_REDIRECT_URI` and `HUBSPOT_WEBHOOK_TARGET_URL`, re-render and
re-upload the app (7.3); deliveries signed for the old URL are refused.

The M5 spike result for the Claude Code cloud environment is recorded in the
[M5 record](../../milestones/M05-hubspot-webhooks.md#tunnel-spike): at the
time of writing its network policy refused both providers' hosts.

### 7.2 HubSpot CLI

On the machine that uploads the app (Node **>=22.18.0**):

```bash
npm install -g @hubspot/cli@latest
hs --version
hs account auth        # authenticate the DEVELOPER account (not the test account)
```

`hs account auth` opens HubSpot in the browser to create a personal access
key for the developer account and stores it in the CLI's own config file
(`~/.hscli/config.yml` or `hubspot.config.yml`). That key is yours: do not
commit it, paste it into chat, or put it into this repository.

### 7.3 Render and upload the app

From the repository root, with the tunnel's hostname:

```bash
export HUBSPOT_APP_REDIRECT_URI=https://<host>/oauth/hubspot/callback
export HUBSPOT_WEBHOOK_TARGET_URL=https://<host>/webhooks/hubspot
node hubspot-app/render.mjs          # writes hubspot-app/build/ (git-ignored)
cd hubspot-app/build
hs project upload
```

Expected: the CLI uploads project `lip-lead-intelligence-dev`, reports a
successful build and deploy, and prints a link to the project in the
developer account. If the build fails, copy the error text (it contains no
secrets) into the conversation: for example if HubSpot requires the `oauth`
scope, or names the Leads object type differently in webhook subscriptions.

What the app contains (`hubspot-app/template/`):

| Setting             | Value                                                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distribution / auth | `private` / `oauth`                                                                                                                                                                                                                    |
| Required scopes     | `oauth` (HubSpot's baseline scope, added by HubSpot on upload anyway), `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.leads.read`, `crm.schemas.contacts.read`, `crm.schemas.companies.read` (no write scope) |
| Permitted URLs      | `permittedUrls`: `fetch: ["https://api.hubapi.com"]`, `iframe: []`, `img: []` (static; required by the 2026.03 schema, see below)                                                                                                      |
| Redirect URL        | `https://<host>/oauth/hubspot/callback`                                                                                                                                                                                                |
| Webhook target URL  | `https://<host>/webhooks/hubspot`, max 10 concurrent requests                                                                                                                                                                          |
| Contact webhooks    | creation; property change of `email`, `lifecyclestage`, `hs_lead_status`                                                                                                                                                               |
| Company webhooks    | creation; property change of `name`, `domain`, `lifecyclestage`                                                                                                                                                                        |
| Lead webhooks       | creation; property change of `hs_pipeline_stage`                                                                                                                                                                                       |

`config.permittedUrls` is **required** by HubSpot's 2026.03 project
validation (the first real upload failed with `Missing required field:
'config.permittedUrls'`). It is the allow-list for UI extensions (cards,
settings pages): URLs they may call with `hubspot.fetch`, load in iframes or
use as images, as fully qualified HTTPS URLs. This app has no UI extensions,
so the lists have no effect; the value is HubSpot's own template default.
The OAuth redirect URL and the webhook target URL do **not** belong there,
and neither does the tunnel host. `render.mjs` refuses any rendered app whose
`permittedUrls` differs from this value, and requires the redirect and
webhook URLs to use the same host.

### 7.4 Allow the test account and copy the app's ids

In the developer account: **Development → Projects → lip-lead-intelligence-dev
→ LIP Lead Intelligence (dev)**.

1. **Distribution** tab → add the test account **149338734** as an approved
   (allowlisted) account. A private app can only be installed in allowlisted
   accounts.
2. **Auth** tab: the **Client ID** and **Client secret**. The app's **App ID**
   is shown on the app's overview (and in its URL).

Set them in the cloud environment (environment menu in the session title bar
→ **Edit** → environment variables), never in chat:

| Variable                        | Value                                                 | Secret? |
| ------------------------------- | ----------------------------------------------------- | ------- |
| `HUBSPOT_APP_ID`                | App ID                                                | no      |
| `HUBSPOT_APP_CLIENT_ID`         | Client ID                                             | no      |
| `HUBSPOT_APP_CLIENT_SECRET`     | Client secret                                         | **yes** |
| `HUBSPOT_APP_REDIRECT_URI`      | `https://<host>/oauth/hubspot/callback` (same as 7.3) | no      |
| `HUBSPOT_WEBHOOK_TARGET_URL`    | `https://<host>/webhooks/hubspot` (same as 7.3)       | no      |
| `PLATFORM_TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32`, generated once and kept    | **yes** |

Keep `TENANT_HSTEST_HUBSPOT_ACCESS_TOKEN` and `HUBSPOT_TEST_PORTAL_ID`
unchanged: `hstest` keeps using the Service Key.

### 7.5 Install into the test account

A separate OAuth tenant represents the same test account; `hstest` stays on
its static token, and the two coexist.

```bash
pnpm --filter @lip/api tenant:provision --slug hsoauth --name "HubSpot test account (OAuth)"
pnpm --filter @lip/api hubspot:configure --tenant hsoauth --portal-id "$HUBSPOT_TEST_PORTAL_ID" --auth oauth \
  --ui-domain app-eu1.hubspot.com   # the test account is EU-hosted (dataHostingLocation eu1)
pnpm --filter @lip/api hubspot:install-url --tenant hsoauth   # open the URL, choose the test account, consent
pnpm --filter @lip/api hubspot:discover --tenant hsoauth --out /tmp/oauth-discovery.json
pnpm --filter @lip/api hubspot:webhook-report --tenant hsoauth
```

Webhooks go only to `hsoauth` (the tenant holding the grant), never to
`hstest`.

The consent page opens on the account's own HubSpot web host
(`--ui-domain`, its data-hosting region; default `app.hubspot.com`), at
HubSpot's generic path `/oauth/authorize`, exactly as on the deployed app's
own install link. HubSpot's Account Information API reports the host as
`uiDomain` (the test account: `dataHostingLocation: eu1`). Only HubSpot app
hosts (`app[-<region>].hubspot.com`) are accepted. On the consent page, pick
the tenant's account. Picking another account is refused after the code
exchange, and the grant is revoked.

After the install, collect the live evidence with the
[M5 live-evidence runbook](m5-live-evidence-runbook.md).

### 7.6 Fallback: tunnel and API on a local machine

Use this if the cloud environment cannot run a tunnel (M5 spike: its egress
policy refused `api.trycloudflare.com` and ngrok's hosts). Everything runs on
your machine; nothing inbound is opened (the tunnel connects outbound). The
tunnel is for M5 testing only; it is not the production deployment.

Prerequisites: Docker, Node **>=22.18.0** (`node --version`), `corepack enable`.

```bash
git clone https://github.com/laxmanprasadsomaraju/Garethtasktest && cd Garethtasktest
git checkout claude/blissful-mendel-urbh4r
corepack enable && pnpm install
cp .env.example apps/api/.env          # BEFORE migrating: holds MIGRATION_DATABASE_URL / DATABASE_URL
docker compose up -d postgres redis    # first start also creates the app login role lip_api
set -a; source apps/api/.env; set +a   # the app and CLIs read process env only; repeat in every terminal
pnpm --filter @lip/api prisma:migrate:deploy
pnpm --filter @lip/api build

# Terminal 1: the tunnel to port 3000, either
ngrok http 3000                                                  # prints https://<name>.ngrok-free.app
cloudflared tunnel --no-autoupdate --url http://localhost:3000   # or: https://<random>.trycloudflare.com
```

Put the variables from 7.4 (with the tunnel's hostname) into `apps/api/.env`
(git-ignored). Then render and upload the app (7.3) and allowlist the account
(7.4).

```bash
# Terminal 2: the API
set -a; source apps/api/.env; set +a
pnpm --filter @lip/api start 2>&1 | tee /tmp/lip-api.log   # http://localhost:3000, runs as lip_api
# Terminal 3: the same `set -a; source apps/api/.env; set +a`, then 7.5
```

Send back only safe outputs: `hubspot:webhook-report` JSON, the callback's
response body (`{"status":"installed",…}`), and HTTP status codes. Never send
tokens, the client secret, the tunnel authtoken or webhook bodies.
