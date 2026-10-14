# shellcheck shell=bash
# Milestone 10A2: canonical versioning and governance through the real CLI
# processes against the real database (app role, forced RLS). Proves: a new
# tenant adopts the current canonical version (new_tenant); an adoption to an
# unknown version is refused by the dry run and writes nothing; module and
# registry dry runs write nothing; a data policy publishes only with the hash
# its dry run printed, and the audit-purge report then reads its
# security_audit retention from that policy (script 85 keeps the 365-day
# default on its own tenant); purge execution stays refused; integrity
# verification passes on a clean tenant, records its run only with
# --execute, and the app role cannot write the entity index, the adoption
# chain or the mapping lifecycle.

CG_TENANT="rtcanonical"
CG_OUT="$WORK/canonical-governance"
CG_IN="$WORK/canonical-governance-input"
mkdir -p "$CG_OUT" "$CG_IN"
CG_ENV=(DATABASE_URL="$APP_DB_URL" MIGRATION_DATABASE_URL="$OWNER_DB_URL")
cg_cli() { (cd "$API_DIR" && env "${CG_ENV[@]}" node "dist/cli/$1.js" "${@:2}"); }
cg_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
cg_tid() { cg_sql "SELECT id FROM tenants WHERE slug = '$CG_TENANT'"; }
cg_count() { cg_sql "SELECT count(*) FROM $1 WHERE tenant_id = '$(cg_tid)'"; }
cg_events() {
  cg_sql "SELECT e.action || '|' || e.outcome || '|' || coalesce(e.reason_code, '-') || '|' || e.actor_kind || '|' || e.actor_id
            FROM tenant_audit_events e JOIN tenants t ON t.id = e.tenant_id WHERE t.slug = '$CG_TENANT' ORDER BY e.seq"
}
# Runs one statement as the application login (lip_api, member of lip_app) with the tenant bound; succeeds only when it is refused.
cg_app_refused() {
  local tid
  tid="$(cg_tid)"
  ! compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -v ON_ERROR_STOP=1 -Atc \
    "BEGIN; SELECT set_config('app.current_tenant', '$tid', true); $1; ROLLBACK;" >/dev/null 2>"$CG_OUT/app-refused.err" &&
    grep -q 'permission denied' "$CG_OUT/app-refused.err"
}

cg_setup() {
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug "$CG_TENANT" --name 'Runtime Canonical' >/dev/null) || return 1
  cg_cli canonical history --tenant "$CG_TENANT" >"$CG_OUT/history.json" || return 1
  grep -q '"version": "0.2"' "$CG_OUT/history.json" && grep -q '"reason": "new_tenant"' "$CG_OUT/history.json" || return 1
  [ "$(cg_count tenant_canonical_adoptions)" = 1 ]
}
check "a new tenant adopts the current canonical version (new_tenant), in the provisioning transaction" cg_setup

cg_adopt_refused() {
  local code=0
  cg_cli canonical adopt --tenant "$CG_TENANT" --version 9.9 --expected-current 0.2 >"$CG_OUT/adopt.json" || code=$?
  [ "$code" -eq 2 ] && grep -q '"dryRun": true' "$CG_OUT/adopt.json" && grep -q '"decision": "refused"' "$CG_OUT/adopt.json" || return 1
  [ "$(cg_count tenant_canonical_adoptions)" = 1 ]
}
check "adoption of an unknown version: dry run refused (exit 2), nothing written" cg_adopt_refused

cg_dry_runs() {
  local before
  before="$(cg_count tenant_audit_events)"
  cg_cli canonical modules --tenant "$CG_TENANT" >"$CG_OUT/modules.json" || return 1
  grep -q '"modules"' "$CG_OUT/modules.json" || return 1
  cg_cli canonical registry-show --tenant "$CG_TENANT" --kind data_policy >"$CG_OUT/policy-show.json" || return 1
  grep -q '"latest": null' "$CG_OUT/policy-show.json" || return 1
  node -e 'process.stdout.write(JSON.stringify({ schema: 1, raw_retention: false, retention: { security_audit: { days: 400 } } }))' >"$CG_IN/policy.json"
  cg_cli canonical registry-publish --tenant "$CG_TENANT" --kind data_policy --file "$CG_IN/policy.json" >"$CG_OUT/policy-dry.json" || return 1
  grep -q '"dryRun": true' "$CG_OUT/policy-dry.json" || return 1
  [ "$(cg_count tenant_registry_versions)" = 0 ] && [ "$(cg_count tenant_audit_events)" = "$before" ]
}
check "modules, registry-show and a data-policy dry run write nothing" cg_dry_runs

cg_module_refused() {
  local code=0
  cg_cli canonical module --tenant "$CG_TENANT" --module signals --enable --expected-version 0 \
    --actor runtime-canon --execute >"$CG_OUT/module.json" 2>"$CG_OUT/module.err" || code=$?
  [ "$code" -ne 0 ] && grep -q 'module_not_available' "$CG_OUT/module.json" "$CG_OUT/module.err" || return 1
  [ "$(cg_count tenant_module_setting_events)" = 0 ] || return 1
  ! cg_events | grep -q '^module.enable|allowed|'
}
check "enabling an unavailable module (Q16) is refused (module_not_available); nothing written" cg_module_refused

