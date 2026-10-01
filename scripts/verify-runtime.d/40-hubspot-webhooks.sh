# shellcheck shell=bash
# Milestone 5: HubSpot webhook intake through a real API process, against the
# fake HubSpot (no real credentials). A tenant installs the app (OAuth), then
# signed deliveries are sent exactly as HubSpot sends them. Proves: v3
# signature over the raw body and the configured public URL; stale, future,
# v1/v2, wrong-host and wrong-secret deliveries refused; body limit; atomic
# de-duplication; routing only to the tenant holding the grant (never to the
# static-token tenant on the same account, never guessed for unknown
# accounts); identifiers only in the database; nothing sensitive in any log;
# no HubSpot call caused by a webhook; the report CLI.

WH_FAKE_PORT="$(free_port)"
WH_API_PORT="$(free_port "$WH_FAKE_PORT")"
WH_FAKE_URL="http://127.0.0.1:$WH_FAKE_PORT"
WH_API_URL="http://127.0.0.1:$WH_API_PORT"
WH_ENDPOINT="$WH_API_URL/webhooks/hubspot"
# The public URL HubSpot would call (a tunnel in live runs); signatures cover it.
WH_TARGET="https://rt-public.example.test/webhooks/hubspot"
WH_REDIRECT="$WH_API_URL/oauth/hubspot/callback"
WH_CLIENT_ID="rt-wh-client-$$"
WH_CLIENT_SECRET="rt-wh-secret-$$-$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))')"
WH_APP_ID="424242"
WH_PORTAL="777"
WH_KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
WH_MARKER="rt-value-marker-$$@example.com"
WH_FAKE_LOG="$WORK/fake-hubspot-webhooks.log"
WH_API_LOG="$WORK/api-webhooks.log"
WH_BODIES="$WORK/wh-bodies" # request bodies (contain the marker by design); excluded from leak checks
mkdir -p "$WH_BODIES"

(cd "$API_DIR" && exec node --no-warnings test/support/fake-hubspot.ts \
  --port "$WH_FAKE_PORT" --token "rt-wh-template-$$" --portal-id "$WH_PORTAL" \
  --oauth-client-id "$WH_CLIENT_ID" --oauth-client-secret "$WH_CLIENT_SECRET" \
  --oauth-redirect-uri "$WH_REDIRECT" >"$WH_FAKE_LOG" 2>&1) &
WH_FAKE_PID=$!
for _ in $(seq 1 40); do grep -q 'listening' "$WH_FAKE_LOG" 2>/dev/null && break; sleep 0.25; done
check "fake HubSpot (OAuth) started" grep -q 'listening' "$WH_FAKE_LOG"

WH_ENV=(
  DATABASE_URL="$APP_DB_URL"
  HUBSPOT_API_BASE_URL="$WH_FAKE_URL"
  HUBSPOT_OAUTH_AUTHORIZE_BASE_URL="$WH_FAKE_URL/oauth"
  HUBSPOT_APP_CLIENT_ID="$WH_CLIENT_ID"
  HUBSPOT_APP_CLIENT_SECRET="$WH_CLIENT_SECRET"
  HUBSPOT_APP_REDIRECT_URI="$WH_REDIRECT"
  HUBSPOT_APP_ID="$WH_APP_ID"
  HUBSPOT_WEBHOOK_TARGET_URL="$WH_TARGET"
  PLATFORM_TOKEN_ENCRYPTION_KEY="$WH_KEY"
)
wh_cli() { (cd "$API_DIR" && env "${WH_ENV[@]}" node "dist/cli/hubspot-$1.js" "${@:2}"); }
wh_owner_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
wh_app_sql() { compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }

