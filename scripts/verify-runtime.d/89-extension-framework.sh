# shellcheck shell=bash
# Milestone 10D (plan §22 V25): the extension framework through the real CLI
# processes against the real database (app role, forced RLS). Every CLI prints
# JSON on stdout; the checks read it. Proves: a new tenant is at canonical 0.4
# with module `extension` disabled, so the registry dry run reports
# module_disabled (exit 2); enabling the module and publishing an extension
# registry with the dry-run hash; operator value set / show / release (one
# audit event each; a confidential value is not printed without
# --include-confidential); custom record create / list / show and a
# many_to_one relationship whose second edge ends the first; a capture draft
# from a real schema snapshot (sensitive field names refused, nothing
# published); integrity runs the eight M10D checks with zero findings; the app
# role cannot delete a value or break the typed CHECK; a rollback to 0.3 keeps
# reads and refuses writes (exit 2, audited) until 0.4 is adopted again; no
# extension value reaches a log, CLI output or stderr, the audit details or
# the change records.

EX_TENANT="rtextension"
EX_OUT="$WORK/extension"
EX_IN="$WORK/extension-input"
mkdir -p "$EX_OUT" "$EX_IN"
EX_ENV=(DATABASE_URL="$APP_DB_URL" MIGRATION_DATABASE_URL="$OWNER_DB_URL")
EX_ACTOR="runtime-extension"
# A confidential value that must never be printed or logged (checked at the end).
EX_PROBE="Probeconfidentialnote"
EX_C1="8d100000-0000-48d1-88d1-000000000001"
EX_C2="8d100000-0000-48d1-88d1-000000000002"
# Every CLI's stderr is kept: the privacy check scans it with the outputs and logs.
: >"$EX_OUT/cli.stderr"
ex_cli() { (cd "$API_DIR" && env "${EX_ENV[@]}" node "dist/cli/$1.js" "${@:2}" 2>>"$EX_OUT/cli.stderr"); }
ex_ext() { ex_cli extension "$@" --tenant "$EX_TENANT" --actor "$EX_ACTOR"; }
ex_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
ex_tid() { ex_sql "SELECT id FROM tenants WHERE slug = '$EX_TENANT'"; }
ex_count() { ex_sql "SELECT count(*) FROM $1 WHERE tenant_id = '$(ex_tid)'${2:+ AND $2}"; }
# Evaluates a JS expression over a CLI's JSON output (r = the parsed document).
ex_json() { node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(eval(process.argv[2])));' "$1" "$2"; }
# One statement as the application login with the tenant bound; succeeds only when it is refused with $2 in the error.
ex_app_refused() {
  local tid
  tid="$(ex_tid)"
  ! compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -v ON_ERROR_STOP=1 -Atc \
    "BEGIN; SELECT set_config('app.current_tenant', '$tid', true); $1; ROLLBACK;" >/dev/null 2>"$EX_OUT/app-refused.err" &&
    grep -Eq "$2" "$EX_OUT/app-refused.err"
}

ex_setup() {
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug "$EX_TENANT" --name 'Runtime Extension' >/dev/null) || return 1
  local tid
  tid="$(ex_tid)"
  # Synthetic accounts (test data written by the owner; the CLIs below are the subject).
  ex_sql "INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES
            ('$EX_C1', '$tid', 'Runtime Extension School', now(), now()),
            ('$EX_C2', '$tid', 'Runtime Extension Trust', now(), now());" >/dev/null || return 1
  [ "$(ex_sql "SELECT string_agg(version || ':' || reason, ',' ORDER BY seq) FROM tenant_canonical_adoptions WHERE tenant_id = '$tid'")" = "0.4:new_tenant" ] || return 1
  [ "$(ex_count tenant_module_settings "module_key = 'extension' AND enabled")" = 0 ]
}
check "a new tenant is at canonical 0.4 (new_tenant) with module extension disabled" ex_setup