cg_policy() {
  local hash code=0
  hash="$(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(r.contentHash)' "$CG_OUT/policy-dry.json")" || return 1
  [ -n "$hash" ] || return 1
  # A wrong expected hash is refused and publishes nothing.
  cg_cli canonical registry-publish --tenant "$CG_TENANT" --kind data_policy --file "$CG_IN/policy.json" \
    --based-on 0 --expected-hash "$(printf '0%.0s' $(seq 64))" --actor runtime-canon --execute >"$CG_OUT/policy-bad.json" 2>"$CG_OUT/policy-bad.err" || code=$?
  [ "$code" -ne 0 ] && [ "$(cg_count tenant_registry_versions)" = 0 ] || return 1
  cg_cli canonical registry-publish --tenant "$CG_TENANT" --kind data_policy --file "$CG_IN/policy.json" \
    --based-on 0 --expected-hash "$hash" --actor runtime-canon --execute >"$CG_OUT/policy-pub.json" || return 1
  [ "$(cg_count tenant_registry_versions)" = 1 ] || return 1
  cg_events | grep -q '^data_policy.publish|allowed|-|operator|runtime-canon$'
}
check "data policy publishes only with the dry run's hash; one allowed audit event" cg_policy

cg_purge() {
  local code=0
  cg_cli security audit-purge --tenant "$CG_TENANT" >"$CG_OUT/purge-report.json" || return 1
  grep -q '"dryRun": true' "$CG_OUT/purge-report.json" && grep -q '"retentionDays": 400' "$CG_OUT/purge-report.json" &&
    grep -q '"retentionSource": "policy"' "$CG_OUT/purge-report.json" || return 1
  cg_cli security audit-purge --tenant "$CG_TENANT" --actor runtime-canon --execute >"$CG_OUT/purge.json" 2>"$CG_OUT/purge.err" || code=$?
  [ "$code" -ne 0 ] && cg_events | grep -q '^security.audit.purge|denied|audit_purge_disabled|operator|runtime-canon$'
}
check "audit-purge report reads the published security_audit retention (400 days); execution stays refused" cg_purge

cg_integrity() {
  local before
  cg_cli security integrity-verify --tenant "$CG_TENANT" >"$CG_OUT/integrity.json" || return 1
  grep -q '"outcome": "passed"' "$CG_OUT/integrity.json" || return 1
  [ "$(cg_count tenant_integrity_runs)" = 0 ] || return 1
  before="$(cg_count tenant_audit_events)"
  cg_cli security integrity-verify --tenant "$CG_TENANT" --actor runtime-canon --execute >"$CG_OUT/integrity-run.json" || return 1
  grep -q '"outcome": "passed"' "$CG_OUT/integrity-run.json" && grep -q '"runId"' "$CG_OUT/integrity-run.json" || return 1
  [ "$(cg_count tenant_integrity_runs)" = 1 ] && [ "$(cg_count tenant_audit_events)" = "$((before + 1))" ] || return 1
  cg_events | grep -q '^integrity.verify|.*|operator|runtime-canon$'
}
check "integrity-verify passes on a clean tenant; --execute records one run and one audit event" cg_integrity

cg_app_role() {
  cg_app_refused "INSERT INTO tenant_entity_index (tenant_id, kind, entity_id) VALUES ('$(cg_tid)', 'company', gen_random_uuid())" || return 1
  cg_app_refused "UPDATE tenant_canonical_adoptions SET reason = 'x'" || return 1
  cg_app_refused "DELETE FROM tenant_canonical_adoptions" || return 1
  cg_app_refused "DELETE FROM tenant_source_mapping_lifecycle"
}
check "the app role cannot write the entity index, change the adoption chain or the mapping lifecycle" cg_app_role

