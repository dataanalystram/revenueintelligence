# shellcheck shell=bash
# Milestone 3: the HubSpot connector against a local fake HubSpot (no real
# credentials). Proves the built CLIs configure a tenant read-only, resolve
# the tenant's token through the SecretProvider, run discovery, refuse a bad
# token or the wrong account, and make only read requests.

HS_PORT="$(free_port)"
HS_TOKEN="rt-fake-token-$$"
HS_LOG="$WORK/fake-hubspot.log"
(cd "$API_DIR" && exec node --no-warnings test/support/fake-hubspot.ts \
  --port "$HS_PORT" --token "$HS_TOKEN" --portal-id 777 >"$HS_LOG" 2>&1) &
HS_PID=$!
for _ in $(seq 1 40); do grep -q 'listening' "$HS_LOG" 2>/dev/null && break; sleep 0.25; done
check "fake HubSpot started" grep -q 'listening' "$HS_LOG"

hs_cli() {
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" HUBSPOT_API_BASE_URL="http://127.0.0.1:$HS_PORT" \
    node "dist/cli/hubspot-$1.js" "${@:2}")
}

check "provision tenant 'rthub'" bash -c "cd '$API_DIR' && DATABASE_URL='$APP_DB_URL' node dist/cli/provision-tenant.js --slug rthub --name 'Runtime HubSpot' >/dev/null"
hs_configured() {
  local out
  out="$(hs_cli configure --tenant rthub --portal-id 777)" || return 1
  echo "$out"
  grep -q '"access": "read_only"' <<<"$out" &&
    grep -q '"environmentVariable": "TENANT_RTHUB_HUBSPOT_ACCESS_TOKEN"' <<<"$out"
}
check "hubspot:configure sets read-only access and names the token variable" hs_configured

hs_discovered() {
  TENANT_RTHUB_HUBSPOT_ACCESS_TOKEN="$HS_TOKEN" hs_cli discovery --tenant rthub --out "$WORK/discovery.json" || return 1
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const ok = r.account.portalId === "777" && r.leadObject.available === true &&
      r.objects.contacts.records.paginationVerified === true && r.missingScopes.length === 0;
    process.exit(ok ? 0 : 1);' "$WORK/discovery.json"
}
check "hubspot:discover reads account, objects, properties and associations" hs_discovered

hs_bad_token() {
  local out
  if out="$(TENANT_RTHUB_HUBSPOT_ACCESS_TOKEN=wrong-token-value hs_cli discovery --tenant rthub 2>&1)"; then return 1; fi
  echo "$out"
  grep -q '\[unauthorized\]' <<<"$out" && ! grep -q 'wrong-token-value' <<<"$out"
}
check "a bad token fails as unauthorized, without printing the token" hs_bad_token

hs_wrong_account() {
  local out
  hs_cli configure --tenant rthub --portal-id 778 >/dev/null || return 1
  if out="$(TENANT_RTHUB_HUBSPOT_ACCESS_TOKEN="$HS_TOKEN" hs_cli discovery --tenant rthub 2>&1)"; then return 1; fi
  echo "$out"
  grep -q '\[account_mismatch\]' <<<"$out"
}
check "a token for a different HubSpot account is refused" hs_wrong_account

hs_read_only() {
  # Every request the fake saw: GET, or POST to an association batch *read*.
  local requests
  requests="$(grep '^request ' "$HS_LOG")" || return 1
  echo "$requests"
  ! grep -vE '^request (GET .+|POST /crm/associations/[^/]+/[^/]+/[^/]+/batch/read)$' <<<"$requests"
}
check "the connector made read requests only" hs_read_only

kill -TERM "$HS_PID" 2>/dev/null || true
hs_stopped() { for _ in $(seq 1 20); do kill -0 "$HS_PID" 2>/dev/null || return 0; sleep 0.25; done; return 1; }
check "fake HubSpot stopped" hs_stopped
wait "$HS_PID" 2>/dev/null || true
