# shellcheck shell=bash
# Milestone 4: HubSpot OAuth and the CrmReader port, against the fake HubSpot
# (OAuth endpoints included; no real credentials). A second API process runs
# with an OAuth app configuration and a generated encryption key. Proves:
# configure → install URL → consent → callback (real HTTP) → encrypted grant;
# replay refused; tokens never in logs or rows; discovery through CrmReader;
# concurrent processes refresh an expired access token exactly once; reads only.

OA_FAKE_PORT="$(free_port)"
OA_API_PORT="$(free_port "$OA_FAKE_PORT")"
OA_FAKE_URL="http://127.0.0.1:$OA_FAKE_PORT"
OA_API_URL="http://127.0.0.1:$OA_API_PORT"
OA_REDIRECT="$OA_API_URL/oauth/hubspot/callback"
OA_CLIENT_ID="rt-client-id-$$"
OA_CLIENT_SECRET="rt-client-secret-$$"
OA_KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
OA_URL=""
OA_CALLBACK=""
OA_FAKE_LOG="$WORK/fake-hubspot-oauth.log"
OA_API_LOG="$WORK/api-oauth.log"

(cd "$API_DIR" && exec node --no-warnings test/support/fake-hubspot.ts \
  --port "$OA_FAKE_PORT" --token "rt-template-$$" --portal-id 888 \
  --oauth-client-id "$OA_CLIENT_ID" --oauth-client-secret "$OA_CLIENT_SECRET" \
  --oauth-redirect-uri "$OA_REDIRECT" --refresh-delay-ms 800 >"$OA_FAKE_LOG" 2>&1) &
OA_FAKE_PID=$!
for _ in $(seq 1 40); do grep -q 'listening' "$OA_FAKE_LOG" 2>/dev/null && break; sleep 0.25; done
check "fake HubSpot (with OAuth) started" grep -q 'listening' "$OA_FAKE_LOG"

OA_ENV=(
  DATABASE_URL="$APP_DB_URL"
  HUBSPOT_API_BASE_URL="$OA_FAKE_URL"
  HUBSPOT_OAUTH_AUTHORIZE_BASE_URL="$OA_FAKE_URL/oauth"
  HUBSPOT_APP_CLIENT_ID="$OA_CLIENT_ID"
  HUBSPOT_APP_CLIENT_SECRET="$OA_CLIENT_SECRET"
  HUBSPOT_APP_REDIRECT_URI="$OA_REDIRECT"
  PLATFORM_TOKEN_ENCRYPTION_KEY="$OA_KEY"
)
oa_cli() { (cd "$API_DIR" && env "${OA_ENV[@]}" node "dist/cli/hubspot-$1.js" "${@:2}"); }
oa_owner_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }

(cd "$API_DIR" && exec env "${OA_ENV[@]}" PORT="$OA_API_PORT" node dist/main.js >"$OA_API_LOG" 2>&1) &
OA_API_PID=$!
oa_ready() { for _ in $(seq 1 60); do curl -fsS "$OA_API_URL/health/ready" >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }
check "second API process (OAuth app configured) ready" oa_ready

check "provision tenant 'rtoauth'" bash -c "cd '$API_DIR' && DATABASE_URL='$APP_DB_URL' node dist/cli/provision-tenant.js --slug rtoauth --name 'Runtime OAuth' >/dev/null"
oa_configured() {
  local out
  out="$(oa_cli configure --tenant rtoauth --portal-id 888 --auth oauth)" || return 1
  echo "$out"
  grep -q '"access": "read_only"' <<<"$out" && grep -q '"auth": "oauth"' <<<"$out" &&
    ! grep -q 'environmentVariable' <<<"$out"
}
check "hubspot:configure --auth oauth: read-only, no token variable to set" oa_configured

oa_install_url() {
  local out
  out="$(oa_cli install-url --tenant rtoauth)" || return 1
  echo "$out" | sed -E 's/state=[^"&]+/state=<redacted>/'
  # Kept in a variable, never written to disk: the state is single-use but still not for artifacts.
  OA_URL="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).installUrl)' <<<"$out")"
  [[ "$OA_URL" == "$OA_FAKE_URL/oauth/888/authorize?"* ]] &&
    node -e '
      const u = new URL(process.argv[1]);
      const scopes = u.searchParams.get("scope").split(" ");
      const ok = scopes.length > 0 && scopes.every((s) => s.endsWith(".read")) &&
        u.searchParams.get("client_id") === process.argv[2] && /\./.test(u.searchParams.get("state"));
      process.exit(ok ? 0 : 1);' "$OA_URL" "$OA_CLIENT_ID" &&
    ! grep -q "$OA_CLIENT_SECRET" <<<"$out"
}
check "hubspot:install-url: account-specific consent URL, read-only scopes, no secret" oa_install_url

oa_bad_state() {
  local out
  out="$(curl -sS -w ' %{http_code}' "$OA_API_URL/oauth/hubspot/callback?code=code-x&state=forged.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")"
  echo "$out"
  [[ "$out" == *'"reason":"invalid_state"'*' 400' ]]
}
check "callback with a forged state → 400, before any HubSpot call" oa_bad_state

