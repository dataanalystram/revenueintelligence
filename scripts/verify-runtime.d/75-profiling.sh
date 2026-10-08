# shellcheck shell=bash
# Milestone 9A: source data profiling and record-level safety through the real
# CLI processes and a dedicated worker, against the deterministic fake Sugar
# (synthetic fixtures; NO live Sugar, LIVE SUGAR VERIFICATION: PENDING).
# Mapping, holding stage and reviewed domain are TEST configuration
# (test/fixtures/sugar). Proves: D2 limits refuse (never clamp); a profile run
# on the worker (lip-sources, source.profile); aggregate-only documents and
# findings; the draft never publishes; publication needs a covering profile and
# acknowledgements; the override is refused (A1); a full sync records a count
# proof (externally grounded); an unreviewed holding value keeps its line and
# makes the account unknown; under not_in it never becomes a holding; the purge
# refuses the app role; no record values or credentials in output or logs.

PR_TENANT="rtprofile"
PR_OUT="$WORK/profiling"
mkdir -p "$PR_OUT"
PR_FAKE_PORT="$(free_port)"
PR_FAKE_URL="http://127.0.0.1:$PR_FAKE_PORT"
PR_FAKE_LOG="$WORK/fake-sugar-profiling.log"
PR_WORKER_LOG="$WORK/worker-profiling.log"
PR_FIXTURES="$API_DIR/test/fixtures/sugar"
# Synthetic fixture credentials of the fake (test/support/fake-sugar.ts), not a real secret.
PR_SECRET='{"clientId":"sugar","clientSecret":"","username":"fixture-reader","password":"fixture-only-password"}'
PR_ENV=(
  DATABASE_URL="$APP_DB_URL"
  QUEUE_PREFIX=rtprf
  WORKER_SHUTDOWN_TIMEOUT_MS=8000
  TENANT_RTPROFILE_SUGAR_SUGAR_API="$PR_SECRET"
  # Second tenant of the field-name privacy check (same synthetic fixture credential).
  TENANT_RTPROFNAMES_SUGAR_SUGAR_API="$PR_SECRET"
)
pr_cli() { (cd "$API_DIR" && env "${PR_ENV[@]}" node "dist/cli/$1.js" "${@:2}"); }
pr_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
pr_json() { node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=($1);process.stdout.write(typeof v==='string'?v:JSON.stringify(v))"; }
pr_tid() { pr_sql "SELECT id FROM tenants WHERE slug = '$PR_TENANT'"; }
pr_fake() {
  (cd "$API_DIR" && exec node --no-warnings test/support/fake-sugar.ts --port "$PR_FAKE_PORT" "$@" >>"$PR_FAKE_LOG" 2>&1) &
  PR_FAKE_PID=$!
  for _ in $(seq 1 40); do [[ "$(grep -c 'listening' "$PR_FAKE_LOG" 2>/dev/null)" -ge "$PR_FAKE_STARTS" ]] && return 0; sleep 0.25; done
  return 1
}
pr_wait() {
  # $1: profile-status | sync-status
  local status=""
  for _ in $(seq 1 120); do
    pr_cli sources "$1" --tenant "$PR_TENANT" --connection sugar >"$PR_OUT/$1.json" 2>/dev/null || true
    status="$(pr_json 'o.runs[0] ? o.runs[0].status : ""' <"$PR_OUT/$1.json" 2>/dev/null || true)"
    [[ "$status" == "completed" || "$status" == "failed" ]] && break
    sleep 0.5
  done
  printf '%s' "$status"
}

PR_FAKE_STARTS=1
pr_fake
check "fake Sugar (synthetic fixtures) started for profiling" grep -q 'listening' "$PR_FAKE_LOG"

(cd "$API_DIR" && exec env "${PR_ENV[@]}" node dist/worker.js >"$PR_WORKER_LOG" 2>&1) &
PR_WORKER_PID=$!
pr_worker_ready() { for _ in $(seq 1 60); do grep -q 'Source sync processor registered' "$PR_WORKER_LOG" && return 0; sleep 0.5; done; return 1; }
check "worker registered the lip-sources processor (source.sync + source.profile)" pr_worker_ready

pr_setup() {
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug "$PR_TENANT" --name 'Runtime Profiling' >/dev/null) || return 1
  node -e '
    const ids = [1,10,11,12,20,30,40,50,60,70,90,110,120,130,140].map((n) => "FIX-PROD-" + String(n).padStart(3, "0"));
    process.stdout.write(JSON.stringify({ products: ids.map((id) => ({ key: id.toLowerCase(), name: "Test product " + id.slice(-3),
      externalRefs: [{ system: "sugar", objectType: "ProductTemplates", id }] })), relationships: [] }));' >"$PR_OUT/model.json"
  pr_cli products model publish --tenant "$PR_TENANT" --file "$PR_OUT/model.json" --based-on 0 --actor runtime --execute >/dev/null || return 1
  local conf='{ instanceUrl: process.argv[1], apiVersion: "v11_20", modules: ["Accounts","Opportunities","RevenueLineItems","ProductTemplates","Users"], referenceModules: ["ProductTemplates"], maxRetries: 2, sync: { overlapMinutes: 10 }'
  node -e "process.stdout.write(JSON.stringify($conf, profile: { maxRows: 999 } }));" "$PR_FAKE_URL" >"$PR_OUT/connection-bad.json"
  node -e "process.stdout.write(JSON.stringify($conf, profile: { maxRows: 1000 } }));" "$PR_FAKE_URL" >"$PR_OUT/connection.json"
  local code=0
  pr_cli sources configure --tenant "$PR_TENANT" --kind sugar --label 'Sugar (fake)' --file "$PR_OUT/connection-bad.json" \
    --credential sugar_api --status enabled --execute >"$PR_OUT/configure-bad.json" || code=$?
  [[ $code -eq 2 ]] && [[ "$(pr_json 'o.code' <"$PR_OUT/configure-bad.json")" == "profile_limit_out_of_range" ]] || return 1
  pr_cli sources configure --tenant "$PR_TENANT" --kind sugar --label 'Sugar (fake)' --file "$PR_OUT/connection.json" \
    --credential sugar_api --status enabled --execute >/dev/null || return 1
  pr_cli sources schema --tenant "$PR_TENANT" --connection sugar --capture --execute >"$PR_OUT/capture.json"
}
check "connection limit below the D2 minimum refused; connection configured; schema captured" pr_setup

