# shellcheck shell=bash
# Milestone 6: context processing through real processes, against the fake
# HubSpot (no real credentials). A dedicated API and worker share an isolated
# queue prefix. Proves: signed webhooks → durable receipts → BullMQ jobs →
# worker read-back → canonical companies/people with references and
# provenance; eligibility (leads deferred, unknown objects source_not_found);
# a worker killed mid-job and restarted loses nothing and duplicates nothing;
# a permanent source error is dead-lettered and replayed by the CLI; a
# checkpointed backfill and an unchanged state hash on rerun; graceful worker
# shutdown; no HubSpot write; no record values or secrets in any log.

CX_FAKE_PORT="$(free_port)"
CX_API_PORT="$(free_port "$CX_FAKE_PORT")"
CX_FAKE_URL="http://127.0.0.1:$CX_FAKE_PORT"
CX_API_URL="http://127.0.0.1:$CX_API_PORT"
CX_ENDPOINT="$CX_API_URL/webhooks/hubspot"
CX_TARGET="https://rt-context.example.test/webhooks/hubspot"
CX_REDIRECT="$CX_API_URL/oauth/hubspot/callback"
CX_CLIENT_ID="rt-cx-client-$$"
CX_CLIENT_SECRET="rt-cx-secret-$$-$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))')"
CX_APP_ID="434343"
# A portal no other runtime check installs (a second grant would make routing ambiguous).
CX_PORTAL="4545"
CX_KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
CX_FAKE_LOG="$WORK/fake-hubspot-context.log"
CX_API_LOG="$WORK/api-context.log"
CX_WORKER_LOG="$WORK/worker-context.log"
CX_BODIES="$WORK/cx-bodies"
mkdir -p "$CX_BODIES"

(cd "$API_DIR" && exec node --no-warnings test/support/fake-hubspot.ts \
  --port "$CX_FAKE_PORT" --token "rt-cx-template-$$" --portal-id "$CX_PORTAL" \
  --oauth-client-id "$CX_CLIENT_ID" --oauth-client-secret "$CX_CLIENT_SECRET" \
  --oauth-redirect-uri "$CX_REDIRECT" >"$CX_FAKE_LOG" 2>&1) &
CX_FAKE_PID=$!
for _ in $(seq 1 40); do grep -q 'listening' "$CX_FAKE_LOG" 2>/dev/null && break; sleep 0.25; done
check "fake HubSpot (records + OAuth) started" grep -q 'listening' "$CX_FAKE_LOG"

CX_ENV=(
  DATABASE_URL="$APP_DB_URL"
  HUBSPOT_API_BASE_URL="$CX_FAKE_URL"
  HUBSPOT_OAUTH_AUTHORIZE_BASE_URL="$CX_FAKE_URL/oauth"
  HUBSPOT_APP_CLIENT_ID="$CX_CLIENT_ID"
  HUBSPOT_APP_CLIENT_SECRET="$CX_CLIENT_SECRET"
  HUBSPOT_APP_REDIRECT_URI="$CX_REDIRECT"
  HUBSPOT_APP_ID="$CX_APP_ID"
  HUBSPOT_WEBHOOK_TARGET_URL="$CX_TARGET"
  HUBSPOT_MAX_RETRIES=0
  PLATFORM_TOKEN_ENCRYPTION_KEY="$CX_KEY"
  QUEUE_PREFIX=rtctx
  WORKER_SHUTDOWN_TIMEOUT_MS=8000
)
cx_cli() { (cd "$API_DIR" && env "${CX_ENV[@]}" node "dist/cli/$1.js" "${@:2}"); }
cx_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
cx_fake() { curl -fsS -X POST -H 'content-type: application/json' --data "$2" "$CX_FAKE_URL/__fake/$1" >/dev/null; }

