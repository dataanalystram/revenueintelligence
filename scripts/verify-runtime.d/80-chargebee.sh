# shellcheck shell=bash
# Milestone 9B: the Chargebee reference adapter through the real CLIs and a
# dedicated worker, against the deterministic fake Chargebee (synthetic data;
# NO live Chargebee: LIVE CHARGEBEE VERIFICATION PENDING, V2–V12). Mapping,
# holding filter, reviewed domain and status map are TEST configuration
# (test/fixtures/chargebee). Proves: the loopback-only endpoint and config are
# validated; the read-only API key resolves through the SecretProvider (env
# variable, never a CLI argument); connection test; a metadata-only snapshot
# with the double-enumeration and child-set capabilities; a profile run on the
# worker; publication with acknowledgements under an authority version that
# accepts the proof; a full sync on `lip-sources` proving
# double_enumeration → stable_snapshot (never externally grounded) with the
# versioned status map; absence stays unknown (no eligible whitespace);
# incremental runs refused while V12 is unverified; only GETs to allowlisted
# list endpoints reached the fake; no key, record values or payment data in
# output or logs; graceful worker shutdown.

CB_TENANT="rtchargebee"
CB_OUT="$WORK/chargebee"
mkdir -p "$CB_OUT"
CB_FAKE_PORT="$(free_port)"
CB_FAKE_URL="http://127.0.0.1:$CB_FAKE_PORT"
CB_FAKE_LOG="$WORK/fake-chargebee.log"
CB_WORKER_LOG="$WORK/worker-chargebee.log"
CB_FIXTURES="$API_DIR/test/fixtures/chargebee"
# Synthetic key of the fake (test/support/fake-chargebee.ts), not a credential of any real site.
CB_KEY='test_fakeChargebeeReadOnlyKey0001'
CB_ENV=(
  DATABASE_URL="$APP_DB_URL"
  QUEUE_PREFIX=rtcbe
  WORKER_SHUTDOWN_TIMEOUT_MS=8000
  # EnvSecretProvider name of tenant.rtchargebee.chargebee.chargebee_api.
  TENANT_RTCHARGEBEE_CHARGEBEE_CHARGEBEE_API="$CB_KEY"
)
cb_cli() { (cd "$API_DIR" && env "${CB_ENV[@]}" node "dist/cli/$1.js" "${@:2}"); }
cb_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
cb_json() { node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=($1);process.stdout.write(typeof v==='string'?v:JSON.stringify(v))"; }
cb_tid() { cb_sql "SELECT id FROM tenants WHERE slug = '$CB_TENANT'"; }
cb_conn() { cb_sql "SELECT c.id FROM tenant_source_connections c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$CB_TENANT' AND c.kind = 'chargebee'"; }
cb_wait() {
  # $1: profile-status | sync-status
  local status=""
  for _ in $(seq 1 120); do
    cb_cli sources "$1" --tenant "$CB_TENANT" --connection chargebee >"$CB_OUT/$1.json" 2>/dev/null || true
    status="$(cb_json 'o.runs[0] ? o.runs[0].status : ""' <"$CB_OUT/$1.json" 2>/dev/null || true)"
    [[ "$status" == "completed" || "$status" == "failed" ]] && break
    sleep 0.5
  done
  printf '%s' "$status"
}
# All acknowledgement flags a validation report asks for (TEST: accepted_known_issue).
cb_acks() {
  cb_json 'o.errors.filter((e) => e.code === "finding_unacknowledged").map((e) => "--ack=" + e.path.split(".").pop() + ":accepted_known_issue").join(" ")'
}

(cd "$API_DIR" && exec node --no-warnings test/support/fake-chargebee.ts --port "$CB_FAKE_PORT" >>"$CB_FAKE_LOG" 2>&1) &
CB_FAKE_PID=$!
cb_fake_ready() { for _ in $(seq 1 40); do grep -q 'listening' "$CB_FAKE_LOG" 2>/dev/null && return 0; sleep 0.25; done; return 1; }
check "fake Chargebee (synthetic data) started" cb_fake_ready

(cd "$API_DIR" && exec env "${CB_ENV[@]}" node dist/worker.js >"$CB_WORKER_LOG" 2>&1) &
CB_WORKER_PID=$!
cb_worker_ready() { for _ in $(seq 1 60); do grep -q 'Source sync processor registered' "$CB_WORKER_LOG" && return 0; sleep 0.5; done; return 1; }
check "worker registered the lip-sources processor" cb_worker_ready

cb_setup() {
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug "$CB_TENANT" --name 'Runtime Chargebee' >/dev/null) || return 1
  node -e '
    const ids = ["plan-basic", "plan-pro", "addon-seats", "addon-support", "charge-setup"];
    process.stdout.write(JSON.stringify({ products: ids.map((id) => ({ key: id, name: "Test product " + id,
      externalRefs: [{ system: "chargebee", objectType: "Items", id }] })), relationships: [] }));' >"$CB_OUT/model.json"
  cb_cli products model publish --tenant "$CB_TENANT" --file "$CB_OUT/model.json" --based-on 0 --actor runtime --execute >/dev/null || return 1
  # A non-loopback endpoint is refused (a real site is only ever https://<site>.chargebee.com).
  node -e 'process.stdout.write(JSON.stringify({ site: "synthetic-test", endpoint: "http://198.51.100.7:80", sync: { overlapMinutes: 10 }, profile: { maxRows: 1000 } }));' >"$CB_OUT/connection-bad.json"
  node -e 'process.stdout.write(JSON.stringify({ site: "synthetic-test", endpoint: process.argv[1], maxRetries: 2, sync: { overlapMinutes: 10 }, profile: { maxRows: 1000 } }));' "$CB_FAKE_URL" >"$CB_OUT/connection.json"
  local code=0
  cb_cli sources configure --tenant "$CB_TENANT" --kind chargebee --label 'Chargebee (fake)' --file "$CB_OUT/connection-bad.json" \
    --credential chargebee_api --status enabled --execute >"$CB_OUT/configure-bad.json" || code=$?
  [[ $code -eq 2 ]] && [[ "$(cb_json 'o.code' <"$CB_OUT/configure-bad.json")" == "invalid_config" ]] || return 1
  cb_cli sources configure --tenant "$CB_TENANT" --kind chargebee --label 'Chargebee (fake)' --file "$CB_OUT/connection.json" \
    --credential chargebee_api --status enabled --execute >"$CB_OUT/configure.json" || return 1
  [[ "$(cb_json 'o.connection.kind + ":" + o.connection.credentialName + ":" + o.connection.status' <"$CB_OUT/configure.json")" == "chargebee:chargebee_api:enabled" ]] || return 1
  cb_cli sources test --tenant "$CB_TENANT" --connection chargebee >"$CB_OUT/test.json" || return 1
  [[ "$(cb_json 'o.test.ok + ":" + o.test.code + ":" + o.test.sourceVersion' <"$CB_OUT/test.json")" == "true:ok:v2:pc2" ]]
}
check "non-loopback endpoint refused; connection configured with a credential name; connection test ok (API v2, PC 2.0)" cb_setup