(cd "$API_DIR" && exec env "${WH_ENV[@]}" LOG_LEVEL=debug PORT="$WH_API_PORT" node dist/main.js >"$WH_API_LOG" 2>&1) &
WH_API_PID=$!
wh_ready() { for _ in $(seq 1 60); do curl -fsS "$WH_API_URL/health/ready" >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
check "API process with the webhook configuration ready" wh_ready

wh_setup() {
  local url location out
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug rtwebhook --name 'Runtime Webhooks' >/dev/null) || return 1
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug rtwhstatic --name 'Runtime Static' >/dev/null) || return 1
  wh_cli configure --tenant rtwebhook --portal-id "$WH_PORTAL" --auth oauth >/dev/null || return 1
  # Same HubSpot account, static token, no grant: must never receive events.
  wh_cli configure --tenant rtwhstatic --portal-id "$WH_PORTAL" >/dev/null || return 1
  out="$(wh_cli install-url --tenant rtwebhook)" || return 1
  url="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).installUrl)' <<<"$out")"
  location="$(curl -sS -o /dev/null -w '%{redirect_url}' "$url")" || return 1
  out="$(curl -sS -w ' %{http_code}' "$location")"
  echo "$out"
  [[ "$out" == *'"status":"installed"'*"\"accountId\":\"$WH_PORTAL\""*' 200' ]]
}
check "tenant rtwebhook installs the app (OAuth); rtwhstatic uses a static token on the same account" wh_setup

