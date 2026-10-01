# M6 live-evidence runbook (context processing on the test account)

Owner-run, on the same local setup as M5 (Mac, ngrok, `hsoauth` tenant with a
real OAuth install). Developer test account **149338734** only: never Juniper
or any customer or production account. The platform makes **no CRM writes**;
you create, edit, delete, restore and merge **test records** in the HubSpot UI
yourself.

**Never paste into chat**: tokens, the client secret, the ngrok authtoken,
callback URLs, webhook bodies, or record values. Send only the outputs named in
each step (they contain identifiers, counts, states and hashes only).

**Stop and report** (do not work around) if: HubSpot asks for any scope other
than the current read scopes when you upload the app; any command shows a
write request to HubSpot; a record value appears in a log or command output;
anything touches an account other than 149338734.

## 0. Prepare

```bash
cd Garethtasktest && git pull                     # the M6 PR head
pnpm install && pnpm --filter @lip/api build
set -a; source apps/api/.env; set +a              # in every terminal
docker compose up -d postgres redis               # Redis now runs with noeviction
pnpm --filter @lip/api prisma:migrate:deploy      # applies the two M6 migrations
# Terminal 1: ngrok http 3000 (same hostname as the uploaded app)
# Terminal 2: API      pnpm --filter @lip/api start 2>&1 | tee -a /tmp/lip-api.log
# Terminal 3: worker   pnpm --filter @lip/api start:worker 2>&1 | tee -a /tmp/lip-worker.log
```

Confirm the worker log says `Context processors registered`.

Evidence commands (terminal 4):

```bash
pnpm --silent --filter @lip/api context:report --tenant hsoauth
pnpm --silent --filter @lip/api context:show --tenant hsoauth --kind person --ref hubspot:contacts:<id>
pnpm --silent --filter @lip/api context:state-hash --tenant hsoauth
grep -E '"level":(40|50)' /tmp/lip-worker.log | tail -5
```

## 1. Upload the app with the M6 lifecycle subscriptions

The template now adds `object.deletion`, `object.restore`, `object.merge` and
`object.associationChange` for contacts and companies (ADR 0015). Scopes are
unchanged.

```bash
HUBSPOT_APP_REDIRECT_URI=... HUBSPOT_WEBHOOK_TARGET_URL=... node hubspot-app/render.mjs --check
# then render to the project folder and upload as in setup.md §7.3
```

Report: whether the upload succeeded; whether HubSpot rejected any
subscription (expected risk: company `object.merge`; if rejected, remove that
one entry, re-upload and report); that the app's scopes are still exactly
`oauth` + the five CRM read scopes.

## 2. Gate 1 confirmation: the search endpoint (read-only)

Already confirmed by `pnpm test:live` (static token, ADR 0015); repeat it
here through the OAuth tenant.

```bash
pnpm --silent --filter @lip/api context:reconcile --tenant hsoauth --kind all --since 2026-01-01T00:00:00Z --execute
```

Then `context:report`. Report the reconcile checkpoints (status, pages,
records seen) and any dead letter. This calls only
`POST /crm/objects/2026-03/{contacts|companies}/search` (verified in ADR 0015).
If the run fails with `source_not_found` or `source_bad_request` on search,
report it: it would mean the documented path differs live.

## 3. Backfill (read-only)

```bash
pnpm --silent --filter @lip/api context:backfill --tenant hsoauth --kind all            # dry run
pnpm --silent --filter @lip/api context:backfill --tenant hsoauth --kind all --execute
pnpm --silent --filter @lip/api context:report --tenant hsoauth
pnpm --silent --filter @lip/api context:state-hash --tenant hsoauth                     # H1
pnpm --silent --filter @lip/api context:backfill --tenant hsoauth --kind all --execute  # rerun
pnpm --silent --filter @lip/api context:state-hash --tenant hsoauth                     # H2 (= H1)
```

Report: checkpoint counts, persons/companies by state, H1 and H2.

## 4. Historical M5 receipts, twice

```bash
pnpm --silent --filter @lip/api context:receipts --tenant hsoauth --only-reason pre_m6                # dry run
pnpm --silent --filter @lip/api context:receipts --tenant hsoauth --only-reason pre_m6 --execute
pnpm --silent --filter @lip/api context:report --tenant hsoauth
pnpm --silent --filter @lip/api context:state-hash --tenant hsoauth                                   # H3
pnpm --silent --filter @lip/api context:receipts --tenant hsoauth --since <M5 start> --until <M5 end> --include-finished --execute
pnpm --silent --filter @lip/api context:state-hash --tenant hsoauth                                   # H4 (= H3)
```

Report: the dry-run counts by status, receipts by status afterwards (expected:
contact/company receipts `processed` or `source_not_found` for records
deleted since; Lead receipts `deferred:lead_out_of_scope`), H3 and H4.

## 5. Live changes through webhooks

In the test account:

1. Create contact `m6-test-contact@example.com` (first name `M6`), and company
   `M6 Test School` (domain `m6-test.example`). Associate the contact with the
   company as primary.
2. Edit the contact's first name.
3. Delete the contact; wait 1 minute; restore it (Contacts → Deleted → Restore).
4. Create a second contact `m6-test-contact-2@example.com`, then merge it into
   the first one.
5. Remove the contact↔company association, then add it back.

After each step wait ~1 minute and run `context:report` and
`context:show --kind person --ref hubspot:contacts:<id>` (use the contact id
from the HubSpot URL). Report for each step: receipt statuses, the
reference state (`active` / `deleted` / `merged`), the record state, the last
provenance entries (change type, changed field names, cause) and the person's
company link (present / absent).

## 6. Reconciliation catches a missed change

Stop the worker (Ctrl-C in terminal 3) and the API. Edit the first contact's
last name in HubSpot. Start the API and worker again, then:

```bash
pnpm --silent --filter @lip/api context:reconcile --tenant hsoauth --kind person --execute
pnpm --silent --filter @lip/api context:show --tenant hsoauth --kind person --ref hubspot:contacts:<id>
```

Report: the provenance entry with cause `reconciliation` and changed field
`lastName` (or the webhook entry if HubSpot redelivered first — record which).

## 7. Final checks

```bash
grep -ciE 'm6-test|example\.com' /tmp/lip-worker.log /tmp/lip-api.log   # expect 0
grep -E 'HubSpot request failed; retrying' /tmp/lip-worker.log | tail -3
pnpm --silent --filter @lip/api context:dead-letters --tenant hsoauth
```

Clean up the test records in HubSpot afterwards if you wish (deletions will
appear as `deleted` references; nothing is erased in the platform).