pr_stamp() {
  local hash; hash="$(pr_json 'o.captured.hash' <"$PR_OUT/capture.json")"
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const o of m.objects) if (o.holdingFilter && o.holdingFilter.reviewedDomain) o.holdingFilter.reviewedDomain.snapshotHash = process.argv[2];
    fs.writeFileSync(process.argv[3], JSON.stringify(m));
    const v1 = structuredClone(m);
    for (const o of v1.objects) o.fields = o.fields.map((f) => f.target === "subscription.startsAt" || f.target === "subscription.endsAt"
      ? { kind: "core", target: f.target, explicit: "null", reason: "pending_authority" } : f);
    fs.writeFileSync(process.argv[4], JSON.stringify(v1));
    const notIn = structuredClone(m);
    for (const o of notIn.objects) if (o.holdingFilter) {
      o.holdingFilter.operator = "not_in";
      o.holdingFilter.values = o.holdingFilter.reviewedDomain.entries.filter((e) => e.value !== null && e.classification === "non_holding").map((e) => e.value);
    }
    fs.writeFileSync(process.argv[5], JSON.stringify(notIn));' \
    "$PR_FIXTURES/mapping.test.json" "$hash" "$PR_OUT/mapping-full.json" "$PR_OUT/mapping-v1.json" "$PR_OUT/mapping-notin.json"
}