ex_registry() {
  local code=0 hash
  node -e 'process.stdout.write(JSON.stringify({
    schema_version: 1,
    objects: [{ key: "site", display_name: "Site", description: "A school site", sensitivity: "internal",
                categories: ["operational"], parent: { kind: "account", required: false } }],
    fields: [
      { key: "tier", target: "account", display_name: "Tier", description: "Commercial tier", value_type: "enum",
        allowed_values: [{ code: "gold", label: "Gold" }, { code: "silver", label: "Silver" }],
        sensitivity: "internal", categories: ["commercial"] },
      { key: "note", target: "account", display_name: "Note", description: "Account note", value_type: "string",
        sensitivity: "confidential", categories: ["commercial"] },
      { key: "site_code", target: "custom_object:site", display_name: "Site code", description: "Site code",
        value_type: "string", sensitivity: "internal", categories: ["operational"] }
    ],
    relationships: [{ key: "site_account", display_name: "Site account", description: "The site account",
                      from: "custom_object:site", to: "account", cardinality: "many_to_one",
                      sensitivity: "internal", categories: ["operational"] }]
  }))' >"$EX_IN/registry.json"
  # Module disabled (Q18): the dry run says so and exits 2; nothing is written.
  ex_cli canonical registry-publish --tenant "$EX_TENANT" --kind extension --file "$EX_IN/registry.json" >"$EX_OUT/registry-dry-disabled.json" || code=$?
  [ "$code" -eq 2 ] && [ "$(ex_json "$EX_OUT/registry-dry-disabled.json" 'r.issues.join(",")')" = module_disabled ] || return 1
  ex_cli canonical module --tenant "$EX_TENANT" --module extension --enable --expected-version 0 \
    --actor "$EX_ACTOR" --execute >"$EX_OUT/module.json" || return 1
  ex_cli canonical registry-publish --tenant "$EX_TENANT" --kind extension --file "$EX_IN/registry.json" >"$EX_OUT/registry-dry.json" || return 1
  hash="$(ex_json "$EX_OUT/registry-dry.json" 'r.contentHash')"
  [ "${#hash}" -eq 64 ] && [ "$(ex_count tenant_registry_versions "kind = 'extension'")" = 0 ] || return 1
  ex_cli canonical registry-publish --tenant "$EX_TENANT" --kind extension --file "$EX_IN/registry.json" \
    --based-on 0 --expected-hash "$hash" --actor "$EX_ACTOR" --execute >"$EX_OUT/registry-pub.json" || return 1
  [ "$(ex_json "$EX_OUT/registry-pub.json" 'r.published.version + ":" + r.published.entries + ":" + r.published.canonicalVersionMin')" = "1:5:0.4" ] || return 1
  ex_ext registry show >"$EX_OUT/registry-show.json" || return 1
  [ "$(ex_json "$EX_OUT/registry-show.json" 'r.registry.entries.map((e) => e.key).sort().join(",")')" = "note,site,site_account,site_code,tier" ] || return 1
  [ "$(ex_count tenant_registry_entries "kind = 'extension' AND sensitivity IS NOT NULL")" = 5 ]
}
check "registry: dry run refused while the module is disabled (exit 2); module enabled; publish with the dry-run hash projects five classified entries" ex_registry

ex_values() {
  local before
  before="$(ex_count tenant_audit_events "action LIKE 'extension.value.%' AND outcome = 'allowed'")"
  ex_ext value set --target "account:$EX_C1" --field tier --value gold --reason runtime_check >"$EX_OUT/set-tier.json" || return 1
  ex_ext value set --target "account:$EX_C1" --field note --value "$EX_PROBE" --reason runtime_check >"$EX_OUT/set-note.json" || return 1
  [ "$(ex_json "$EX_OUT/set-tier.json" 'r.value.state + ":" + r.value.changed')" = "present:true" ] || return 1
  ex_ext values show --target "account:$EX_C1" >"$EX_OUT/values-show.json" || return 1
  # Internal values are printed; the confidential one is not (no --include-confidential).
  [ "$(ex_json "$EX_OUT/values-show.json" 'r.values.map((v) => v.field + ":" + v.shown + ":" + (v.value ?? "-")).sort().join(",")')" = \
    "note:false:-,tier:true:gold" ] || return 1
  ex_ext value release --target "account:$EX_C1" --field tier --reason runtime_check >"$EX_OUT/release-tier.json" || return 1
  [ "$(ex_json "$EX_OUT/release-tier.json" 'r.value.state')" = released ] || return 1
  [ "$(ex_count tenant_extension_values "origin = 'human' AND released_at IS NOT NULL")" = 1 ] || return 1
  # One allowed audit event per operator write; one audited read; change records carry ext: tokens only.
  [ "$(ex_count tenant_audit_events "action LIKE 'extension.value.%' AND outcome = 'allowed'")" = "$((before + 3))" ] || return 1
  [ "$(ex_count tenant_audit_events "action = 'extension.read' AND outcome = 'allowed'")" = 1 ] || return 1
  [ "$(ex_count tenant_context_changes "'ext:tier' = ANY(changed_fields)")" -ge 1 ]
}
check "operator value set / show / release: one audit event each, a confidential value not printed without the flag" ex_values

