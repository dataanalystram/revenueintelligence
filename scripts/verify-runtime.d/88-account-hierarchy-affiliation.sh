# shellcheck shell=bash
# Milestone 10C (plan §19 V22): account hierarchy and Person–Account
# affiliation through the real CLI processes against the real database (app
# role, forced RLS). Proves: a new tenant is at canonical 0.3; the adoption dry
# run lists the M10C features and a rollback to 0.2 refuses operator entry
# (canonical_version_too_low) until 0.3 is adopted again; operator set / show /
# release / clear of a parent (one audit event each, a cycle refused with exit
# 2 and nothing changed, value history written); affiliation add / list (derived
# primary) / end; integrity runs the six M10C checks with zero findings; the app
# role cannot delete an affiliation, write the views or self-parent an account;
# no person name or email reaches a log, a CLI output, the audit details, the
# change records or the value history.

AS_TENANT="rtstructure"
AS_OUT="$WORK/account-structure"
mkdir -p "$AS_OUT"
AS_ENV=(DATABASE_URL="$APP_DB_URL" MIGRATION_DATABASE_URL="$OWNER_DB_URL")
AS_ACTOR="runtime-structure"
AS_EMAIL="structure.probe@school.example"
AS_NAME="Probestructure"
AS_C1="8c100000-0000-48c1-88c1-000000000001"
AS_C2="8c100000-0000-48c1-88c1-000000000002"
AS_C3="8c100000-0000-48c1-88c1-000000000003"
AS_P1="8c100000-0000-48c1-88c1-0000000000a1"
# Every CLI's stderr is kept (review n4): the privacy check scans it with the outputs and logs.
: >"$AS_OUT/cli.stderr"
as_cli() { (cd "$API_DIR" && env "${AS_ENV[@]}" node "dist/cli/$1.js" "${@:2}" 2>>"$AS_OUT/cli.stderr"); }
as_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
as_tid() { as_sql "SELECT id FROM tenants WHERE slug = '$AS_TENANT'"; }
as_count() { as_sql "SELECT count(*) FROM $1 WHERE tenant_id = '$(as_tid)'${2:+ AND $2}"; }
# Evaluates a JS expression over a CLI's JSON output (r = the parsed document).
as_json() { node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(eval(process.argv[2])));' "$1" "$2"; }
as_parent() { as_sql "SELECT coalesce(parent_company_id::text, '-') || '|' || coalesce(parent_company_origin, '-') FROM companies WHERE id = '$1'"; }
as_hierarchy() { as_cli account hierarchy "$1" --tenant "$AS_TENANT" --actor "$AS_ACTOR" "${@:2}"; }
as_affiliation() { as_cli account affiliation "$1" --tenant "$AS_TENANT" --actor "$AS_ACTOR" "${@:2}"; }
# One statement as the application login with the tenant bound; succeeds only when it is refused with $2 in the error.
as_app_refused() {
  local tid
  tid="$(as_tid)"
  ! compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -v ON_ERROR_STOP=1 -Atc \
    "BEGIN; SELECT set_config('app.current_tenant', '$tid', true); $1; ROLLBACK;" >/dev/null 2>"$AS_OUT/app-refused.err" &&
    grep -Eq "$2" "$AS_OUT/app-refused.err"
}