pr_refusals() {
  pr_stamp || return 1
  local code=0
  pr_cli sources mappings-publish --tenant "$PR_TENANT" --connection sugar --file "$PR_OUT/mapping-v1.json" >"$PR_OUT/map-noprofile.json" || code=$?
  [[ $code -eq 2 ]] && [[ "$(pr_json '[...new Set(o.errors.map((e) => e.code))].join()' <"$PR_OUT/map-noprofile.json")" == "profile_required" ]] || return 1
  code=0
  pr_cli sources profile-run --tenant "$PR_TENANT" --connection sugar --objects RevenueLineItems --sampling full --max-rows 1001 --execute >"$PR_OUT/prf-over.json" || code=$?
  [[ $code -eq 2 ]] && [[ "$(pr_json 'o.code' <"$PR_OUT/prf-over.json")" == "profile_limit_out_of_range" ]] || return 1
  code=0
  pr_cli sources profile-run --tenant "$PR_TENANT" --connection sugar --objects RevenueLineItems --sampling head --execute >"$PR_OUT/prf-head.json" || code=$?
  [[ $code -eq 2 ]] && [[ "$(pr_json 'o.code' <"$PR_OUT/prf-head.json")" == "sampling_unsupported" ]] || return 1
  pr_cli sources profile-run --tenant "$PR_TENANT" --connection sugar --objects RevenueLineItems --sampling full >"$PR_OUT/prf-dry.json" || return 1
  [[ "$(pr_json 'o.dryRun' <"$PR_OUT/prf-dry.json")" == "true" ]] &&
    [[ "$(pr_sql "SELECT count(*) FROM tenant_source_profile_runs r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = '$PR_TENANT'")" == "0" ]]
}
check "publish without a profile, --max-rows above the connection, unsupported sampling refused; dry run writes nothing" pr_refusals

pr_profile() {
  pr_cli sources profile-run --tenant "$PR_TENANT" --connection sugar --objects Accounts,ProductTemplates,RevenueLineItems \
    --sampling full --actor runtime --execute >"$PR_OUT/prf-run.json" || return 1
  [[ "$(pr_wait profile-status)" == "completed" ]]
}
check "profile run on the worker (source.profile) completes" pr_profile

pr_show() {
  pr_cli sources profile-show --tenant "$PR_TENANT" --connection sugar --object RevenueLineItems >"$PR_OUT/prf-show.json" || return 1
  [[ "$(pr_json 'o.document.v + ":" + o.document.sampling.method + ":" + o.document.sampling.coverage' <"$PR_OUT/prf-show.json")" == "1:full:1" ]] || return 1
  [[ "$(pr_json 'o.document.fields.find((f) => f.name === "sales_stage").categorical.suppressed + ":" + o.document.fields.find((f) => f.name === "id").categorical.suppressed' <"$PR_OUT/prf-show.json")" == "false:true" ]] || return 1
  pr_cli sources profile-findings --tenant "$PR_TENANT" --connection sugar --object RevenueLineItems >"$PR_OUT/prf-findings.json" || return 1
  [[ "$(pr_json 'o.findings.some((f) => f.code === "identifier_not_unique" && f.field === "id" && f.class === "existing_fail_closed")' <"$PR_OUT/prf-findings.json")" == "true" ]] || return 1
  pr_cli sources profile-drift --tenant "$PR_TENANT" --connection sugar --object RevenueLineItems >"$PR_OUT/prf-drift.json" || return 1
  [[ "$(pr_json 'o.findings.length' <"$PR_OUT/prf-drift.json")" == "0" ]]
}
check "profile-show / profile-findings / profile-drift return aggregates and coded findings" pr_show