cb_schema() {
  cb_cli sources schema --tenant "$CB_TENANT" --connection chargebee --capture --execute >"$CB_OUT/capture.json" || return 1
  cb_cli sources schema --tenant "$CB_TENANT" --connection chargebee >"$CB_OUT/schema.json" || return 1
  [[ "$(cb_json 'o.objects.map((x) => x.name).sort().join()' <"$CB_OUT/schema.json")" == "Customers,ItemPrices,Items,SubscriptionItems,Subscriptions" ]] || return 1
  [[ "$(cb_json '(({ capabilities: c }) => [c.count, c.fullReadProof, c.childOf.object, c.childOf.parentKeyField, c.incrementalReads].join(":"))(o.objects.find((x) => x.name === "SubscriptionItems"))' <"$CB_OUT/schema.json")" == "false:double_enumeration:Subscriptions:subscription_id:false" ]]
}
check "metadata-only snapshot: five objects; SubscriptionItems is a double-enumerated child set of Subscriptions, full runs only (V12 unverified)" cb_schema

cb_profile() {
  cb_cli sources profile-run --tenant "$CB_TENANT" --connection chargebee --objects Customers,Items,SubscriptionItems \
    --sampling full --actor runtime --execute >"$CB_OUT/prf-run.json" || return 1
  [[ "$(cb_wait profile-status)" == "completed" ]]
}
check "profile run on the worker (source.profile) completes" cb_profile

