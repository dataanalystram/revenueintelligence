# shellcheck shell=bash
# Milestone 10B (plan §19 V23): generic source references, evidence links and
# the provenance read model through the real CLI processes against the real
# database (app role, forced RLS). Proves: a published product model's
# externalRefs are declared references (visible in source_reference_index);
# a republish without one retires it, a republish with it reactivates the same
# row; `provenance show` on a real product returns the declared references and
# writes one provenance.read audit event; integrity verification runs the six
# M10B checks with zero findings; adoption 0.2 → 0.1 → 0.2 through the dry run
# and --execute; the app role cannot delete a reference nor update or delete
# an evidence link; no product name reaches a log or the provenance output.

SR_TENANT="rtreferences"
SR_OUT="$WORK/source-references"
SR_IN="$WORK/source-references-input"
mkdir -p "$SR_OUT" "$SR_IN"
SR_ENV=(DATABASE_URL="$APP_DB_URL" MIGRATION_DATABASE_URL="$OWNER_DB_URL")
SR_PROBE="Runtime Reference Probe"
sr_cli() { (cd "$API_DIR" && env "${SR_ENV[@]}" node "dist/cli/$1.js" "${@:2}"); }
sr_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
sr_tid() { sr_sql "SELECT id FROM tenants WHERE slug = '$SR_TENANT'"; }
sr_refs() {
  sr_sql "SELECT external_id || '|' || entity_key || '|' || origin || '|' || state FROM tenant_source_references
           WHERE tenant_id = '$(sr_tid)' ORDER BY external_id"
}
sr_events() {
  sr_sql "SELECT e.action || '|' || e.outcome || '|' || e.actor_kind || '|' || e.actor_id
            FROM tenant_audit_events e JOIN tenants t ON t.id = e.tenant_id WHERE t.slug = '$SR_TENANT' ORDER BY e.seq"
}
# One statement as the application login with the tenant bound; succeeds only when it is refused.
sr_app_refused() {
  local tid
  tid="$(sr_tid)"
  ! compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -v ON_ERROR_STOP=1 -Atc \
    "BEGIN; SELECT set_config('app.current_tenant', '$tid', true); $1; ROLLBACK;" >/dev/null 2>"$SR_OUT/app-refused.err" &&
    grep -q 'permission denied' "$SR_OUT/app-refused.err"
}
# Writes a product model whose `core` declares the given ProductTemplates ids.
sr_model() {
  node -e '
    const ids = process.argv[2] ? process.argv[2].split(",") : [];
    const refs = ids.map((id) => ({ system: "sugar", objectType: "ProductTemplates", id }));
    process.stdout.write(JSON.stringify({
      products: [
        { key: "core", name: process.argv[1], family: "platform", ...(refs.length ? { externalRefs: refs } : {}) },
        { key: "addon", name: "Runtime Addon", family: "addons" },
      ],
      relationships: [],
    }));' "$SR_PROBE" "$1" >"$SR_IN/model-$2.json"
}
sr_publish() {
  sr_cli products model publish --tenant "$SR_TENANT" --file "$SR_IN/model-$1.json" --actor runtime-refs \
    --based-on "$(($1 - 1))" --execute >"$SR_OUT/publish-$1.json"
}

sr_setup() {
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug "$SR_TENANT" --name 'Runtime References' >/dev/null) || return 1
  sr_model "rt-1,rt-2" 1 && sr_publish 1 || return 1
  [ "$(sr_refs)" = "$(printf 'rt-1|core|declared|active\nrt-2|core|declared|active')" ] || return 1
  [ "$(sr_sql "SELECT count(*) FROM source_reference_index WHERE tenant_id = '$(sr_tid)' AND store = 'tenant_source_references'")" = 2 ]
}
check "a published model's externalRefs are declared, active references, visible in source_reference_index" sr_setup

sr_republish() {
  local id
  id="$(sr_sql "SELECT id FROM tenant_source_references WHERE tenant_id = '$(sr_tid)' AND external_id = 'rt-2'")" || return 1
  sr_model "rt-1" 2 && sr_publish 2 || return 1
  [ "$(sr_refs)" = "$(printf 'rt-1|core|declared|active\nrt-2|core|declared|retired')" ] || return 1
  sr_model "rt-1,rt-2" 3 && sr_publish 3 || return 1
  [ "$(sr_refs)" = "$(printf 'rt-1|core|declared|active\nrt-2|core|declared|active')" ] || return 1
  [ "$(sr_sql "SELECT id FROM tenant_source_references WHERE tenant_id = '$(sr_tid)' AND external_id = 'rt-2'")" = "$id" ] || return 1
  [ "$(sr_sql "SELECT string_agg(change_type, ',' ORDER BY ingested_at) FROM tenant_context_changes
                WHERE tenant_id = '$(sr_tid)' AND entity_kind = 'product' AND source_record_id = 'rt-2'")" = "ref_added,retired,reactivated" ]
}
check "republish without a reference retires it; republish with it reactivates the same row (ref_added, retired, reactivated)" sr_republish