pr_draft() {
  rm -f "$PR_OUT/draft.json"
  pr_cli sources mappings-draft --tenant "$PR_TENANT" --connection sugar --from-profile --out "$PR_OUT/draft.json" >"$PR_OUT/draft-cli.json" || return 1
  [[ "$(pr_json 'o.draft + ":" + o.document.objects.every((x) => x.entity === "tbc") + ":" + o.document.objects.every((x) => x.fields.every((f) => f.kind === "ignored"))' <"$PR_OUT/draft.json")" == "true:true:true" ]] || return 1
  [[ "$(pr_sql "SELECT count(*) FROM tenant_source_mapping_versions m JOIN tenants t ON t.id = m.tenant_id WHERE t.slug = '$PR_TENANT'")" == "0" ]]
}
check "mappings-draft --from-profile writes a draft (entities tbc, nothing mapped) and publishes nothing" pr_draft

pr_publish() {
  local code=0
  pr_cli sources mappings-publish --tenant "$PR_TENANT" --connection sugar --file "$PR_OUT/mapping-v1.json" >"$PR_OUT/map-noack.json" || code=$?
  [[ $code -eq 2 ]] && [[ "$(pr_json 'o.errors.map((e) => e.code).join()' <"$PR_OUT/map-noack.json")" == "finding_unacknowledged" ]] || return 1
  PR_ACK="$(pr_json 'o.errors[0].path.split(".").pop() + ":accepted_known_issue"' <"$PR_OUT/map-noack.json")"
  code=0
  pr_cli sources mappings-publish --tenant "$PR_TENANT" --connection sugar --file "$PR_OUT/mapping-v1.json" --ack "$PR_ACK" \
    --profile-override 'runtime override attempt' --based-on 0 --execute >"$PR_OUT/map-override.json" || code=$?
  [[ $code -eq 2 ]] && grep -q '"override_requires_authenticated_operator"' "$PR_OUT/map-override.json" || return 1
  pr_cli sources mappings-publish --tenant "$PR_TENANT" --connection sugar --file "$PR_OUT/mapping-v1.json" --ack "$PR_ACK" \
    --based-on 0 --actor runtime --execute >"$PR_OUT/map-v1.json" || return 1
  [[ "$(pr_json 'o.published.version + ":" + o.published.acknowledgements' <"$PR_OUT/map-v1.json")" == "1:1" ]] || return 1
  local conn; conn="$(pr_sql "SELECT c.id FROM tenant_source_connections c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$PR_TENANT' AND c.kind = 'sugar'")"
  printf '{"facts":{"account_profile":null,"person_profile":null,"subscription_lines":"%s","subscription_state":null,"subscription_terms":"%s"}}' "$conn" "$conn" >"$PR_OUT/authority.json"
  pr_cli sources authority-publish --tenant "$PR_TENANT" --file "$PR_OUT/authority.json" --based-on 1 --actor runtime --execute >/dev/null || return 1
  pr_cli sources mappings-publish --tenant "$PR_TENANT" --connection sugar --file "$PR_OUT/mapping-full.json" --ack "$PR_ACK" \
    --based-on 1 --actor runtime --execute >"$PR_OUT/map-v2.json" || return 1
  [[ "$(pr_json 'o.published.version' <"$PR_OUT/map-v2.json")" == "2" ]] || return 1
  [[ "$(pr_sql "SELECT validation->'acknowledgements'->0->>'code' FROM tenant_source_mapping_versions m JOIN tenants t ON t.id = m.tenant_id WHERE t.slug = '$PR_TENANT' AND m.version = 2")" == "identifier_not_unique" ]]
}
check "publish refused without acknowledgement; override refused (A1); v1 and v2 published with the recorded acknowledgement" pr_publish