oa_install() {
  local location out
  location="$(curl -sS -o /dev/null -w '%{redirect_url}' "$OA_URL")" || return 1
  [[ "$location" == "$OA_REDIRECT?"* ]] || { echo "unexpected redirect"; return 1; }
  OA_CALLBACK="$location"
  out="$(curl -sS -D "$WORK/oa-callback-headers" -w ' %{http_code}' "$location")"
  echo "$out"
  [[ "$out" == *'"status":"installed"'*'"accountId":"888"'*' 200' ]] &&
    grep -qi '^cache-control: no-store' "$WORK/oa-callback-headers" &&
    grep -qi '^referrer-policy: no-referrer' "$WORK/oa-callback-headers"
}
check "consent → callback (real HTTP): installed, no-store, no-referrer" oa_install

oa_replay() {
  local out
  out="$(curl -sS -w ' %{http_code}' "$OA_CALLBACK")"
  echo "$out"
  [[ "$out" == *'"reason":"invalid_state"'*' 400' ]]
}
check "replaying the same callback → 400 (single-use state)" oa_replay

oa_encrypted() {
  local row
  row="$(oa_owner_sql "SELECT account_id, left(refresh_token_enc, 3), left(access_token_enc, 3) FROM tenant_oauth_tokens t JOIN tenants x ON x.id = t.tenant_id WHERE x.slug = 'rtoauth'")" || return 1
  echo "$row"
  [[ "$row" == '888|v1:|v1:' ]] &&
    ! oa_owner_sql "SELECT refresh_token_enc || access_token_enc FROM tenant_oauth_tokens" | grep -qE 'refresh-[0-9a-f]{32}|access-[0-9a-f]{32}'
}
check "grant stored encrypted (v1 ciphertext), no token in the row" oa_encrypted

oa_rls() {
  [ "$(compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -Atc 'SELECT count(*) FROM tenant_oauth_tokens')" = 0 ]
}
check "app role with no tenant set sees no OAuth grants (RLS)" oa_rls

oa_discover() {
  oa_cli discovery --tenant rtoauth --out "$WORK/oa-discovery.json" >/dev/null || return 1
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const ok = r.account.portalId === "888" && r.readThrough.port === "CrmReader" &&
      r.readThrough.objectKinds.contacts === "person" && r.objects.leads.records.status === "ok";
    process.exit(ok ? 0 : 1);' "$WORK/oa-discovery.json"
}
check "hubspot:discover for the OAuth tenant reads through the CrmReader port" oa_discover

oa_refresh_once() {
  local before after
  oa_owner_sql "UPDATE tenant_oauth_tokens SET access_token_expires_at = now() - interval '1 minute'" >/dev/null || return 1
  before="$(grep -c 'grant=refresh_token' "$OA_FAKE_LOG" || true)"
  # Three independent processes need a token at the same moment.
  local pids=() i
  for i in 1 2 3; do
    oa_cli discovery --tenant rtoauth --out "$WORK/oa-concurrent-$i.json" >"$WORK/oa-concurrent-$i.log" 2>&1 &
    pids+=("$!")
  done
  for i in "${pids[@]}"; do wait "$i" || return 1; done
  after="$(grep -c 'grant=refresh_token' "$OA_FAKE_LOG" || true)"
  echo "refresh calls at HubSpot: before=$before after=$after"
  [ $((after - before)) -eq 1 ]
}
check "3 concurrent processes, expired token → exactly 1 refresh call at HubSpot" oa_refresh_once

oa_no_leaks() {
  # The fake issues recognisable values; none may appear in any log or output.
  ! grep -rEl 'refresh-[0-9a-f]{32}|access-[0-9a-f]{32}|code-[0-9a-f]{24}' "$WORK" --exclude=checks.log &&
    ! grep -q "$OA_CLIENT_SECRET" "$OA_API_LOG" "$OA_FAKE_LOG" &&
    grep -q '/oauth/hubspot/callback' "$OA_API_LOG" && ! grep -q 'callback?' "$OA_API_LOG"
}
check "no token, code or client secret in any log; callback logged without its query" oa_no_leaks

oa_read_only() {
  local requests
  requests="$(grep '^request ' "$OA_FAKE_LOG")" || return 1
  echo "$requests" | sort | uniq -c
  ! grep -vE '^request (GET /(crm/(objects|properties|associations)|account-info)/[0-9]{4}-[0-9]{2}/.+|POST /crm/associations/[0-9]{4}-[0-9]{2}/[^/]+/[^/]+/batch/read|POST /oauth/2026-09/token grant=(authorization_code|refresh_token)|GET /oauth/888/authorize)$' <<<"$requests"
}
check "only CRM reads and the date-versioned OAuth token endpoint were called" oa_read_only

kill -TERM "$OA_API_PID" "$OA_FAKE_PID" 2>/dev/null || true
oa_stopped() {
  for _ in $(seq 1 40); do
    kill -0 "$OA_API_PID" 2>/dev/null || kill -0 "$OA_FAKE_PID" 2>/dev/null || return 0
    sleep 0.25
  done
  return 1
}
check "second API process and fake HubSpot stopped" oa_stopped
wait "$OA_API_PID" "$OA_FAKE_PID" 2>/dev/null || true
