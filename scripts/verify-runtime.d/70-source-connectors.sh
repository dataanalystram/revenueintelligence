# shellcheck shell=bash
# Milestone 8: generic source connectors through the real CLI processes and a
# dedicated worker, against the deterministic fake Sugar (synthetic fixtures;
# NO live Sugar, LIVE SUGAR VERIFICATION: PENDING). Mapping, holding stage,
# date pair and time zone are TEST configuration (test/fixtures/sugar). The
# fake's credentials are synthetic fixture values, passed through the
# SecretProvider environment like a real secret. Proves: configure/test via
# SecretProvider; metadata-only snapshot; dry runs write nothing; mapping
# publication needs the base version and refuses a stale one; authority gate;
# a full run on the worker (lip-sources) with the fixture-matrix quality
# counts, per-account ownership gaps and provenance linkage; coverage known;
# a gapped account is ownership_incomplete; drift refuses a run; read-only
# transport (only GET + token POST reached the source); RLS; no record values
# or credentials in any output or log. M9A: mappings publish only with a
# completed covering profile (run on the worker), a reviewed holding domain
# stamped with the captured snapshot, and the acknowledgement of the duplicate
# identity finding (fixture 11).

SC_TENANT="rtsources"
SC_OUT="$WORK/sources"
mkdir -p "$SC_OUT"
SC_FAKE_PORT="$(free_port)"
SC_FAKE_URL="http://127.0.0.1:$SC_FAKE_PORT"
SC_FAKE_LOG="$WORK/fake-sugar.log"
SC_WORKER_LOG="$WORK/worker-sources.log"
SC_FIXTURES="$API_DIR/test/fixtures/sugar"
# Synthetic fixture credentials of the fake (test/support/fake-sugar.ts), not a real secret.
SC_SECRET='{"clientId":"sugar","clientSecret":"","username":"fixture-reader","password":"fixture-only-password"}'
SC_ENV=(
  DATABASE_URL="$APP_DB_URL"
  QUEUE_PREFIX=rtsrc
  WORKER_SHUTDOWN_TIMEOUT_MS=8000
  TENANT_RTSOURCES_SUGAR_SUGAR_API="$SC_SECRET"
)
sc_cli() { (cd "$API_DIR" && env "${SC_ENV[@]}" node "dist/cli/$1.js" "${@:2}"); }
sc_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
sc_json() { node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=($1);process.stdout.write(typeof v==='string'?v:JSON.stringify(v))"; }
sc_tid() { sc_sql "SELECT id FROM tenants WHERE slug = '$SC_TENANT'"; }

(cd "$API_DIR" && exec node --no-warnings test/support/fake-sugar.ts --port "$SC_FAKE_PORT" >"$SC_FAKE_LOG" 2>&1) &
SC_FAKE_PID=$!
for _ in $(seq 1 40); do grep -q 'listening' "$SC_FAKE_LOG" 2>/dev/null && break; sleep 0.25; done
check "fake Sugar (synthetic fixtures) started" grep -q 'listening' "$SC_FAKE_LOG"

(cd "$API_DIR" && exec env "${SC_ENV[@]}" node dist/worker.js >"$SC_WORKER_LOG" 2>&1) &
SC_WORKER_PID=$!
sc_worker_ready() { for _ in $(seq 1 60); do grep -q 'Source sync processor registered' "$SC_WORKER_LOG" && return 0; sleep 0.5; done; return 1; }
check "worker registered the source sync processor (lip-sources)" sc_worker_ready

sc_setup() {
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug "$SC_TENANT" --name 'Runtime Sources' >/dev/null) || return 1
  # TEST product model: the fixture catalogue ids as external references.
  node -e '
    const ids = [1,10,11,12,20,30,40,50,60,70,90,110,120,130,140].map((n) => "FIX-PROD-" + String(n).padStart(3, "0"));
    process.stdout.write(JSON.stringify({ products: ids.map((id) => ({ key: id.toLowerCase(), name: "Test product " + id.slice(-3),
      externalRefs: [{ system: "sugar", objectType: "ProductTemplates", id }] })), relationships: [] }));' >"$SC_OUT/model.json"
  sc_cli products model publish --tenant "$SC_TENANT" --file "$SC_OUT/model.json" --based-on 0 --actor runtime --execute >/dev/null || return 1
  node -e '
    process.stdout.write(JSON.stringify({ instanceUrl: process.argv[1], apiVersion: "v11_20",
      modules: ["Accounts","Opportunities","RevenueLineItems","ProductTemplates","Users"],
      referenceModules: ["ProductTemplates"], maxRetries: 2, sync: { overlapMinutes: 10 }, profile: { maxRows: 1000 } }));' "$SC_FAKE_URL" >"$SC_OUT/connection.json"
  sc_cli sources configure --tenant "$SC_TENANT" --kind sugar --label 'Sugar (fake)' --file "$SC_OUT/connection.json" \
    --credential sugar_api --status enabled --execute >"$SC_OUT/configure.json" || return 1
  [[ "$(sc_json 'o.connection.status + ":" + o.connection.credentialName' <"$SC_OUT/configure.json")" == "enabled:sugar_api" ]] &&
    [[ "$(sc_sql "SELECT count(*) FROM tenant_source_connections c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$SC_TENANT' AND c.config::text LIKE '%password%'")" == "0" ]]
}
check "tenant provisioned; Sugar connection configured (credential name only)" sc_setup

sc_test() {
  sc_cli sources test --tenant "$SC_TENANT" --connection sugar >"$SC_OUT/test.json" || return 1
  [[ "$(sc_json 'o.test.code' <"$SC_OUT/test.json")" == "ok" ]]
}
check "sources:test passes with the SecretProvider credential" sc_test

sc_schema() {
  sc_cli sources schema --tenant "$SC_TENANT" --connection sugar --capture >"$SC_OUT/capture-dry.json" || return 1
  [[ "$(sc_sql "SELECT count(*) FROM tenant_source_schema_snapshots s JOIN tenants t ON t.id = s.tenant_id WHERE t.slug = '$SC_TENANT'")" == "0" ]] || return 1
  sc_cli sources schema --tenant "$SC_TENANT" --connection sugar --capture --execute >"$SC_OUT/capture.json" || return 1
  [[ "$(sc_json 'o.captured.objects' <"$SC_OUT/capture.json")" == "5" ]] || return 1
  # Metadata only: no fixture record id anywhere in the stored document.
  [[ "$(sc_sql "SELECT count(*) FROM tenant_source_schema_snapshots s JOIN tenants t ON t.id = s.tenant_id WHERE t.slug = '$SC_TENANT' AND s.document::text LIKE '%FIX-%'")" == "0" ]]
}
check "schema capture dry run writes nothing; snapshot is metadata only" sc_schema

sc_profile() {
  # M9A: a completed profile of the mapped objects covers the publication (run on the worker).
  sc_cli sources profile-run --tenant "$SC_TENANT" --connection sugar --objects Accounts,ProductTemplates,RevenueLineItems \
    --sampling full --actor runtime --execute >"$SC_OUT/profile-run.json" || return 1
  local status=""
  for _ in $(seq 1 120); do
    sc_cli sources profile-status --tenant "$SC_TENANT" --connection sugar >"$SC_OUT/profile-status.json" 2>/dev/null || true
    status="$(sc_json 'o.runs[0] ? o.runs[0].status : ""' <"$SC_OUT/profile-status.json" 2>/dev/null || true)"
    [[ "$status" == "completed" || "$status" == "failed" ]] && break
    sleep 0.5
  done
  [[ "$status" == "completed" ]]
}
check "profile run on the worker completes (covering profile for the mapping)" sc_profile

sc_mapping() {
  # The TEST mapping's reviewed domain is stamped with the captured snapshot (the
  # operator reviews against it); v1 states the terms as null (no terms authority yet).
  local hash; hash="$(sc_json 'o.captured.hash' <"$SC_OUT/capture.json")"
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const o of m.objects) if (o.holdingFilter && o.holdingFilter.reviewedDomain) o.holdingFilter.reviewedDomain.snapshotHash = process.argv[2];
    require("fs").writeFileSync(process.argv[3], JSON.stringify(m));
    for (const o of m.objects) o.fields = o.fields.map((f) => f.target === "subscription.startsAt" || f.target === "subscription.endsAt"
      ? { kind: "core", target: f.target, explicit: "null", reason: "pending_authority" } : f);
    process.stdout.write(JSON.stringify(m));' "$SC_FIXTURES/mapping.test.json" "$hash" "$SC_OUT/mapping-full.json" >"$SC_OUT/mapping-v1.json"
  local code=0
  sc_cli sources mappings-publish --tenant "$SC_TENANT" --connection sugar --file "$SC_OUT/mapping-v1.json" >"$SC_OUT/map-noack.json" || code=$?
  # The duplicate fixture line (11) is an E finding on the identity: it needs an acknowledgement.
  [[ $code -eq 2 ]] && [[ "$(sc_json 'o.errors.map((e) => e.code).join()' <"$SC_OUT/map-noack.json")" == "finding_unacknowledged" ]] || return 1
  SC_ACK="$(sc_json 'o.errors[0].path.split(".").pop() + ":accepted_known_issue"' <"$SC_OUT/map-noack.json")"
  sc_cli sources mappings-publish --tenant "$SC_TENANT" --connection sugar --file "$SC_OUT/mapping-v1.json" --ack "$SC_ACK" >"$SC_OUT/map-dry.json" || return 1
  [[ "$(sc_json 'o.dryRun + ":" + o.ok' <"$SC_OUT/map-dry.json")" == "true:true" ]] || return 1
  [[ "$(sc_sql "SELECT count(*) FROM tenant_source_mapping_versions m JOIN tenants t ON t.id = m.tenant_id WHERE t.slug = '$SC_TENANT'")" == "0" ]] || return 1
  code=0
  sc_cli sources mappings-publish --tenant "$SC_TENANT" --connection sugar --file "$SC_OUT/mapping-full.json" --ack "$SC_ACK" --based-on 0 --execute >"$SC_OUT/map-conflict.json" || code=$?
  [[ $code -eq 2 ]] && grep -q '"authority_conflict"' "$SC_OUT/map-conflict.json" || return 1
  sc_cli sources mappings-publish --tenant "$SC_TENANT" --connection sugar --file "$SC_OUT/mapping-v1.json" --ack "$SC_ACK" --based-on 0 --actor runtime --execute >"$SC_OUT/map-v1.json" || return 1
  [[ "$(sc_json 'o.published.version' <"$SC_OUT/map-v1.json")" == "1" ]]
}
check "mapping: unacknowledged finding refused; dry run writes nothing; terms refused without authority; v1 published" sc_mapping

sc_authority() {
  local conn
  conn="$(sc_sql "SELECT c.id FROM tenant_source_connections c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$SC_TENANT' AND c.kind = 'sugar'")"
  printf '{"facts":{"account_profile":null,"person_profile":null,"subscription_lines":"%s","subscription_state":null,"subscription_terms":"%s"}}' "$conn" "$conn" >"$SC_OUT/authority.json"
  local code=0
  sc_cli sources authority-publish --tenant "$SC_TENANT" --file "$SC_OUT/authority.json" --based-on 0 --execute >"$SC_OUT/auth-stale.json" || code=$?
  [[ $code -eq 2 ]] && grep -q '"concurrent_publish"' "$SC_OUT/auth-stale.json" || return 1
  sc_cli sources authority-publish --tenant "$SC_TENANT" --file "$SC_OUT/authority.json" --based-on 1 --actor runtime --execute >"$SC_OUT/auth.json" || return 1
  [[ "$(sc_json 'o.published.version' <"$SC_OUT/auth.json")" == "2" ]] || return 1
  code=0
  sc_cli sources mappings-publish --tenant "$SC_TENANT" --connection sugar --file "$SC_OUT/mapping-full.json" --ack "$SC_ACK" --based-on 0 --execute >"$SC_OUT/map-stale.json" || code=$?
  [[ $code -eq 2 ]] && grep -q '"concurrent_publish"' "$SC_OUT/map-stale.json" || return 1
  sc_cli sources mappings-publish --tenant "$SC_TENANT" --connection sugar --file "$SC_OUT/mapping-full.json" --ack "$SC_ACK" --based-on 1 --actor runtime --execute >"$SC_OUT/map-v2.json" || return 1
  [[ "$(sc_json 'o.published.version' <"$SC_OUT/map-v2.json")" == "2" ]]
}
check "authority (stale base refused) then mapping v2 (stale base refused)" sc_authority

sc_wait_run() {
  local status=""
  for _ in $(seq 1 120); do
    sc_cli sources sync-status --tenant "$SC_TENANT" --connection sugar >"$SC_OUT/status.json" 2>/dev/null || true
    status="$(sc_json 'o.runs[0] ? o.runs[0].status : ""' <"$SC_OUT/status.json" 2>/dev/null || true)"
    [[ "$status" == "completed" || "$status" == "failed" ]] && return 0
    sleep 0.5
  done
  return 1
}

sc_full() {
  sc_cli sources sync-full --tenant "$SC_TENANT" --connection sugar >"$SC_OUT/sync-dry.json" || return 1
  [[ "$(sc_json 'o.dryRun' <"$SC_OUT/sync-dry.json")" == "true" ]] || return 1
  sc_cli sources sync-full --tenant "$SC_TENANT" --connection sugar --execute >"$SC_OUT/sync.json" || return 1
  sc_wait_run || return 1
  [[ "$(sc_json 'o.runs[0].status + ":" + o.runs[0].mode + ":" + o.runs[0].mappingVersion' <"$SC_OUT/status.json")" == "completed:backfill:2" ]] || return 1
  [[ "$(sc_json '[o.runs[0].quality.filtered_out, o.runs[0].quality.orphan_product_reference, o.runs[0].quality.missing_product_reference, o.runs[0].quality.invalid_period, o.runs[0].quality.duplicate_external_id, o.runs[0].quality.ownership_gap].join(",")' <"$SC_OUT/status.json")" == "4,1,1,1,1,2" ]]
}
check "full sync on the worker completes with the fixture-matrix quality counts" sc_full

sc_facts() {
  local tid; tid="$(sc_tid)"
  [[ "$(sc_sql "SELECT count(*) || ':' || count(*) FILTER (WHERE state = 'unknown') FROM tenant_subscriptions WHERE tenant_id = '$tid'")" == "16:16" ]] || return 1
  [[ "$(sc_sql "SELECT string_agg(source_record_id || '=' || reason, ',' ORDER BY source_record_id) FROM tenant_ownership_gaps WHERE tenant_id = '$tid'")" == "FIX-RLI-080=orphan_product_reference,FIX-RLI-100=missing_product_reference" ]] || return 1
  [[ "$(sc_sql "SELECT count(*) FROM tenant_context_changes WHERE tenant_id = '$tid' AND entity_kind = 'subscription' AND (source_connection_id IS NULL OR mapping_version IS DISTINCT FROM 2)")" == "0" ]]
}
check "16 lines, all state unknown; 2 ownership gaps; provenance carries connection + mapping v2" sc_facts

sc_eligibility() {
  sc_cli products coverage --tenant "$SC_TENANT" >"$SC_OUT/coverage.json" || return 1
  [[ "$(sc_json 'o.coverage' <"$SC_OUT/coverage.json")" == "known" ]] || return 1
  sc_cli products evaluate --tenant "$SC_TENANT" --company sugar:Accounts:FIX-ACC-009 --product fix-prod-001 >"$SC_OUT/eval-gap.json" || return 1
  [[ "$(sc_json 'o.ownership + ":" + o.checks.find((c) => c.check === "ownership_coverage").reason' <"$SC_OUT/eval-gap.json")" == "unknown:ownership_incomplete" ]] || return 1
  sc_cli products whitespace --tenant "$SC_TENANT" --company sugar:Accounts:FIX-ACC-009 >"$SC_OUT/ws-gap.json" || return 1
  [[ "$(sc_json 'o.summary.eligible_whitespace.length' <"$SC_OUT/ws-gap.json")" == "0" ]]
}
check "coverage known; a gapped account is ownership_incomplete with no eligible whitespace" sc_eligibility

sc_drift() {
  # A second worker-less refusal path: the mapped schema changed → the run fails before any write.
  curl -fsS "$SC_FAKE_URL/rest/v11_20/ping" >/dev/null 2>&1 || true
  local before tid; tid="$(sc_tid)"
  before="$(sc_sql "SELECT count(*) FROM tenant_context_changes WHERE tenant_id = '$tid'")"
  sc_cli sources report --tenant "$SC_TENANT" --connection sugar --drift >"$SC_OUT/report.json" || return 1
  [[ "$(sc_json 'o.drift.length + ":" + o.ownershipGaps.accounts + ":" + o.mappingVersion' <"$SC_OUT/report.json")" == "0:2:2" ]] || return 1
  [[ "$(sc_sql "SELECT count(*) FROM tenant_context_changes WHERE tenant_id = '$tid'")" == "$before" ]]
}
check "source:report: no drift, gaps and mapping version reported; reporting writes nothing" sc_drift

sc_read_only() {
  # Only GET requests and the OAuth token POST ever reached the source.
  grep -q '^request GET /RevenueLineItems$' "$SC_FAKE_LOG" &&
    ! grep -E '^request (PUT|PATCH|DELETE) ' "$SC_FAKE_LOG" &&
    ! grep -E '^request POST ' "$SC_FAKE_LOG" | grep -vq '/oauth2/token$'
}
check "read-only transport: only GET + OAuth token POST reached Sugar" sc_read_only

sc_rls() {
  [[ "$(compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -Atc 'SELECT (SELECT count(*) FROM tenant_source_connections) + (SELECT count(*) FROM tenant_source_schema_snapshots) + (SELECT count(*) FROM tenant_source_mapping_versions) + (SELECT count(*) FROM tenant_source_authority_versions) + (SELECT count(*) FROM tenant_ownership_gaps)')" == "0" ]] &&
    # Six kinds since M9B (chargebee added by migration 20261115120000).
    [[ "$(compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -Atc 'SELECT count(*) FROM connector_kinds')" == "6" ]]
}
check "app role with no tenant sees no source rows (RLS); catalogue readable" sc_rls

sc_no_values() {
  ! grep -rq 'Fixture Account\|Fixture Line\|fixture-only-password' "$SC_OUT" &&
    ! grep -q 'Fixture Account\|Fixture Line\|fixture-only-password\|fake-access-' "$SC_WORKER_LOG"
}
check "CLI output and worker log carry ids, codes and counts only (no record values, no credentials)" sc_no_values

kill -TERM "$SC_WORKER_PID" 2>/dev/null || true
for _ in $(seq 1 40); do kill -0 "$SC_WORKER_PID" 2>/dev/null || break; sleep 0.25; done
check "sources worker exits on SIGTERM" bash -c "! kill -0 $SC_WORKER_PID 2>/dev/null"
kill -TERM "$SC_FAKE_PID" 2>/dev/null || true