pr_sync() {
  pr_cli sources sync-full --tenant "$PR_TENANT" --connection sugar --execute >/dev/null || return 1
  [[ "$(pr_wait sync-status)" == "completed" ]] || return 1
  # Compared field by field (jsonb does not keep key order).
  [[ "$(pr_json '[o.runs[0].quality.proof.method, o.runs[0].quality.proof.tier, o.runs[0].quality.proof.outcome].join(":")' <"$PR_OUT/sync-status.json")" == "count:externally_grounded:passed" ]] || return 1
  pr_cli products evaluate --tenant "$PR_TENANT" --company sugar:Accounts:FIX-ACC-001 --product fix-prod-001 >"$PR_OUT/eval-present.json" || return 1
  # The Sugar test mapping declares subscription.state explicitly unknown (M8,
  # no_reliable_source_state), so a present line is unknown, never owned; the
  # coverage check passes and the tier is carried into the result.
  [[ "$(pr_json '[o.coverageTier, o.checks.find((c) => c.check === "ownership_coverage").outcome, o.checks.find((c) => c.check === "not_already_owned").reason].join(":")' <"$PR_OUT/eval-present.json")" == "externally_grounded:pass:subscription_state_unknown" ]]
}
check "full sync records a count proof (externally grounded); eligibility carries the tier" pr_sync

pr_unreviewed() {
  kill -TERM "$PR_FAKE_PID" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$PR_FAKE_PID" 2>/dev/null || break; sleep 0.25; done
  PR_FAKE_STARTS=2
  pr_fake --variant unreviewed-stage || return 1
  pr_cli sources sync-full --tenant "$PR_TENANT" --connection sugar --execute >/dev/null || return 1
  [[ "$(pr_wait sync-status)" == "completed" ]] || return 1
  [[ "$(pr_json 'o.runs[0].quality.unreviewed_holding_value + ":" + o.runs[0].quality.tombstones_suppressed' <"$PR_OUT/sync-status.json")" == "2:1" ]] || return 1
  local tid; tid="$(pr_tid)"
  [[ "$(pr_sql "SELECT string_agg(source_record_id || '=' || record_state, ',' ORDER BY source_record_id) FROM tenant_subscriptions WHERE tenant_id = '$tid' AND source_record_id IN ('FIX-RLI-001', 'FIX-RLI-NEWSTAGE')")" == "FIX-RLI-001=active" ]] || return 1
  [[ "$(pr_sql "SELECT string_agg(source_record_id || '=' || reason, ',' ORDER BY source_record_id) FROM tenant_ownership_gaps WHERE tenant_id = '$tid' AND reason = 'holding_filter_value_unreviewed'")" == "FIX-RLI-001=holding_filter_value_unreviewed,FIX-RLI-NEWSTAGE=holding_filter_value_unreviewed" ]] || return 1
  pr_cli products evaluate --tenant "$PR_TENANT" --company sugar:Accounts:FIX-ACC-001 --product fix-prod-001 >"$PR_OUT/eval-unknown.json" || return 1
  [[ "$(pr_json 'o.ownership + ":" + o.checks.find((c) => c.check === "ownership_coverage").reason' <"$PR_OUT/eval-unknown.json")" == "unknown:ownership_incomplete" ]]
}
check "an unreviewed holding value keeps its line (no tombstone), adds gaps and makes the account unknown" pr_unreviewed

pr_notin() {
  pr_cli sources mappings-publish --tenant "$PR_TENANT" --connection sugar --file "$PR_OUT/mapping-notin.json" --ack "$PR_ACK" \
    --based-on 2 --actor runtime --execute >"$PR_OUT/map-v3.json" || return 1
  [[ "$(pr_json 'o.published.version' <"$PR_OUT/map-v3.json")" == "3" ]] || return 1
  pr_cli sources sync-full --tenant "$PR_TENANT" --connection sugar --execute >/dev/null || return 1
  [[ "$(pr_wait sync-status)" == "completed" ]] || return 1
  local tid; tid="$(pr_tid)"
  [[ "$(pr_sql "SELECT count(*) FROM tenant_subscriptions WHERE tenant_id = '$tid' AND source_record_id = 'FIX-RLI-NEWSTAGE'")" == "0" ]]
}
check "not_in: an unreviewed value never becomes a holding" pr_notin