# Bodies, in HubSpot's documented shape (generic object subscriptions).
wh_body() { # name, then events as JSON
  printf '%s' "$2" >"$WH_BODIES/$1.json"
}
WH_NOW="$(node -e 'process.stdout.write(String(Date.now()))')"
wh_body batch "[{\"eventId\":9100001,\"subscriptionId\":51,\"portalId\":$WH_PORTAL,\"appId\":$WH_APP_ID,\"occurredAt\":$WH_NOW,\"subscriptionType\":\"object.creation\",\"attemptNumber\":0,\"objectId\":1001,\"objectTypeId\":\"0-1\",\"changeFlag\":\"CREATED\",\"changeSource\":\"CRM_UI\",\"sourceId\":\"userId:7\"},
 {\"eventId\":9100002,\"subscriptionId\":52,\"portalId\":$WH_PORTAL,\"appId\":$WH_APP_ID,\"occurredAt\":$WH_NOW,\"subscriptionType\":\"object.propertyChange\",\"attemptNumber\":0,\"objectId\":1001,\"objectTypeId\":\"0-1\",\"propertyName\":\"email\",\"propertyValue\":\"$WH_MARKER\",\"changeSource\":\"CRM_UI\"},
 {\"eventId\":9100003,\"subscriptionId\":53,\"portalId\":$WH_PORTAL,\"appId\":$WH_APP_ID,\"occurredAt\":$WH_NOW,\"subscriptionType\":\"object.creation\",\"attemptNumber\":0,\"objectId\":2002,\"objectTypeId\":\"0-136\",\"changeSource\":\"CRM_UI\"}]"
wh_body retry "[{\"eventId\":9100003,\"subscriptionId\":53,\"portalId\":$WH_PORTAL,\"appId\":$WH_APP_ID,\"occurredAt\":$WH_NOW,\"subscriptionType\":\"object.creation\",\"attemptNumber\":1,\"objectId\":2002,\"objectTypeId\":\"0-136\",\"changeSource\":\"CRM_UI\"}]"
wh_body unknown "[{\"eventId\":9100004,\"subscriptionId\":51,\"portalId\":99887766,\"appId\":$WH_APP_ID,\"occurredAt\":$WH_NOW,\"subscriptionType\":\"object.creation\",\"attemptNumber\":0,\"objectId\":3003,\"objectTypeId\":\"0-1\"}]"
wh_body otherapp "[{\"eventId\":9100005,\"subscriptionId\":51,\"portalId\":$WH_PORTAL,\"appId\":1,\"occurredAt\":$WH_NOW,\"subscriptionType\":\"object.creation\",\"attemptNumber\":0,\"objectId\":3004,\"objectTypeId\":\"0-1\"}]"

wh_send() { # body name, extra sender args…; prints "<status> <response body>"
  (cd "$API_DIR" && WEBHOOK_CLIENT_SECRET="$WH_CLIENT_SECRET" node --no-warnings test/support/hubspot-webhooks.ts \
    --url "$WH_ENDPOINT" --target "$WH_TARGET" --body-file "$WH_BODIES/$1.json" "${@:2}")
}
wh_expect() { # expected status, expected body fragment, body name, sender args…
  local out
  out="$(wh_send "${@:3}")" || return 1
  echo "$out"
  [[ "$out" == "$1 "*"$2"* ]]
}

check "signed batch → 200, 3 events stored" wh_expect 200 '"events":3,"stored":3,"duplicates":0,"unroutable":0' batch
check "the same delivery replayed → 200, recorded once (duplicates 3)" wh_expect 200 '"stored":0,"duplicates":3' batch
check "HubSpot retry (attempt 1) of an event → counted on the same receipt" wh_expect 200 '"stored":0,"duplicates":1' retry

wh_concurrent() {
  local i pids=() stored=0
  wh_body conc "[{\"eventId\":9100010,\"subscriptionId\":51,\"portalId\":$WH_PORTAL,\"appId\":$WH_APP_ID,\"occurredAt\":$WH_NOW,\"subscriptionType\":\"object.creation\",\"attemptNumber\":0,\"objectId\":4004,\"objectTypeId\":\"0-2\"}]"
  for i in $(seq 1 10); do wh_send conc >"$WORK/wh-conc-$i.out" 2>&1 & pids+=("$!"); done
  for i in "${pids[@]}"; do wait "$i" || return 1; done
  cat "$WORK"/wh-conc-*.out
  stored="$(cat "$WORK"/wh-conc-*.out | grep -c '"stored":1' || true)"
  [ "$stored" -eq 1 ] && [ "$(grep -c '^200 ' "$WORK"/wh-conc-*.out | awk -F: '{s+=$2} END {print s}')" -eq 10 ] &&
    [ "$(wh_owner_sql "SELECT count(*) || '|' || max(deliveries) FROM tenant_webhook_receipts WHERE event_id = '9100010'")" = '1|10' ]
}
check "10 concurrent deliveries of one event → exactly 1 receipt (deliveries = 10)" wh_concurrent

check "stale timestamp (6 min old) → 401" wh_expect 401 invalid_signature batch --timestamp-offset-ms -360000
check "future timestamp (+5 min) → 401" wh_expect 401 invalid_signature batch --timestamp-offset-ms 300000
check "signed for the Host header the client sent, not the configured URL → 401" \
  wh_expect 401 invalid_signature batch --host attacker.example --sign-uri https://attacker.example/webhooks/hubspot
check "signed for the configured URL, arbitrary Host header → 200 (Host never trusted)" \
  wh_expect 200 '"duplicates":3' batch --host attacker.example
wh_legacy() {
  local v out body
  body="$(cat "$WH_BODIES/batch.json")"
  for v in v1 v2; do
    out="$(curl -sS -w ' %{http_code}' -H 'content-type: application/json' -H "x-hubspot-signature-version: $v" \
      -H "x-hubspot-signature: $(printf '%s%s' "$WH_CLIENT_SECRET" "$body" | sha256sum | cut -d' ' -f1)" \
      --data-binary "@$WH_BODIES/batch.json" "$WH_ENDPOINT")"
    echo "$v: $out"
    [[ "$out" == *'invalid_signature'*' 401' ]] || return 1
  done
}
check "v1/v2 signatures (no v3) → 401" wh_legacy
wh_wrong_secret() {
  local out
  out="$(cd "$API_DIR" && WEBHOOK_CLIENT_SECRET="not-the-secret" node --no-warnings test/support/hubspot-webhooks.ts \
    --url "$WH_ENDPOINT" --target "$WH_TARGET" --body-file "$WH_BODIES/batch.json")"
  echo "$out"
  [[ "$out" == '401 '*invalid_signature* ]]
}
check "signed with another secret → 401" wh_wrong_secret
check "events for another app id → 403" wh_expect 403 app_mismatch otherapp
check "unknown HubSpot account → 200, acknowledged, never guessed (unroutable 1)" wh_expect 200 '"stored":0,"duplicates":0,"unroutable":1' unknown
wh_too_large() {
  local out
  head -c 1100000 /dev/zero | tr '\0' ' ' >"$WH_BODIES/large.json"
  out="$(curl -sS -w ' %{http_code}' -H 'content-type: application/json' --data-binary "@$WH_BODIES/large.json" "$WH_ENDPOINT")"
  echo "$out"
  [[ "$out" == *'payload_too_large'*' 413' ]]
}
check "body over 1 MiB → 413" wh_too_large

wh_db() {
  local rows dump
  rows="$(wh_owner_sql "SELECT x.slug, count(*), sum(deliveries) FROM tenant_webhook_receipts r JOIN tenants x ON x.id = r.tenant_id GROUP BY x.slug ORDER BY 1")" || return 1
  echo "$rows"
  dump="$(wh_owner_sql "SELECT tenant_webhook_receipts::text FROM tenant_webhook_receipts")"
  # 4 events for rtwebhook only; nothing for the static tenant; no values, no payload fields.
  [[ "$rows" == "rtwebhook|4|"* ]] && [ "$(wc -l <<<"$rows")" -eq 1 ] &&
    ! grep -q "$WH_MARKER" <<<"$dump" && ! grep -qE 'userId|CREATED' <<<"$dump" &&
    [ "$(wh_owner_sql "SELECT count(*) FROM tenant_webhook_receipts WHERE event_id = '9100003' AND first_attempt_number = 0 AND last_attempt_number = 1")" = 1 ]
}
check "receipts: 4 for rtwebhook, none for the static tenant, identifiers only" wh_db
wh_rls() { [ "$(wh_app_sql 'SELECT count(*) FROM tenant_webhook_receipts')" = 0 ]; }
check "app role with no tenant set sees no receipts (RLS)" wh_rls
wh_route_fn() {
  local routed grants
  routed="$(wh_app_sql "SELECT count(*) FROM app_route_oauth_account('hubspot', '$WH_PORTAL')")" || return 1
  grants="$(wh_app_sql 'SELECT count(*) FROM tenant_oauth_tokens')" || return 1
  echo "routed=$routed grants_visible=$grants"
  [ "$routed" = 1 ] && [ "$grants" = 0 ]
}
check "routing function answers for the app role; grants stay invisible to it" wh_route_fn

wh_report() {
  local out
  out="$(wh_cli webhook-report --tenant rtwebhook)" || return 1
  echo "$out"
  node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const ok = r.receipts === 4 && r.redelivered === 4 && r.maxAttemptNumber === 1 &&
      r.byType.some((t) => t.subscriptionType === "object.creation" && t.objectTypeId === "0-136");
    process.exit(ok ? 0 : 1);' <<<"$out" && ! grep -q "$WH_MARKER" <<<"$out"
}
check "hubspot:webhook-report: counts, types, attempts; no values" wh_report

wh_no_leaks() {
  # The body (marker), signatures, timestamps' signatures and the client secret are never logged.
  ! grep -q "$WH_MARKER" "$WH_API_LOG" "$WH_FAKE_LOG" &&
    ! grep -q "$WH_CLIENT_SECRET" "$WH_API_LOG" "$WH_FAKE_LOG" &&
    ! grep -qiE '"x-hubspot-signature(-v3)?":"[A-Za-z0-9+/=]{20,}' "$WH_API_LOG" &&
    grep -q 'HubSpot webhook events recorded' "$WH_API_LOG" &&
    grep -q 'HubSpot webhook events not routed' "$WH_API_LOG" &&
    grep -q '"reason":"stale_timestamp"' "$WH_API_LOG" &&
    grep -q '"reason":"unsupported_signature_version"' "$WH_API_LOG"
}
check "API log: outcomes recorded; no body, value, signature or secret" wh_no_leaks

wh_no_hubspot_calls() {
  local requests
  requests="$(grep '^request ' "$WH_FAKE_LOG")" || return 1
  echo "$requests" | sort | uniq -c
  # Only the install: consent page and one code exchange. Webhooks caused no call at all.
  ! grep -vE "^request (GET /oauth/authorize|POST /oauth/2026-09/token grant=authorization_code)$" <<<"$requests"
}
check "webhooks caused no HubSpot call (no CRM reads, no writes)" wh_no_hubspot_calls

kill -TERM "$WH_API_PID" "$WH_FAKE_PID" 2>/dev/null || true
wh_stopped() {
  for _ in $(seq 1 40); do
    kill -0 "$WH_API_PID" 2>/dev/null || kill -0 "$WH_FAKE_PID" 2>/dev/null || return 0
    sleep 0.25
  done
  return 1
}
check "webhook API process and fake HubSpot stopped" wh_stopped
wait "$WH_API_PID" "$WH_FAKE_PID" 2>/dev/null || true