ex_records() {
  local record
  ex_ext record create --object site --parent "account:$EX_C1" --set site_code=north --reason runtime_check >"$EX_OUT/record-create.json" || return 1
  record="$(ex_json "$EX_OUT/record-create.json" 'r.record.recordId')"
  ex_ext records list --object site >"$EX_OUT/records-list.json" || return 1
  [ "$(ex_json "$EX_OUT/records-list.json" 'r.records.map((x) => x.id).join(",")')" = "$record" ] || return 1
  ex_ext records show --record "$record" >"$EX_OUT/records-show.json" || return 1
  [ "$(ex_json "$EX_OUT/records-show.json" 'r.record.values.map((v) => v.field + ":" + v.value).join(",")')" = "site_code:north" ] || return 1
  [ "$(ex_count tenant_entity_index "kind = 'custom_record' AND entity_id = '$record'")" = 1 ] || return 1
  # many_to_one: the operator's second edge from the same record ends the first.
  ex_ext relationship add --relationship site_account --from "custom_record:$record" --to "account:$EX_C1" --reason runtime_check >"$EX_OUT/edge-1.json" || return 1
  ex_ext relationship add --relationship site_account --from "custom_record:$record" --to "account:$EX_C2" --reason runtime_check >"$EX_OUT/edge-2.json" || return 1
  [ "$(ex_count tenant_custom_relationships "state = 'active' AND to_id = '$EX_C2'")" = 1 ] &&
    [ "$(ex_count tenant_custom_relationships "state = 'ended' AND end_reason = 'operator' AND to_id = '$EX_C1'")" = 1 ]
}
check "record create / list / show; a many_to_one edge replaced by the operator's second edge (first ended)" ex_records

# On failure the draft output is shown: metadata only (source field names, keys, codes), never values.
ex_capture_shown() {
  echo "capture-draft exit $1:" >&2
  # One line, so the CI log tail carries it.
  node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))) + "\n")' "$EX_OUT/capture-draft.json" >&2 || cat "$EX_OUT/capture-draft.json" >&2
}
ex_capture() {
  local code=0
  # The M8 runtime tenant's Sugar connection holds a real metadata snapshot; the draft reads it and publishes nothing.
  node -e 'process.stdout.write(JSON.stringify({ objects: [
    { source: "Accounts", entity: "account", identity: { field: "id" }, fields: [{ kind: "capture", source: "website" }] },
    { source: "Contacts", entity: "person", identity: { field: "id" }, fields: [{ kind: "capture", source: "email1" }] } ] }))' >"$EX_IN/capture.json"
  ex_cli sources extension-capture-draft --tenant rtsources --connection sugar --file "$EX_IN/capture.json" >"$EX_OUT/capture-draft.json" || code=$?
  # A sensitive source field name is refused (exit 2); the other is drafted as a src_ key, display / analytics only.
  [ "$code" -eq 2 ] || { ex_capture_shown "$code"; return 1; }
  [ "$(ex_json "$EX_OUT/capture-draft.json" 'r.refused.map((x) => x.source + ":" + x.code).join(",")')" = "Contacts.email1:capture_sensitive_refused" ] || { ex_capture_shown "$code"; return 1; }
  [ "$(ex_json "$EX_OUT/capture-draft.json" 'r.fields.map((f) => f.key + ":" + f.origin + ":" + f.allowed_uses.join("+")).join(",")')" = \
    "src_sugar_accounts_website:source_captured:display" ] || { ex_capture_shown "$code"; return 1; }
  [ "$(ex_sql "SELECT count(*) FROM tenant_registry_versions v JOIN tenants t ON t.id = v.tenant_id WHERE t.slug = 'rtsources' AND v.kind = 'extension'")" = 0 ]
}
check "capture draft from a real snapshot: sensitive field name refused (exit 2), src_ key drafted, nothing published" ex_capture

ex_integrity() {
  local checks c
  ex_cli security integrity-verify --tenant "$EX_TENANT" --actor "$EX_ACTOR" --execute >"$EX_OUT/integrity.json" || return 1
  grep -q '"outcome": "passed"' "$EX_OUT/integrity.json" || return 1
  checks="$(ex_sql "SELECT checks::text FROM tenant_integrity_runs WHERE tenant_id = '$(ex_tid)' ORDER BY started_at DESC LIMIT 1")" || return 1
  for c in extension_value_type_mismatch extension_value_restricted extension_value_target_kind extension_items_parity \
    extension_value_secret_like custom_record_parent_missing custom_relationship_cardinality extension_history_parity; do
    printf '%s' "$checks" | grep -q "$c" || {
      echo "    integrity run lacks check $c" >&2
      return 1
    }
  done
  [ "$(ex_sql "SELECT jsonb_array_length(findings) FROM tenant_integrity_runs WHERE tenant_id = '$(ex_tid)' ORDER BY started_at DESC LIMIT 1")" = 0 ]
}
check "integrity verification runs the eight M10D checks with zero findings" ex_integrity