pr_purge() {
  local code=0
  pr_cli sources profile-purge --tenant "$PR_TENANT" --connection sugar --object Accounts --keep 10 --execute >"$PR_OUT/purge-app.json" || code=$?
  [[ $code -eq 2 ]] && [[ "$(pr_json 'o.code' <"$PR_OUT/purge-app.json")" == "purge_requires_owner_credentials" ]] || return 1
  code=0
  (cd "$API_DIR" && env "${PR_ENV[@]}" MIGRATION_DATABASE_URL="$APP_DB_URL" node dist/cli/sources.js profile-purge --tenant "$PR_TENANT" --connection sugar --object Accounts --keep 10 --execute) >"$PR_OUT/purge-approle.json" || code=$?
  [[ $code -eq 2 ]] && [[ "$(pr_json 'o.code' <"$PR_OUT/purge-approle.json")" == "purge_requires_owner_credentials" ]] || return 1
  (cd "$API_DIR" && env "${PR_ENV[@]}" MIGRATION_DATABASE_URL="$OWNER_DB_URL" node dist/cli/sources.js profile-purge --tenant "$PR_TENANT" --connection sugar --object Accounts --keep 10) >"$PR_OUT/purge-dry.json" || return 1
  [[ "$(pr_json 'o.purge.dryRun + ":" + o.purge.deletedProfiles' <"$PR_OUT/purge-dry.json")" == "true:0" ]] &&
    ! grep -q 'postgresql://' "$PR_OUT"/purge-*.json
}
check "profile-purge refuses the app role; with owner credentials a dry run deletes nothing; no URL printed" pr_purge

pr_rls() {
  [[ "$(compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -Atc 'SELECT (SELECT count(*) FROM tenant_source_profile_runs) + (SELECT count(*) FROM tenant_source_profiles) + (SELECT count(*) FROM tenant_source_profile_findings) + (SELECT count(*) FROM tenant_source_profile_purges)')" == "0" ]]
}
check "app role with no tenant sees no profile rows (RLS)" pr_rls