as_setup() {
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug "$AS_TENANT" --name 'Runtime Structure' >/dev/null) || return 1
  local tid
  tid="$(as_tid)"
  # Synthetic accounts and a person (test data written by the owner; the CLIs below are the subject).
  as_sql "INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES
            ('$AS_C1', '$tid', 'Runtime Trust', now(), now()),
            ('$AS_C2', '$tid', 'Runtime School', now(), now()),
            ('$AS_C3', '$tid', 'Runtime Campus', now(), now());
          INSERT INTO persons (id, tenant_id, primary_email, first_name, company_id, created_at, updated_at)
            VALUES ('$AS_P1', '$tid', '$AS_EMAIL', '$AS_NAME', '$AS_C1', now(), now());" >/dev/null || return 1
  # M10D / M10E / M10F: a new tenant adopts 0.6; this script exercises the 0.3 boundary from 0.3.
  [ "$(as_sql "SELECT version || ':' || reason FROM tenant_canonical_adoptions WHERE tenant_id = '$tid' ORDER BY seq")" = "0.6:new_tenant" ] || return 1
  as_cli canonical adopt --tenant "$AS_TENANT" --version 0.5 --expected-current 0.6 --actor "$AS_ACTOR" --execute >"$AS_OUT/adopt-05-from-06.json" || return 1
  as_cli canonical adopt --tenant "$AS_TENANT" --version 0.4 --expected-current 0.5 --actor "$AS_ACTOR" --execute >"$AS_OUT/adopt-04-from-05.json" || return 1
  as_cli canonical adopt --tenant "$AS_TENANT" --version 0.3 --expected-current 0.4 --actor "$AS_ACTOR" --execute >"$AS_OUT/adopt-03-from-04.json"
}
check "a new tenant is at canonical 0.6 (new_tenant), rolled back to 0.3 for the M10C boundary" as_setup

as_adoption() {
  as_cli canonical adopt --tenant "$AS_TENANT" --version 0.2 --expected-current 0.3 >"$AS_OUT/adopt-02-dry.json" || return 1
  grep -q '"dryRun": true' "$AS_OUT/adopt-02-dry.json" && grep -q 'account_hierarchy' "$AS_OUT/adopt-02-dry.json" &&
    grep -q 'person_affiliations' "$AS_OUT/adopt-02-dry.json" || return 1
  [ "$(as_count tenant_canonical_adoptions)" = 4 ] || return 1
  as_cli canonical adopt --tenant "$AS_TENANT" --version 0.2 --expected-current 0.3 --actor "$AS_ACTOR" --execute >"$AS_OUT/adopt-02.json" || return 1
  # Below 0.3 operator entry is refused (exit 2), audited as failed, nothing written.
  local code=0
  as_hierarchy set --company "$AS_C2" --parent "$AS_C1" --reason runtime_check >"$AS_OUT/set-02.json" || code=$?
  [ "$code" -eq 2 ] && [ "$(as_json "$AS_OUT/set-02.json" 'r.code')" = canonical_version_too_low ] || return 1
  [ "$(as_parent "$AS_C2")" = "-|-" ] || return 1
  [ "$(as_count tenant_audit_events "action = 'account.hierarchy.set' AND outcome = 'failed' AND reason_code = 'canonical_version_too_low'")" = 1 ] || return 1
  as_cli canonical adopt --tenant "$AS_TENANT" --version 0.3 --expected-current 0.2 >"$AS_OUT/adopt-03-dry.json" || return 1
  grep -q 'hierarchy_operator_entry' "$AS_OUT/adopt-03-dry.json" || return 1
  as_cli canonical adopt --tenant "$AS_TENANT" --version 0.3 --expected-current 0.2 --actor "$AS_ACTOR" --execute >"$AS_OUT/adopt-03.json" || return 1
  [ "$(as_sql "SELECT string_agg(version || ':' || reason, ',' ORDER BY seq) FROM tenant_canonical_adoptions WHERE tenant_id = '$(as_tid)'")" = \
    "0.6:new_tenant,0.5:rollback,0.4:rollback,0.3:rollback,0.2:rollback,0.3:operator_adoption" ]
}
check "adoption 0.3 → 0.2 → 0.3: dry runs list the M10C features; at 0.2 operator entry is refused (exit 2, audited)" as_adoption