ex_app_role() {
  ex_app_refused "DELETE FROM tenant_extension_values" 'permission denied' || return 1
  ex_app_refused "DELETE FROM tenant_custom_records" 'permission denied' || return 1
  ex_app_refused "DELETE FROM tenant_custom_relationships" 'permission denied' || return 1
  # The typed CHECK: a string value may not also carry a number.
  ex_app_refused "UPDATE tenant_extension_values SET value_number = 1 WHERE value_type = 'string'" 'tenant_extension_values_typed' || return 1
  # Identity immutability: a value never moves to another target.
  ex_app_refused "UPDATE tenant_extension_values SET target_id = '$EX_C2' WHERE target_id = '$EX_C1'" 'extension_value_identity_immutable'
}
check "the app role cannot delete values / records / edges, break the typed CHECK or move a value" ex_app_role

ex_rollback() {
  local code=0
  ex_cli canonical adopt --tenant "$EX_TENANT" --version 0.3 --expected-current 0.4 >"$EX_OUT/adopt-03-dry.json" || return 1
  [ "$(ex_json "$EX_OUT/adopt-03-dry.json" 'r.modulesStranded.join(",")')" = extension ] || return 1
  ex_cli canonical adopt --tenant "$EX_TENANT" --version 0.3 --expected-current 0.4 --actor "$EX_ACTOR" --execute >"$EX_OUT/adopt-03.json" || return 1
  # Reads work; writes are refused (exit 2, audited) and change nothing.
  ex_ext values show --target "account:$EX_C1" >"$EX_OUT/values-show-03.json" || return 1
  [ "$(ex_json "$EX_OUT/values-show-03.json" 'r.values.find((v) => v.field === "tier").value')" = gold ] || return 1
  ex_ext value set --target "account:$EX_C1" --field tier --value silver --reason runtime_check >"$EX_OUT/set-03.json" || code=$?
  [ "$code" -eq 2 ] && [ "$(ex_json "$EX_OUT/set-03.json" 'r.code')" = canonical_version_too_low ] || return 1
  [ "$(ex_count tenant_extension_values "value_enum = 'gold'")" = 1 ] || return 1
  [ "$(ex_count tenant_audit_events "action = 'extension.value.set' AND outcome = 'failed' AND reason_code = 'canonical_version_too_low'")" = 1 ] || return 1
  ex_cli canonical adopt --tenant "$EX_TENANT" --version 0.4 --expected-current 0.3 --actor "$EX_ACTOR" --execute >"$EX_OUT/adopt-04.json" || return 1
  ex_ext value set --target "account:$EX_C1" --field tier --value silver --reason runtime_check >"$EX_OUT/set-04.json" || return 1
  [ "$(ex_count tenant_extension_values "value_enum = 'silver'")" = 1 ]
}
check "rollback 0.4 → 0.3 with the module on: dry run lists it stranded; reads work, writes refused (exit 2, audited); 0.4 again restores writes" ex_rollback

ex_no_values() {
  local logs=("$WORK/api.log" "$WORK/worker.log") log rc=0
  for log in "${logs[@]}"; do
    [ -f "$log" ] || {
      echo "    log file missing: $log" >&2
      return 1
    }
  done
  # The confidential probe passed one CLI argument (value set); it is stored, never echoed.
  [ "$(ex_count tenant_extension_values "value_text = '$EX_PROBE'")" = 1 ] || return 1
  grep -qF "$EX_PROBE" "${logs[@]}" "$EX_OUT"/*.json "$EX_OUT/cli.stderr" || rc=$?
  [ "$rc" -eq 1 ] || return 1
  [ "$(ex_count tenant_audit_events "details::text LIKE '%$EX_PROBE%' OR details::text LIKE '%north%'")" = 0 ] || return 1
  [ "$(ex_sql "SELECT count(*) FROM tenant_context_changes c WHERE tenant_id = '$(ex_tid)' AND row_to_json(c)::text LIKE '%$EX_PROBE%'")" = 0 ] || return 1
  [ "$(ex_count tenant_value_history)" = 0 ]
}
check "no extension value in the logs, CLI outputs or stderr, audit details, change records or value history" ex_no_values