cb_publish() {
  local hash; hash="$(cb_json 'o.captured.hash' <"$CB_OUT/capture.json")"
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const o of m.objects) if (o.holdingFilter && o.holdingFilter.reviewedDomain) o.holdingFilter.reviewedDomain.snapshotHash = process.argv[2];
    fs.writeFileSync(process.argv[3], JSON.stringify(m));
    const v1 = structuredClone(m);
    for (const o of v1.objects) o.fields = o.fields.map((f) =>
      f.target === "subscription.startsAt" || f.target === "subscription.endsAt"
        ? { kind: "core", target: f.target, explicit: "null", reason: "pending_authority" }
        : f.target === "subscription.state" ? { kind: "core", target: f.target, explicit: "unknown", reason: "pending_authority" } : f);
    fs.writeFileSync(process.argv[4], JSON.stringify(v1));' \
    "$CB_FIXTURES/mapping.test.json" "$hash" "$CB_OUT/mapping-full.json" "$CB_OUT/mapping-v1.json" || return 1
  cb_cli sources mappings-validate --tenant "$CB_TENANT" --connection chargebee --file "$CB_OUT/mapping-v1.json" >"$CB_OUT/validate-v1.json" || true
  local acks; acks="$(cb_acks <"$CB_OUT/validate-v1.json")"
  # shellcheck disable=SC2086
  cb_cli sources mappings-publish --tenant "$CB_TENANT" --connection chargebee --file "$CB_OUT/mapping-v1.json" $acks \
    --based-on 0 --actor runtime --execute >"$CB_OUT/map-v1.json" || return 1
  [[ "$(cb_json 'o.published.version' <"$CB_OUT/map-v1.json")" == "1" ]] || return 1
  local conn; conn="$(cb_conn)"
  printf '{"facts":{"account_profile":null,"person_profile":null,"subscription_lines":"%s","subscription_state":"%s","subscription_terms":"%s"}}' "$conn" "$conn" "$conn" >"$CB_OUT/authority.json"
  cb_cli sources authority-publish --tenant "$CB_TENANT" --file "$CB_OUT/authority.json" --based-on 1 --actor runtime \
    --accept-proof "$conn:runtime double enumeration reviewed" --execute >"$CB_OUT/authority-out.json" || return 1
  [[ "$(cb_json 'o.published.proofAcceptances.map((a) => a.tier).join()' <"$CB_OUT/authority-out.json")" == "stable_snapshot" ]] || return 1
  cb_cli sources mappings-validate --tenant "$CB_TENANT" --connection chargebee --file "$CB_OUT/mapping-full.json" >"$CB_OUT/validate-v2.json" || true
  acks="$(cb_acks <"$CB_OUT/validate-v2.json")"
  # shellcheck disable=SC2086
  cb_cli sources mappings-publish --tenant "$CB_TENANT" --connection chargebee --file "$CB_OUT/mapping-full.json" $acks \
    --based-on 1 --actor runtime --execute >"$CB_OUT/map-v2.json" || return 1
  [[ "$(cb_json 'o.published.version' <"$CB_OUT/map-v2.json")" == "2" ]]
}
check "v1 (no state/terms) → authority with an accepted stable_snapshot proof → v2 with the versioned status map and Unix-seconds terms" cb_publish