as_operator_hierarchy() {
  local before code=0
  before="$(as_count tenant_audit_events "action LIKE 'account.hierarchy.%' AND outcome = 'allowed'")"
  as_hierarchy set --company "$AS_C2" --parent "$AS_C1" --reason runtime_check >"$AS_OUT/set-c2.json" || return 1
  as_hierarchy set --company "$AS_C3" --parent "$AS_C2" --reason runtime_check >"$AS_OUT/set-c3.json" || return 1
  [ "$(as_parent "$AS_C2")" = "$AS_C1|human" ] && [ "$(as_parent "$AS_C3")" = "$AS_C2|human" ] || return 1
  as_hierarchy show --company "$AS_C3" >"$AS_OUT/show-c3.json" || return 1
  [ "$(as_json "$AS_OUT/show-c3.json" 'r.hierarchy.depth + "|" + r.hierarchy.rootId + "|" + r.hierarchy.ancestors.join(",")')" = \
    "2|$AS_C1|$AS_C3,$AS_C2,$AS_C1" ] || return 1
  as_hierarchy show --company "$AS_C1" --descendants >"$AS_OUT/show-c1.json" || return 1
  [ "$(as_json "$AS_OUT/show-c1.json" 'r.hierarchy.descendants.length')" = 2 ] || return 1
  # A cycle is refused (exit 2) and changes nothing.
  as_hierarchy set --company "$AS_C1" --parent "$AS_C3" --reason runtime_check >"$AS_OUT/set-cycle.json" || code=$?
  [ "$code" -eq 2 ] && [ "$(as_json "$AS_OUT/set-cycle.json" 'r.code')" = hierarchy_cycle ] || return 1
  [ "$(as_parent "$AS_C1")" = "-|-" ] || return 1
  as_hierarchy release --company "$AS_C2" --reason runtime_check >"$AS_OUT/release-c2.json" || return 1
  [ "$(as_parent "$AS_C2")" = "$AS_C1|source_provided" ] || return 1
  as_hierarchy clear --company "$AS_C3" --reason runtime_check >"$AS_OUT/clear-c3.json" || return 1
  [ "$(as_parent "$AS_C3")" = "-|human" ] || return 1
  # One allowed event per operator write; two audited reads; full value history for the parent.
  [ "$(as_count tenant_audit_events "action LIKE 'account.hierarchy.%' AND outcome = 'allowed'")" = "$((before + 4))" ] || return 1
  [ "$(as_count tenant_audit_events "action = 'account_structure.read' AND outcome = 'allowed'")" = 2 ] || return 1
  [ "$(as_count tenant_value_history "entity_kind = 'company' AND field = 'parent_company_id' AND values_recorded")" = 3 ]
}
check "operator set / show / release / clear: origin human until released, a cycle refused (exit 2), one audit event each, value history" as_operator_hierarchy

as_operator_affiliation() {
  local c2_id
  as_affiliation add --person "$AS_P1" --company "$AS_C1" --roles champion --starts-at 2026-01-01 --reason runtime_check >"$AS_OUT/aff-add-1.json" || return 1
  as_affiliation add --person "$AS_P1" --company "$AS_C2" --reason runtime_check >"$AS_OUT/aff-add-2.json" || return 1
  c2_id="$(as_json "$AS_OUT/aff-add-2.json" 'r.affiliation.affiliationId')"
  as_cli account affiliations --tenant "$AS_TENANT" --person "$AS_P1" --actor "$AS_ACTOR" >"$AS_OUT/aff-list.json" || return 1
  [ "$(as_json "$AS_OUT/aff-list.json" 'r.affiliations.map((a) => a.companyId + ":" + a.status + ":" + a.isPrimary + ":" + a.origin).sort().join(",")')" = \
    "$(printf '%s\n' "$AS_C1:active:true:human" "$AS_C2:active:false:human" | sort | paste -sd, -)" ] || return 1
  as_affiliation end --affiliation "$c2_id" --reason runtime_check >"$AS_OUT/aff-end.json" || return 1
  as_cli account affiliations --tenant "$AS_TENANT" --company "$AS_C2" --active --actor "$AS_ACTOR" >"$AS_OUT/aff-list-c2.json" || return 1
  [ "$(as_json "$AS_OUT/aff-list-c2.json" 'r.affiliations.length')" = 0 ] || return 1
  [ "$(as_count tenant_person_affiliations "status = 'ended' AND end_reason = 'operator'")" = 1 ] || return 1
  # The operator ending is sticky until released (review M6); release hands the pair back.
  as_affiliation release --person "$AS_P1" --company "$AS_C2" --reason runtime_check >"$AS_OUT/aff-release.json" || return 1
  [ "$(as_count tenant_person_affiliations "end_reason = 'operator' AND released_at IS NOT NULL")" = 1 ] || return 1
  [ "$(as_count tenant_audit_events "action LIKE 'person.affiliation.%' AND outcome = 'allowed'")" = 4 ] || return 1
  # Affiliation history is value-free (personal fields).
  [ "$(as_count tenant_value_history "entity_kind = 'person_affiliation' AND values_recorded")" = 0 ] &&
    [ "$(as_count tenant_value_history "entity_kind = 'person_affiliation'")" -gt 0 ]
}
check "affiliation add / list (derived primary) / end / release: one audit event each, value-free history" as_operator_affiliation