# The mapping lifecycle through the real CLIs on the Sugar tenant of script 70
# (its fake is stopped; a refused sync never reaches the source).
CG_SOURCES="rtsources"
cg_published() {
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const p = r.states.filter((s) => s.state === "published");
    process.stdout.write(p.length === 1 ? String(p[0].version) : "")' "$1"
}
cg_retire() {
  local version code=0
  cg_cli sources mapping-states --tenant "$CG_SOURCES" --connection sugar >"$CG_OUT/states.json" || return 1
  version="$(cg_published "$CG_OUT/states.json")"
  [ -n "$version" ] || return 1
  CG_RETIRED="$version"
  cg_cli sources mapping-retire --tenant "$CG_SOURCES" --connection sugar --version "$version" --reason operator_retired >"$CG_OUT/retire-dry.json" || return 1
  grep -q '"dryRun": true' "$CG_OUT/retire-dry.json" || return 1
  cg_cli sources mapping-states --tenant "$CG_SOURCES" --connection sugar >"$CG_OUT/states-dry.json" || return 1
  [ "$(cg_published "$CG_OUT/states-dry.json")" = "$version" ] || return 1
  cg_cli sources mapping-retire --tenant "$CG_SOURCES" --connection sugar --version "$version" --reason operator_retired \
    --actor runtime-canon --execute >"$CG_OUT/retire.json" || return 1
  grep -q '"previousState": "published"' "$CG_OUT/retire.json" || return 1
  cg_cli sources mapping-states --tenant "$CG_SOURCES" --connection sugar >"$CG_OUT/states-after.json" || return 1
  [ -z "$(cg_published "$CG_OUT/states-after.json")" ] || return 1
  cg_cli sources sync-full --tenant "$CG_SOURCES" --connection sugar --actor runtime-canon --execute >"$CG_OUT/sync-refused.json" 2>"$CG_OUT/sync-refused.err" || code=$?
  [ "$code" -ne 0 ] && grep -q 'mapping_not_published\|No published mapping' "$CG_OUT/sync-refused.json" "$CG_OUT/sync-refused.err"
}
check "mapping retire (dry run writes nothing) → no published version → sync refused (mapping_not_published)" cg_retire

# Leaves script 70's Sugar connection as it found it: the retired document is
# published again as a new version (a retired version is never revived).
cg_republish() {
  [ -n "${CG_RETIRED:-}" ] && [ -n "${SC_ACK:-}" ] || return 1
  cg_cli sources mappings-publish --tenant "$CG_SOURCES" --connection sugar --file "$SC_OUT/mapping-full.json" --ack "$SC_ACK" \
    --based-on "$CG_RETIRED" --actor runtime-canon --execute >"$CG_OUT/republish.json" || return 1
  cg_cli sources mapping-states --tenant "$CG_SOURCES" --connection sugar >"$CG_OUT/states-republished.json" || return 1
  [ "$(cg_published "$CG_OUT/states-republished.json")" = "$((CG_RETIRED + 1))" ]
}
check "the retired Sugar mapping is published again as a new version (connection left published)" cg_republish

# V23: value history may record source values (script 70's sync); none may reach
# a process log or CLI output. The probe values are read from the history
# itself (free-text strings only, not enum codes, ids or timestamps) plus the
# fixture names script 70 already guards.
cg_no_values() {
  local tid values
  tid="$(cg_sql "SELECT id FROM tenants WHERE slug = '$CG_SOURCES'")" || return 1
  values="$(cg_sql "SELECT DISTINCT v #>> '{}' FROM tenant_value_history h, LATERAL (VALUES (h.old_value), (h.new_value)) AS x(v)
                     WHERE h.tenant_id = '$tid' AND h.values_recorded AND jsonb_typeof(v) = 'string'
                       AND length(v #>> '{}') >= 6 AND (v #>> '{}') ~ '[A-Z ]' AND (v #>> '{}') !~ '^[0-9:TZ.+-]+$'")" || return 1
  # Review n3: report what is searched, so an empty history is visible. Script
  # 70's sync is not expected to record free-text history values (it creates
  # rows; history records changes — observed zero in CI run 38569672529), so
  # zero free-text values is reported, not failed; the probe list always holds
  # the fixture names and must not be empty.
  local count=0 breakdown
  [ -n "$values" ] && count="$(printf '%s\n' "$values" | wc -l | tr -d ' ')"
  breakdown="$(cg_sql "SELECT entity_kind || '.' || field || ' values_recorded=' || values_recorded || ': ' || count(*)
                        FROM tenant_value_history WHERE tenant_id = '$tid'
                        GROUP BY entity_kind, field, values_recorded ORDER BY 1")" || return 1
  echo "    value-history rows: ${breakdown:-none}"
  echo "    value-history free-text values searched: $count (plus 2 fixture names)"
  printf '%s\n' 'Fixture Account' 'Fixture Line' >"$CG_OUT/value-probes.txt"
  [ "$count" -gt 0 ] && printf '%s\n' "$values" >>"$CG_OUT/value-probes.txt"
  if [ ! -s "$CG_OUT/value-probes.txt" ]; then
    echo "    no probe values: the log scan would prove nothing" >&2
    return 1
  fi
  # Every log searched must exist: grep on a missing file would pass silently.
  local logs=("$WORK/api.log" "$WORK/worker.log")
  [ -n "${SC_WORKER_LOG:-}" ] && logs+=("$SC_WORKER_LOG")
  local log
  for log in "${logs[@]}"; do
    if [ ! -f "$log" ]; then
      echo "    log file missing: $log" >&2
      return 1
    fi
  done
  # grep: 1 = no match (pass); 0 = a value leaked; 2 = an error (fail too).
  local rc=0
  grep -rqF -f "$CG_OUT/value-probes.txt" "${logs[@]}" --exclude=value-probes.txt "$CG_OUT" || rc=$?
  [ "$rc" -eq 1 ]
}
check "no value-history value (or fixture name) in the API, worker or CLI logs" cg_no_values
