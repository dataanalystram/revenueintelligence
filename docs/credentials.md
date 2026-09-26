# Credentials: what is needed, when, and where to put it

**Milestone 0 needs no external credentials.** Nothing below blocks current work.

## Where to put credentials

| Where you run it          | Where credentials go                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Local machine             | `apps/api/.env` (copy from `.env.example`; git-ignored)                                                                                    |
| Claude Code cloud session | The cloud environment's settings: environment menu in the session title bar → **Edit** → environment variables. New sessions pick them up. |
| Deployed environment      | The hosting platform's secret manager (Key Vault / Secrets Manager); selected with `SECRETS_PROVIDER` once a vault provider exists         |

**Never** paste credentials into chat, issues, PRs, commit messages or code.
Use the exact variable names below. The app reads them through the
`SecretProvider`, which maps logical keys to these names.

## By milestone

### M3–M5 — HubSpot developer environment (we create this ourselves; no Juniper access needed)

We build against a **HubSpot developer test account** using the current
**Projects-based developer platform**. The steps below reflect HubSpot's platform
as documented today and are re-checked at the start of M3:

1. Create a free developer account at <https://developers.hubspot.com>.
2. In the developer account, create a **developer test account**. Give it a
   Sales Hub / Marketing Hub Enterprise trial so the **Leads** object and
   Sequences are available.
3. Install the HubSpot CLI (`npm i -g @hubspot/cli`), run `hs account auth`,
   then `hs project create` to create a project containing an app that uses
   **OAuth** authentication. (The project files will live in this repo from
   M3, so these steps are scripted then.)
4. After `hs project upload`, open the app in the developer account. The
   **Auth** tab shows the Client ID and Client secret.

| Variable                    | Where it comes from                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `HUBSPOT_APP_ID`            | App ID shown on the project app's overview                                                      |
| `HUBSPOT_APP_CLIENT_ID`     | App → Auth tab                                                                                  |
| `HUBSPOT_APP_CLIENT_SECRET` | App → Auth tab (also used to verify webhook signatures)                                         |
| `HUBSPOT_APP_REDIRECT_URI`  | We choose it, e.g. `http://localhost:3000/oauth/hubspot/callback`; it must match the app config |
| `HUBSPOT_TEST_ACCOUNT_ID`   | Portal ID of the developer test account                                                         |

Webhooks need a public HTTPS URL. For local testing we will use a tunnel
(for example `cloudflared` or `ngrok`); that is decided at M5.

### M10 — Gainsight CS (read-only)

| Variable                  | Where it comes from                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GAINSIGHT_CS_BASE_URL`   | Your Gainsight CS tenant URL, e.g. `https://<tenant>.gainsightcloud.com`                                                                     |
| `GAINSIGHT_CS_ACCESS_KEY` | Gainsight CS → Administration → Connectors 2.0 → Gainsight API → generate an access key. Use a read-only / least-privilege integration user. |

### M16 — Juniper's real HubSpot (when customer access arrives)

No new variables. Juniper installs our HubSpot app through the OAuth flow, and
the per-account refresh token is stored tenant-scoped by the platform. Nobody
copies tokens by hand.

### M17–M18 — Juniper's real Sugar CRM (when customer access arrives)

Until then M7 uses a realistic mock of Sugar's REST API.

| Variable                                  | Where it comes from                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SUGAR_BASE_URL`                          | Juniper's Sugar instance URL                                                                                         |
| `SUGAR_CLIENT_ID` / `SUGAR_CLIENT_SECRET` | Sugar Admin → OAuth Keys (a dedicated key for this integration)                                                      |
| `SUGAR_USERNAME` / `SUGAR_PASSWORD`       | A dedicated Sugar API user (least privilege; read-only for M17)                                                      |
| `SUGAR_PLATFORM`                          | A custom platform name registered in Sugar Admin → Configure API Platforms, so our sessions don't log out real users |

## Handling rules

- One credential per environment. Never reuse production credentials in development.
- Integration users are dedicated and least-privilege (read-only until M18).
- Rotate immediately if a credential is ever exposed, then tell the team.