sr_provenance() {
  local before
  before="$(sr_sql "SELECT count(*) FROM tenant_audit_events WHERE tenant_id = '$(sr_tid)' AND action = 'provenance.read'")"
  sr_cli provenance show --tenant "$SR_TENANT" --kind product --key core --actor runtime-refs >"$SR_OUT/provenance.json" || return 1
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const refs = r.provenance.references.map((x) => [x.store, x.externalId, x.origin, x.state].join("|")).sort();
    const want = ["tenant_source_references|rt-1|declared|active", "tenant_source_references|rt-2|declared|active"];
    process.exit(JSON.stringify(refs) === JSON.stringify(want) ? 0 : 1);' "$SR_OUT/provenance.json" || return 1
  [ "$(sr_sql "SELECT count(*) FROM tenant_audit_events WHERE tenant_id = '$(sr_tid)' AND action = 'provenance.read'")" = "$((before + 1))" ] || return 1
  sr_events | grep -q '^provenance.read|allowed|operator|runtime-refs$' || return 1
  # Without an operator the read is refused (exit 2 or failure), and nothing is shown.
  local code=0
  (cd "$API_DIR" && env -u LIP_OPERATOR_ID "${SR_ENV[@]}" node dist/cli/provenance.js show --tenant "$SR_TENANT" --kind product --key core \
    >"$SR_OUT/provenance-noactor.json" 2>"$SR_OUT/provenance-noactor.err") || code=$?
  [ "$code" -ne 0 ] && ! grep -q '"references"' "$SR_OUT/provenance-noactor.json"
}
check "provenance show on a real product returns its declared references; one allowed provenance.read event; no actor → refused" sr_provenance

sr_integrity() {
  local checks
  sr_cli security integrity-verify --tenant "$SR_TENANT" --actor runtime-refs --execute >"$SR_OUT/integrity.json" || return 1
  grep -q '"outcome": "passed"' "$SR_OUT/integrity.json" || return 1
  checks="$(sr_sql "SELECT checks::text FROM tenant_integrity_runs WHERE tenant_id = '$(sr_tid)' ORDER BY started_at DESC LIMIT 1")" || return 1
  local c
  for c in declared_reference_drift source_reference_ambiguous source_reference_change_mismatch \
    evidence_relation_unknown evidence_supersession_invalid source_reference_index_parity; do
    printf '%s' "$checks" | grep -q "$c" || {
      echo "    integrity run lacks check $c" >&2
      return 1
    }
  done
  [ "$(sr_sql "SELECT jsonb_array_length(findings) FROM tenant_integrity_runs WHERE tenant_id = '$(sr_tid)' ORDER BY started_at DESC LIMIT 1")" = 0 ]
}
check "integrity verification runs the six M10B checks with zero findings" sr_integrity

sr_adoption() {
  sr_cli canonical adopt --tenant "$SR_TENANT" --version 0.1 --expected-current 0.2 >"$SR_OUT/adopt-dry.json" || return 1
  grep -q '"dryRun": true' "$SR_OUT/adopt-dry.json" && grep -q 'evidence_links' "$SR_OUT/adopt-dry.json" || return 1
  [ "$(sr_sql "SELECT count(*) FROM tenant_canonical_adoptions WHERE tenant_id = '$(sr_tid)'")" = 1 ] || return 1
  sr_cli canonical adopt --tenant "$SR_TENANT" --version 0.1 --expected-current 0.2 --actor runtime-refs --execute >"$SR_OUT/adopt-01.json" || return 1
  sr_cli canonical adopt --tenant "$SR_TENANT" --version 0.2 --expected-current 0.1 >"$SR_OUT/adopt-02-dry.json" || return 1
  grep -q '"dryRun": true' "$SR_OUT/adopt-02-dry.json" && grep -q 'observed_generic_source_references' "$SR_OUT/adopt-02-dry.json" || return 1
  sr_cli canonical adopt --tenant "$SR_TENANT" --version 0.2 --expected-current 0.1 --actor runtime-refs --execute >"$SR_OUT/adopt-02.json" || return 1
  [ "$(sr_sql "SELECT string_agg(version || ':' || reason, ',' ORDER BY seq) FROM tenant_canonical_adoptions WHERE tenant_id = '$(sr_tid)'")" = \
    "0.2:new_tenant,0.1:rollback,0.2:operator_adoption" ] || return 1
  # References are kept across the rollback and re-adoption.
  [ "$(sr_refs)" = "$(printf 'rt-1|core|declared|active\nrt-2|core|declared|active')" ]
}
check "adoption 0.2 → 0.1 → 0.2: dry runs list the M10B features and write nothing; references kept" sr_adoption

sr_app_role() {
  sr_app_refused "DELETE FROM tenant_source_references" || return 1
  sr_app_refused "UPDATE tenant_evidence_links SET role = 'context'" || return 1
  sr_app_refused "DELETE FROM tenant_evidence_links" || return 1
  sr_app_refused "UPDATE tenant_context_changes SET cause = 'backfill'" || return 1
  sr_app_refused "INSERT INTO source_reference_index (tenant_id) VALUES ('$(sr_tid)')" ||
    grep -q 'cannot insert into view' "$SR_OUT/app-refused.err"
}
check "the app role cannot delete a source reference, update or delete an evidence link or a change record, or write the view" sr_app_role

sr_no_values() {
  local logs=("$WORK/api.log" "$WORK/worker.log") log
  for log in "${logs[@]}"; do
    if [ ! -f "$log" ]; then
      echo "    log file missing: $log" >&2
      return 1
    fi
  done
  # The product name is stored free text: it may be in the model, never in a log,
  # the provenance / integrity / adoption output, the change records or the audit details.
  local rc=0
  grep -qF "$SR_PROBE" "${logs[@]}" "$SR_OUT/provenance.json" "$SR_OUT/integrity.json" "$SR_OUT"/adopt-*.json || rc=$?
  [ "$rc" -eq 1 ] || return 1
  [ "$(sr_sql "SELECT count(*) FROM tenant_audit_events WHERE tenant_id = '$(sr_tid)' AND details::text LIKE '%$SR_PROBE%'")" = 0 ] || return 1
  [ "$(sr_sql "SELECT count(*) FROM tenant_context_changes c WHERE tenant_id = '$(sr_tid)' AND row_to_json(c)::text LIKE '%$SR_PROBE%'")" = 0 ]
}
check "no product name in the API or worker logs, the CLI outputs, the change records or the audit details" sr_no_values