# M9A closure fix: source field NAMES carrying sensitive content (a Luhn-valid
# test card, a phone number, a test IBAN, a UUID, an excluded card field) never
# reach CLI output, the worker log or the M9A tables. A second fake Sugar
# declares them; the M8 schema snapshot holding them proves they really arrived.
PN_TENANT="rtprofnames"
PN_FAKE_PORT="$(free_port)"
PN_FAKE_LOG="$WORK/fake-sugar-names.log"
PN_CORES='4111111111111111\|447700900123\|GB82WEST12345698765432\|gb82west12345698765432\|123e4567\|5555555555554444'
pr_names() {
  (cd "$API_DIR" && exec node --no-warnings test/support/fake-sugar.ts --port "$PN_FAKE_PORT" --variant sensitive-names >>"$PN_FAKE_LOG" 2>&1) &
  PN_FAKE_PID=$!
  local up=""
  for _ in $(seq 1 40); do grep -q 'listening' "$PN_FAKE_LOG" 2>/dev/null && up=1 && break; sleep 0.25; done
  [[ -n "$up" ]] || return 1
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug "$PN_TENANT" --name 'Runtime Profile Names' >/dev/null) || return 1
  node -e 'process.stdout.write(JSON.stringify({ instanceUrl: process.argv[1], apiVersion: "v11_20", modules: ["RevenueLineItems"], maxRetries: 2, sync: { overlapMinutes: 10 }, profile: { maxRows: 1000 } }));' \
    "http://127.0.0.1:$PN_FAKE_PORT" >"$PR_OUT/names-connection.json"
  local pn=(--tenant "$PN_TENANT" --connection sugar)
  pr_cli sources configure --tenant "$PN_TENANT" --kind sugar --label 'Sugar names (fake)' --file "$PR_OUT/names-connection.json" \
    --credential sugar_api --status enabled --execute >/dev/null || return 1
  pr_cli sources schema "${pn[@]}" --capture --execute >/dev/null || return 1
  local tid; tid="$(pr_sql "SELECT id FROM tenants WHERE slug = '$PN_TENANT'")"
  # The adversarial names arrived (M8 snapshot stores declared names by design).
  [[ "$(pr_sql "SELECT count(*) FROM tenant_source_schema_snapshots WHERE tenant_id = '$tid' AND document::text LIKE '%acct_4111111111111111%'")" == "1" ]] || return 1
  pr_cli sources profile-run "${pn[@]}" --objects RevenueLineItems --sampling full --execute >"$PR_OUT/names-run.json" || return 1
  local status=""
  for _ in $(seq 1 120); do
    pr_cli sources profile-status "${pn[@]}" >"$PR_OUT/names-status.json" 2>/dev/null || true
    status="$(pr_json 'o.runs[0] ? o.runs[0].status : ""' <"$PR_OUT/names-status.json" 2>/dev/null || true)"
    [[ "$status" == "completed" || "$status" == "failed" ]] && break
    sleep 0.5
  done
  [[ "$status" == "completed" ]] || return 1
  pr_cli sources profile-show "${pn[@]}" --object RevenueLineItems >"$PR_OUT/names-show.json" || return 1
  pr_cli sources profile-findings "${pn[@]}" --object RevenueLineItems >"$PR_OUT/names-findings.json" || return 1
  pr_cli sources mappings-draft "${pn[@]}" --from-profile --out "$PR_OUT/names-draft.json" >"$PR_OUT/names-draft-cli.json" || return 1
  # Tokens are what the operator sees.
  [[ "$(pr_json 'o.document.fields.filter((f) => f.nameRedacted).length' <"$PR_OUT/names-show.json")" == "3" ]] || return 1
  ! grep -q "$PN_CORES" "$PR_OUT"/names-*.json &&
    ! grep -q "$PN_CORES" "$PR_WORKER_LOG" &&
    [[ "$(pr_sql "SELECT count(*) FROM tenant_source_profile_runs r LEFT JOIN tenant_source_profiles p ON p.tenant_id = r.tenant_id AND p.run_id = r.id LEFT JOIN tenant_source_profile_findings f ON f.tenant_id = p.tenant_id AND f.profile_id = p.id WHERE r.tenant_id = '$tid' AND lower(concat(r.request::text, r.sampling::text, p.document::text, f.field, f.evidence::text)) ~ '4111111111111111|447700900123|gb82west12345698765432|123e4567|5555555555554444'")" == "0" ]]
}
check "sensitive source field NAMES never reach profile CLI output, the worker log or the M9A tables (tokens shown)" pr_names
kill -TERM "${PN_FAKE_PID:-0}" 2>/dev/null || true

pr_no_values() {
  local tid; tid="$(pr_tid)"
  ! grep -rq 'Fixture Account\|Fixture Line\|fixture-only-password\|fake-access-' "$PR_OUT" &&
    ! grep -q 'Fixture Account\|Fixture Line\|fixture-only-password\|fake-access-' "$PR_WORKER_LOG" &&
    [[ "$(pr_sql "SELECT count(*) FROM tenant_source_profiles WHERE tenant_id = '$tid' AND (document::text LIKE '%Fixture Account%' OR document::text LIKE '%Fixture Line%')")" == "0" ]]
}
check "CLI output, worker log and profile documents carry no record values or credentials" pr_no_values

kill -TERM "$PR_WORKER_PID" 2>/dev/null || true
for _ in $(seq 1 40); do kill -0 "$PR_WORKER_PID" 2>/dev/null || break; sleep 0.25; done
check "profiling worker exits on SIGTERM" bash -c "! kill -0 $PR_WORKER_PID 2>/dev/null"
kill -TERM "$PR_FAKE_PID" 2>/dev/null || true
