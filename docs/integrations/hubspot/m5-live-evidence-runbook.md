# M5 live-evidence runbook (webhooks, refresh, coexistence)

For the local Mac/ngrok setup, after the real OAuth install of `hsoauth`
succeeded. Developer test account **149338734** only: never Juniper or any
customer or production account. The platform makes **no CRM writes**. The
test records below are created and edited by you in the HubSpot UI of the
test account.

**Never paste into chat**: tokens, the client secret, the ngrok authtoken, the
callback URL from the address bar, webhook bodies, or anything from the ngrok
inspector's request bodies. Send only the outputs named in each step.

## 0. Prepare

```bash
cd Garethtasktest
git pull                                # this runbook's commit or later
pnpm install && pnpm --filter @lip/api build
set -a; source apps/api/.env; set +a    # in every terminal
# Terminal 1: ngrok http 3000            (keep running; same hostname as the uploaded app)
# Terminal 2: restart the API so it runs this build:
pnpm --filter @lip/api start 2>&1 | tee -a /tmp/lip-api.log
```

Evidence commands used throughout (terminal 3, repo root, `.env` sourced):

```bash
# Receipts for the OAuth tenant: counts, types, property names, newest receipts
pnpm --silent --filter @lip/api hubspot:webhook-report --tenant hsoauth --recent 20
# Receipts per tenant, straight from the database (owner role; identifiers only)
docker compose exec -T postgres psql -U lip -d lip -Atc \
  "SELECT t.slug, count(*), sum(r.deliveries), max(r.last_attempt_number)
     FROM tenant_webhook_receipts r JOIN tenants t ON t.id = r.tenant_id GROUP BY t.slug ORDER BY 1"
# Webhook outcomes logged by the API (metadata only)
grep -E 'HubSpot webhook (events recorded|events not routed|refused)' /tmp/lip-api.log | tail -20
```

Expected `objectTypeId`s: contact `0-1`, company `0-2`, lead `0-136`.

Record a start time for `--since`:

```bash
export M5_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "$M5_SINCE"
```

## 1. Contact webhooks

In HubSpot, open test account 149338734 → **CRM → Contacts → Create contact**:

| Field      | Value                                 |
| ---------- | ------------------------------------- |
| Email      | `m5-webhook-test-contact@example.com` |
| First name | `M5 Webhook Test`                     |
| Last name  | `Contact`                             |

Save. Wait 1 minute, then run the report (with `--since "$M5_SINCE"`).

Expected: one `object.creation` with `objectTypeId` `0-1`. HubSpot may also
send `object.propertyChange` events for subscribed properties set at creation
(`email`, `lifecyclestage`); record what actually appears.

Then, on the contact's record, change **Lifecycle stage** to a different value
(for example `Lead` → `Marketing Qualified Lead`). Wait 1 minute and report again.

Expected: an `object.propertyChange` receipt with `propertyName`
`lifecyclestage`, `objectTypeId` `0-1`, the same `objectId` as the creation.

Send back: the report's `byType` and `recent` (IDs and types only), and the
SQL per-tenant counts.

## 2. Company webhooks

**CRM → Companies → Create company**:

| Field          | Value                     |
| -------------- | ------------------------- |
| Company name   | `M5 Webhook Test Company` |
| Company domain | `m5-webhook-test.example` |

Save, wait 1 minute, report. Expected: `object.creation`, `objectTypeId` `0-2`
(plus any creation-time `propertyChange` for `name`/`domain`).

Change **Company domain** to `m5-webhook-test-2.example`. Wait 1 minute and
report. Expected: `object.propertyChange`, `propertyName` `domain`,
`objectTypeId` `0-2`.

## 3. Lead webhooks (do not assume they work)

**CRM → Leads → Create lead** (the Leads object needs Sales Hub; the test
account has it):

| Field              | Value                                                             |
| ------------------ | ----------------------------------------------------------------- |
| Lead name          | `M5 Webhook Test Lead`                                            |
| Associated contact | `M5 Webhook Test Contact` (and the company if the form offers it) |
| Pipeline / stage   | default pipeline, first stage (e.g. `New`)                        |

Save. Wait **5 minutes**, report. Expected per HubSpot's docs:
`object.creation`, `objectTypeId` `0-136`.

Change the lead's **stage** (`hs_pipeline_stage`) to the next stage (e.g.
`Attempting`). Wait **5 minutes**, report. Expected: `object.propertyChange`,
`propertyName` `hs_pipeline_stage`, `objectTypeId` `0-136`.

**If no lead receipt arrives** after both waits:

1. Verify the configuration. In the developer account, open the project →
   app → **Webhooks**. Are the lead subscriptions listed and **active**? In
   the API log, is there an `events not routed` or `refused` line around that
   time? In the ngrok inspector (<http://127.0.0.1:4040>), did any `POST
/webhooks/hubspot` arrive (status only)?
2. Check HubSpot's own delivery log for the app (developer account → app →
   **Monitoring / Logs → Webhooks**, if shown): were lead deliveries attempted?
3. Create one more lead (`M5 Webhook Test Lead 2`) and wait 15 minutes.
4. If still nothing: **stop and send me** the answers to 1–3. Do not add
   scopes yourself. The Webhooks Journal fallback (read-only) needs the extra
   scope `developer.webhooks_journal.read` in the app, a re-upload and a
   re-consent, and code for its non-date-versioned `v4` endpoint. I implement
   it only after confirming that it is needed, and the documented and live
   behaviour are recorded separately.

Contacts and companies arriving while leads do not is the documented
community report ("Project webhook for leads creation not triggering"), not a
platform fault.

## 4. Receipt verification after each step

After each of steps 1–3:

- the report shows the new types/property names, and `recent` shows the
  `objectId`s of the M5 records;
- the per-tenant SQL shows rows **only** for `hsoauth`;
- the API log shows `HubSpot webhook events recorded` (with `tenantId`,
  `types`, `attempts`) and no `refused` lines.

Every stored receipt passed signature v3 verification. Nothing is stored
otherwise, so the receipts themselves are the real-signature evidence.

## 5. Duplicate and retry evidence (safe)

**Replay (duplicate), via the ngrok inspector:**

1. Open <http://127.0.0.1:4040>, select a recent `POST /webhooks/hubspot`
   with status 200. Click **Replay** within 5 minutes of the original.
   Expected response: 200 with `"duplicates"` ≥ 1 and `"stored": 0`. In the
   report, that receipt's `deliveries` went up by 1, and still only one row
   exists.
2. Replay the same request again after more than 5 minutes. Expected: 401
   `invalid_signature`, and the log line `reason: stale_timestamp`. Nothing
   is stored.

Do not copy the request body from the inspector anywhere.

**Retry (HubSpot redelivery):**

1. Stop the API (Ctrl+C in terminal 2). Keep ngrok running.
2. Change the test contact's **Lifecycle stage** again. HubSpot's delivery
   now fails (ngrok answers 502).
3. Wait 2 minutes, start the API again.
4. HubSpot retries with randomised backoff (up to 10 times over 24 hours).
   Wait up to 30 minutes, then report. Expected: the receipt for that change
   has `firstAttemptNumber` ≥ 1 (it was first stored on a retry). The inspector
   shows the earlier 502s.

## 6. Real token refresh and rotation

The evidence CLI prints booleans, timestamps and counts only. It only ever
uses the stored refresh token, so it cannot damage the working grant.

```bash
# One real refresh through the normal path
pnpm --silent --filter @lip/api hubspot:oauth-refresh-evidence --tenant hsoauth
# The new access token works
pnpm --filter @lip/api hubspot:discover --tenant hsoauth --out /tmp/oauth-discovery-after-refresh.json
# Cross-process coordination: expire once, then three processes at once; exactly one refreshes
pnpm --silent --filter @lip/api hubspot:oauth-refresh-evidence --tenant hsoauth --mode expire
for i in 1 2 3; do
  pnpm --silent --filter @lip/api hubspot:oauth-refresh-evidence --tenant hsoauth --mode observe > /tmp/observe-$i.json &
done; wait
node -e 'let n=0; for (const i of [1,2,3]) n += JSON.parse(require("fs").readFileSync(`/tmp/observe-${i}.json`,"utf8")).refreshesPerformedByThisProcess; console.log("refreshes performed:", n)'
grep 'HubSpot access token refreshed' /tmp/lip-api.log | tail -3   # API-process refreshes, if any
```

Expected from the first command:

- `refreshesPerformedByThisProcess: 1`, `accessTokenChanged: true`, a new
  `accessTokenExpiresAt`;
- `expiresInSeconds` (HubSpot documents 1800);
- `grantedScopes` = `oauth` + the 5 read scopes;
- the rotation facts: `hubspotReturnedRefreshToken`,
  `hubspotRotatedRefreshToken`, `storedRefreshTokenChanged`.

The cross-process check must print `refreshes performed: 1`.

**Old refresh token:**

- If `hubspotRotatedRefreshToken` is **false**, the "old" refresh token is the
  current one. Each further refresh (run the first command twice more) proves
  it stays valid.
- If it is **true**: **stop and tell me**. Do not try the old token. HubSpot
  does not document whether reusing a superseded refresh token revokes the
  newer one, so testing it could break the working grant. A safe, disposable
  alternative is decided first.

## 7. Static-token coexistence (`hstest`)

```bash
pnpm --silent --filter @lip/api hubspot:webhook-report --tenant hstest --recent 5     # expect receipts: 0, recent: []
pnpm --filter @lip/api hubspot:discover --tenant hstest --out /tmp/hstest-discovery.json  # Service Key, read-only
node -e 'const r=JSON.parse(require("fs").readFileSync("/tmp/hstest-discovery.json","utf8")); console.log(r.account.portalId, Object.fromEntries(Object.entries(r.objects).map(([k,v])=>[k, v.records?.status])))'
```

Then rerun the per-tenant SQL: only `hsoauth` may appear.

## 8. Zero CRM writes

The platform's CRM transport refuses anything but reads (unit- and
mutation-tested), and webhook intake makes no HubSpot call at all. If the
developer account shows API call logs for the app, filter them: only `GET`
CRM reads, `POST …/batch/read` association reads and `POST
/oauth/2026-09/token` may appear.

## 9. Send back (safe summary)

```text
Contact:  creation received? (Y/N, objectTypeId)  lifecyclestage change received? (Y/N)
Company:  creation received? (Y/N)                domain change received? (Y/N)
Lead:     creation received? (Y/N)                hs_pipeline_stage change received? (Y/N)
          if N: the answers to step 3 (1–3)
Report:   byType + recent (ids/types/attempts) for hsoauth; SQL per-tenant counts
Replay:   within 5 min → status/body;  after 5 min → status
Retry:    firstAttemptNumber of the retried receipt; 502s seen in inspector (count)
Refresh:  the JSON of the first refresh-evidence run; "refreshes performed: N"
hstest:   report receipts; discovery portalId + object statuses
Logs:     count of "events recorded", any "refused"/"not routed" lines (metadata only)
```

When this is in, the evidence goes into the M5 record, followed by:
`pnpm verify`, `pnpm verify:runtime`, the live suite, Docker, a fresh clone,
CI on the exact final commit, and the independent review. Merge only after
that.

Leave the M5 test records in HubSpot until the review is done. Deleting them
later from the UI is optional. Deletions are not subscribed, so they produce
no receipts.