(cd "$API_DIR" && exec env "${CX_ENV[@]}" PORT="$CX_API_PORT" node dist/main.js >"$CX_API_LOG" 2>&1) &
CX_API_PID=$!
cx_start_worker() {
  (cd "$API_DIR" && exec env "${CX_ENV[@]}" node dist/worker.js >>"$CX_WORKER_LOG" 2>&1) &
  CX_WORKER_PID=$!
}
cx_start_worker
cx_ready() { for _ in $(seq 1 60); do curl -fsS "$CX_API_URL/health/ready" >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
check "context API ready" cx_ready
cx_worker_ready() { for _ in $(seq 1 60); do grep -q 'Context processors registered' "$CX_WORKER_LOG" && return 0; sleep 0.5; done; return 1; }
check "context worker registered processors (noeviction verified)" cx_worker_ready

cx_setup() {
  local url location out
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug rtcontext --name 'Runtime Context' >/dev/null) || return 1
  cx_cli hubspot-configure --tenant rtcontext --portal-id "$CX_PORTAL" --auth oauth >/dev/null || return 1
  out="$(cx_cli hubspot-install-url --tenant rtcontext)" || return 1
  url="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).installUrl)' <<<"$out")"
  location="$(curl -sS -o /dev/null -w '%{redirect_url}' "$url")" || return 1
  out="$(curl -sS -w ' %{http_code}' "$location")"
  [[ "$out" == *'"status":"installed"'*' 200' ]]
}
check "tenant rtcontext installs the app (OAuth)" cx_setup

cx_now() { node -e 'process.stdout.write(String(Date.now()))'; }
cx_event() { # eventId objectTypeId objectId [subscriptionType]
  printf '{"eventId":%s,"subscriptionId":61,"portalId":%s,"appId":%s,"occurredAt":%s,"subscriptionType":"%s","attemptNumber":0,"objectId":%s,"objectTypeId":"%s","changeSource":"CRM_UI"}' \
    "$1" "$CX_PORTAL" "$CX_APP_ID" "$(cx_now)" "${4:-object.creation}" "$3" "$2"
}
cx_send() { # name, events…
  local name="$1"; shift
  local IFS=,
  printf '[%s]' "$*" >"$CX_BODIES/$name.json"
  (cd "$API_DIR" && WEBHOOK_CLIENT_SECRET="$CX_CLIENT_SECRET" node --no-warnings test/support/hubspot-webhooks.ts \
    --url "$CX_ENDPOINT" --target "$CX_TARGET" --body-file "$CX_BODIES/$name.json")
}
cx_status() { cx_sql "SELECT processing_status || ':' || coalesce(processing_reason, '') FROM tenant_webhook_receipts r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = 'rtcontext' AND event_id = '$1'"; }
cx_wait_status() { # eventId expected [seconds]
  local i
  for i in $(seq 1 $(( ${3:-30} * 2 ))); do [[ "$(cx_status "$1")" == "$2" ]] && return 0; sleep 0.5; done
  echo "event $1: $(cx_status "$1") (expected $2)"; return 1
}

cx_basic() {
  local out
  out="$(cx_send basic "$(cx_event 9200001 0-1 101)" "$(cx_event 9200002 0-2 202)" "$(cx_event 9200003 0-136 301)" "$(cx_event 9200004 0-1 987654)")" || return 1
  echo "$out"
  [[ "$out" == '200 '*'"stored":4'* ]] &&
    cx_wait_status 9200001 'processed:' && cx_wait_status 9200002 'processed:' &&
    cx_wait_status 9200003 'deferred:lead_out_of_scope' && cx_wait_status 9200004 'source_not_found:'
}
check "webhooks → receipts → worker: contact/company processed, lead deferred, synthetic id source_not_found" cx_basic

cx_canonical() {
  local person ref prov
  ref="$(cx_sql "SELECT r.person_id FROM person_external_refs r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = 'rtcontext' AND r.external_id = '101' AND r.state = 'active'")"
  person="$(cx_sql "SELECT count(*) FROM persons WHERE id = '$ref' AND primary_email IS NOT NULL")"
  prov="$(cx_sql "SELECT change_type || '|' || cause || '|' || source_record_id || '|' || adapter_version FROM tenant_context_changes WHERE entity_id = '$ref' ORDER BY ingested_at LIMIT 1")"
  echo "person=$ref rows=$person provenance=$prov"
  [[ "$ref" =~ ^[0-9a-f-]{36}$ ]] && [ "$person" = 1 ] && [[ "$prov" == 'created|webhook|101|m6.1' ]] &&
    [ "$(cx_sql "SELECT count(*) FROM person_external_refs r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = 'rtcontext' AND r.external_id = '987654'")" = 0 ]
}
check "canonical person with platform id, reference and provenance; nothing for the synthetic id" cx_canonical