cb_sync() {
  cb_cli sources sync-full --tenant "$CB_TENANT" --connection chargebee --execute >/dev/null || return 1
  [[ "$(cb_wait sync-status)" == "completed" ]] || return 1
  [[ "$(cb_json '[o.runs[0].quality.proof.method, o.runs[0].quality.proof.tier, o.runs[0].quality.proof.outcome].join(":")' <"$CB_OUT/sync-status.json")" == "double_enumeration:stable_snapshot:passed" ]] || return 1
  local tid; tid="$(cb_tid)"
  [[ "$(cb_sql "SELECT count(*) FROM tenant_subscriptions WHERE tenant_id = '$tid' AND source_system = 'chargebee' AND record_state = 'active'")" == "21" ]] || return 1
  [[ "$(cb_sql "SELECT string_agg(state, ',' ORDER BY source_record_id) FROM tenant_subscriptions WHERE tenant_id = '$tid' AND source_record_id IN ('sub-04:plan-pro-USD-monthly', 'sub-06:plan-basic-USD-monthly', 'sub-07:plan-basic-USD-monthly', 'sub-08:plan-basic-USD-monthly')")" == "trial,active,cancelled,unknown" ]]
}
check "full sync on lip-sources: double_enumeration → stable_snapshot (passed); 21 lines; versioned status map" cb_sync

cb_eligibility() {
  cb_cli products evaluate --tenant "$CB_TENANT" --company chargebee:Customers:cus-02 --product plan-basic >"$CB_OUT/eval-absent.json" || return 1
  [[ "$(cb_json '[o.coverageTier, o.ownership].join(":")' <"$CB_OUT/eval-absent.json")" == "stable_snapshot:unknown" ]] || return 1
  [[ "$(cb_json 'o.status' <"$CB_OUT/eval-absent.json")" != "eligible" ]] || return 1
  ! grep -q 'externally_grounded' "$CB_OUT/eval-absent.json" "$CB_OUT/sync-status.json"
}
check "absence stays unknown under stable_snapshot (no whitespace); never externally grounded" cb_eligibility

cb_incremental() {
  local code=0
  cb_cli sources sync-incremental --tenant "$CB_TENANT" --connection chargebee --execute >"$CB_OUT/incr.json" || code=$?
  [[ $code -eq 2 ]] && [[ "$(cb_json 'o.code' <"$CB_OUT/incr.json")" == "incremental_not_supported" ]]
}
check "incremental sync refused while V12 is unverified (full runs only)" cb_incremental

cb_rls() {
  [[ "$(compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -Atc "SELECT count(*) FROM tenant_subscriptions WHERE source_system = 'chargebee'")" == "0" ]]
}
check "app role with no tenant sees no Chargebee lines (RLS)" cb_rls

kill -TERM "$CB_WORKER_PID" 2>/dev/null || true
for _ in $(seq 1 40); do kill -0 "$CB_WORKER_PID" 2>/dev/null || break; sleep 0.25; done
check "Chargebee worker exits on SIGTERM" bash -c "! kill -0 $CB_WORKER_PID 2>/dev/null"
kill -TERM "$CB_FAKE_PID" 2>/dev/null || true
for _ in $(seq 1 40); do kill -0 "$CB_FAKE_PID" 2>/dev/null || break; sleep 0.25; done

cb_read_only() {
  # The fake prints every request it served on shutdown (method and path only).
  grep -q '^request GET /subscriptions$' "$CB_FAKE_LOG" &&
    ! grep '^request ' "$CB_FAKE_LOG" | grep -qv '^request GET /\(customers\|items\|item_prices\|subscriptions\)$'
}
check "only GETs to the four allowlisted list endpoints reached the fake (no write, no payment endpoint)" cb_read_only

cb_no_values() {
  ! grep -rq "$CB_KEY\|Synthetic Co\|example.invalid\|masked_number\|card_type" "$CB_OUT" &&
    ! grep -q "$CB_KEY\|Synthetic Co\|example.invalid\|masked_number" "$CB_WORKER_LOG" &&
    [[ "$(cb_sql "SELECT count(*) FROM tenant_source_profiles WHERE tenant_id = '$(cb_tid)' AND (document::text LIKE '%Synthetic Co%' OR document::text LIKE '%example.invalid%' OR document::text LIKE '%$CB_KEY%')")" == "0" ]]
}
check "CLI output, worker log and profiles carry no API key, customer values or payment data" cb_no_values