as_integrity() {
  local checks c
  as_cli security integrity-verify --tenant "$AS_TENANT" --actor "$AS_ACTOR" --execute >"$AS_OUT/integrity.json" || return 1
  grep -q '"outcome": "passed"' "$AS_OUT/integrity.json" || return 1
  checks="$(as_sql "SELECT checks::text FROM tenant_integrity_runs WHERE tenant_id = '$(as_tid)' ORDER BY started_at DESC LIMIT 1")" || return 1
  for c in hierarchy_cycle hierarchy_depth_exceeded hierarchy_parent_merged hierarchy_history_parity \
    affiliation_endpoint_merged affiliation_reference_parity; do
    printf '%s' "$checks" | grep -q "$c" || {
      echo "    integrity run lacks check $c" >&2
      return 1
    }
  done
  [ "$(as_sql "SELECT jsonb_array_length(findings) FROM tenant_integrity_runs WHERE tenant_id = '$(as_tid)' ORDER BY started_at DESC LIMIT 1")" = 0 ]
}
check "integrity verification runs the six M10C checks with zero findings" as_integrity

as_app_role() {
  as_app_refused "DELETE FROM tenant_person_affiliations" 'permission denied' || return 1
  as_app_refused "INSERT INTO person_affiliation_index (tenant_id) VALUES ('$(as_tid)')" 'permission denied|cannot insert into view' || return 1
  as_app_refused "INSERT INTO account_hierarchy_paths (tenant_id) VALUES ('$(as_tid)')" 'permission denied|cannot insert into view' || return 1
  as_app_refused "UPDATE companies SET parent_company_id = id WHERE id = '$AS_C1'" 'companies_parent_not_self' || return 1
  as_app_refused "UPDATE companies SET parent_company_id = '$AS_C3' WHERE id = '$AS_C1'; UPDATE companies SET parent_company_id = '$AS_C1' WHERE id = '$AS_C3'" 'hierarchy_cycle'
}
check "the app role cannot delete an affiliation, write the views, self-parent or close a cycle" as_app_role

as_no_values() {
  local logs=("$WORK/api.log" "$WORK/worker.log") log rc=0
  for log in "${logs[@]}"; do
    [ -f "$log" ] || {
      echo "    log file missing: $log" >&2
      return 1
    }
  done
  # The probe name and email are written by SQL and read back by the CLIs (person:affiliations,
  # integrity); they never pass the API or the worker here, so the api / worker logs are a
  # weak witness. The CLI outputs and stderr are the real one; the writer-level proof that
  # nothing personal reaches logs, issues or history is V13 (person-affiliations.int).
  grep -qF -e "$AS_EMAIL" -e "$AS_NAME" "${logs[@]}" "$AS_OUT"/*.json "$AS_OUT/cli.stderr" || rc=$?
  [ "$rc" -eq 1 ] || return 1
  [ "$(as_count tenant_audit_events "details::text LIKE '%probe%' OR details::text LIKE '%Probe%'")" = 0 ] || return 1
  [ "$(as_sql "SELECT count(*) FROM tenant_context_changes c WHERE tenant_id = '$(as_tid)' AND row_to_json(c)::text ILIKE '%probe%'")" = 0 ] || return 1
  [ "$(as_sql "SELECT count(*) FROM tenant_value_history h WHERE tenant_id = '$(as_tid)' AND row_to_json(h)::text ILIKE '%probe%'")" = 0 ]
}
check "no person name or email in the logs, CLI outputs, audit details, change records or value history" as_no_values