cx_crash() {
  # The contact read is slow: kill the worker while the job is active, restart it.
  # A valid contact, answered after 6 s: the worker is killed while the job is active.
  cx_fake fault '{"match":"GET /crm/objects/2026-09/contacts/102$","status":200,"delayMs":6000,"times":1,"body":{"id":"102","properties":{"email":null},"archived":false}}' || return 1
  cx_send crash "$(cx_event 9200010 0-1 102)" >/dev/null || return 1
  for _ in $(seq 1 40); do [[ "$(cx_status 9200010)" == processing:* ]] && break; sleep 0.25; done
  echo "before kill: $(cx_status 9200010)"
  kill -KILL "$CX_WORKER_PID"; wait "$CX_WORKER_PID" 2>/dev/null || true
  cx_start_worker
  cx_wait_status 9200010 'processed:' 120 &&
    [ "$(cx_sql "SELECT count(*) FROM person_external_refs r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = 'rtcontext' AND r.external_id = '102'")" = 1 ] &&
    [ "$(cx_sql "SELECT count(*) FROM tenant_context_changes c JOIN person_external_refs r ON r.person_id = c.entity_id WHERE r.external_id = '102' AND c.change_type = 'created'")" = 1 ]
}
check "worker killed mid-job and restarted: the job is recovered, one record, one 'created' provenance row" cx_crash

cx_dead_letter() {
  local dl out
  cx_fake fault '{"match":"GET /crm/objects/2026-09/contacts/103$","status":400,"times":1}' || return 1
  cx_send dl "$(cx_event 9200020 0-1 103)" >/dev/null || return 1
  cx_wait_status 9200020 'dead_lettered:source_bad_request' || return 1
  dl="$(cx_sql "SELECT d.id FROM tenant_dead_letters d JOIN tenants t ON t.id = d.tenant_id WHERE t.slug = 'rtcontext' AND d.state = 'open' AND d.error_code = 'source_bad_request'")"
  out="$(cx_cli context replay --tenant rtcontext --dead-letter "$dl")" || return 1
  grep -q '"dryRun": true' <<<"$out" || return 1
  out="$(cx_cli context replay --tenant rtcontext --dead-letter "$dl" --execute)" || return 1
  echo "$out"
  grep -q '"replayed": 1' <<<"$out" && cx_wait_status 9200020 'processed:' &&
    [ "$(cx_sql "SELECT state FROM tenant_dead_letters WHERE id = '$dl'")" = replayed ]
}
check "permanent source error → dead letter (code only) → context:replay (dry run, then --execute) → processed" cx_dead_letter

cx_backfill() {
  local out h1 h2 cps
  out="$(cx_cli context backfill --tenant rtcontext --kind all --page-size 2 --execute)" || return 1
  for _ in $(seq 1 60); do
    cps="$(cx_sql "SELECT count(*) FROM tenant_sync_checkpoints c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = 'rtcontext' AND c.mode = 'backfill' AND c.status = 'completed'")"
    [ "$cps" = 2 ] && break; sleep 0.5
  done
  [ "$cps" = 2 ] || { echo "completed backfill runs: $cps"; return 1; }
  sleep 2
  h1="$(cx_cli context state-hash --tenant rtcontext | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).hash)')"
  cx_cli context backfill --tenant rtcontext --kind all --page-size 2 --execute >/dev/null || return 1
  for _ in $(seq 1 60); do
    cps="$(cx_sql "SELECT count(*) FROM tenant_sync_checkpoints c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = 'rtcontext' AND c.mode = 'backfill' AND c.status = 'completed'")"
    [ "$cps" = 4 ] && break; sleep 0.5
  done
  sleep 2
  h2="$(cx_cli context state-hash --tenant rtcontext | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).hash)')"
  echo "runs=$cps hash1=$h1 hash2=$h2"
  [ "$cps" = 4 ] && [[ "$h1" =~ ^[0-9a-f]{64}$ ]] && [ "$h1" = "$h2" ] &&
    [ "$(cx_sql "SELECT count(*) FROM company_external_refs r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = 'rtcontext'")" = 3 ] &&
    [ "$(cx_sql "SELECT count(*) FROM person_external_refs r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = 'rtcontext' AND r.external_id <> '987654'")" -ge 5 ]
}
check "context:backfill (checkpointed) loads all records; a rerun leaves the state hash unchanged" cx_backfill

cx_report() {
  local out
  out="$(cx_cli context report --tenant rtcontext)" || return 1
  echo "$out" | head -40
  node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const ok = r.processingEnabled === true && r.receipts["processed"] >= 3 &&
      r.receipts["deferred:lead_out_of_scope"] === 1 && r.persons.active >= 5 &&
      r.checkpoints.length >= 2 && typeof r.queues["lip-receipts"] === "object";
    process.exit(ok ? 0 : 1);' <<<"$out" && ! grep -qi 'school1.example' <<<"$out"
}
check "context:report: queues, receipts by status, records, checkpoints; no values" cx_report

cx_show() {
  local out
  out="$(cx_cli context show --tenant rtcontext --kind person --ref hubspot:contacts:101)" || return 1
  echo "$out" | head -30
  grep -q '"externalId": "101"' <<<"$out" && grep -q '"cause": "webhook"' <<<"$out" && ! grep -qi 'school1.example' <<<"$out"
}
check "context:show: references and provenance trail, field names only" cx_show

cx_shutdown() {
  kill -TERM "$CX_WORKER_PID"
  for _ in $(seq 1 60); do kill -0 "$CX_WORKER_PID" 2>/dev/null || break; sleep 0.25; done
  ! kill -0 "$CX_WORKER_PID" 2>/dev/null && grep -q 'Application shut down cleanly' "$CX_WORKER_LOG"
}
check "context worker stops gracefully on SIGTERM" cx_shutdown

cx_no_writes() {
  local requests
  # /__fake/ is the fake's own test-control interface (fault injection), not HubSpot.
  requests="$(grep '^request ' "$CX_FAKE_LOG" | grep -v '^request POST /__fake/')" || return 1
  echo "$requests" | sort | uniq -c | sort -rn | head -20
  # Reads only: GET, association batch reads, the verified search path; plus the OAuth install/refresh.
  ! grep -vE '^request (GET /|POST /crm/associations/2026-09/[a-z]+/[a-z]+/batch/read$|POST /crm/objects/2026-03/(contacts|companies)/search$|POST /oauth/2026-09/token grant=(authorization_code|refresh_token)$)' <<<"$requests"
}
check "no HubSpot write: GET, association batch read, verified search and OAuth token calls only" cx_no_writes

cx_no_leaks() {
  ! grep -qiE 'school[0-9]\.example|First[0-9]|Last[0-9]' "$CX_WORKER_LOG" "$CX_API_LOG" &&
    ! grep -q "$CX_CLIENT_SECRET" "$CX_WORKER_LOG" "$CX_API_LOG" "$CX_FAKE_LOG" &&
    ! grep -qiE 'access-[0-9a-f]{16}|refresh-[0-9a-f]{16}|Bearer ' "$CX_WORKER_LOG" "$CX_API_LOG" &&
    ! grep -q '"level":60' "$CX_WORKER_LOG"
}
check "worker and API logs: no record values, tokens or secrets" cx_no_leaks

kill -TERM "$CX_API_PID" "$CX_FAKE_PID" "$CX_WORKER_PID" 2>/dev/null || true
cx_stopped() {
  for _ in $(seq 1 40); do
    kill -0 "$CX_API_PID" 2>/dev/null || kill -0 "$CX_FAKE_PID" 2>/dev/null || kill -0 "$CX_WORKER_PID" 2>/dev/null || return 0
    sleep 0.25
  done
  return 1
}
check "context API, worker and fake HubSpot stopped" cx_stopped
wait "$CX_API_PID" "$CX_FAKE_PID" "$CX_WORKER_PID" 2>/dev/null || true
