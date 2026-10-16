# shellcheck shell=bash
# Milestone 10E (plan §18, ADR 0031): AccountContext through the real CLI
# processes against the real database (app role, forced RLS). Every CLI prints
# JSON on stdout; the checks read it, and on a mismatch print the CLI output
# as one JSON line on stderr (the CI log tail shows it). Proves: a new tenant
# is at canonical 0.5 with module `account_context` disabled, so operator
# writes are refused (exit 2); the 0.4 → 0.5 adoption dry run lists the module
# as newly available; enabling the module and publishing a context type with
# the dry-run hash; operator write by natural key (create, then the same key
# updates), member add, retire / reactivate / release (one audit event each);
# reads withhold the renewal date and confidential dimensions by default;
# --include-confidential (hardening #90) is refused (exit 2, a denied audit
# event naming data.account_context.read_confidential) until another operator
# grants that capability (`security grant`; a self-grant is refused), then
# releases them (allowed audit event naming the capability and the released
# keys only) until the grantor revokes it (one capability.revoke audit event;
# refused again); a line assignment to an unknown line is refused;
# integrity runs the five M10E checks with zero findings; the app role cannot
# delete a context or change its natural key; a rollback to 0.4 lists the
# module stranded, keeps reads and refuses writes (exit 2, audited) until 0.5
# is adopted again; the confidential probe never reaches a log, CLI output,
# stderr or audit details.

AC_TENANT="rtacctctx"
AC_OUT="$WORK/account-context"
AC_IN="$WORK/account-context-input"
mkdir -p "$AC_OUT" "$AC_IN"
AC_ENV=(DATABASE_URL="$APP_DB_URL" MIGRATION_DATABASE_URL="$OWNER_DB_URL")
AC_ACTOR="runtime-context"
# Hardening #90: the operator that grants the confidential read (never the reader itself).
AC_GRANTOR="runtime-grantor"
# A confidential dimension value that must never be printed or logged (checked at the end).
AC_PROBE="Probeconfidentialsegment"
AC_C1="8e100000-0000-48e1-88e1-000000000001"
AC_C2="8e100000-0000-48e1-88e1-000000000002"
AC_P1="8e100000-0000-48e1-88e1-000000000011"
AC_UNKNOWN="8e100000-0000-48e1-88e1-0000000000ff"
: >"$AC_OUT/cli.stderr"
ac_cli() { (cd "$API_DIR" && env "${AC_ENV[@]}" node "dist/cli/$1.js" "${@:2}" 2>>"$AC_OUT/cli.stderr"); }
ac_ctx() { ac_cli account-context "$@" --tenant "$AC_TENANT" --actor "$AC_ACTOR"; }
ac_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
ac_tid() { ac_sql "SELECT id FROM tenants WHERE slug = '$AC_TENANT'"; }
ac_count() { ac_sql "SELECT count(*) FROM $1 WHERE tenant_id = '$(ac_tid)'${2:+ AND $2}"; }
# Evaluates a JS expression over a CLI's JSON output (r = the parsed document); empty on a parse error.
# The CLI's JSON document is the last top-level object on stdout (a refused write may log a
# security event line before it).
AC_DOC='const t = require("fs").readFileSync(process.argv[1], "utf8"); const i = t.lastIndexOf("\n{\n"); const doc = JSON.parse(i >= 0 ? t.slice(i + 1) : t);'
ac_json() { node -e "$AC_DOC"' try { const r = doc; process.stdout.write(String(eval(process.argv[2]))); } catch (e) { process.stdout.write(""); }' "$1" "$2" 2>/dev/null; }
# One line of the CLI output on stderr (identifiers and codes; the probe is only ever withheld).
ac_dump() {
  printf '    %s: %s\n' "$(basename "$1")" "$(node -e 'try { '"$AC_DOC"' process.stdout.write(JSON.stringify(doc).slice(0, 1500)); } catch (e) { process.stdout.write("<unparseable or missing> " + JSON.stringify(require("fs").existsSync(process.argv[1]) ? require("fs").readFileSync(process.argv[1], "utf8").slice(0, 600) : "")); }' "$1" 2>/dev/null)" >&2
  printf '    cli.stderr tail: %s\n' "$(tail -n 3 "$AC_OUT/cli.stderr" | tr '\n' ' ' | cut -c1-600)" >&2
}
# ac_expect <file> <expr> <expected>: the expression over the file equals the expected value, else dump.
ac_expect() {
  local got
  got="$(ac_json "$1" "$2")"
  [ "$got" = "$3" ] && return 0
  printf '    expected %s = %s, got %s\n' "$2" "$3" "$got" >&2
  ac_dump "$1"
  return 1
}
# ac_refused <file> <code>: the command exited 2 (passed as $3) and printed ok:false (with the code when given).
ac_refused() {
  [ "$3" -eq 2 ] || {
    printf '    expected exit 2, got %s\n' "$3" >&2
    ac_dump "$1"
    return 1
  }
  ac_expect "$1" 'r.ok' false || return 1
  [ -z "$2" ] || ac_expect "$1" 'r.code' "$2"
}
ac_app_refused() {
  local tid
  tid="$(ac_tid)"
  ! compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -v ON_ERROR_STOP=1 -Atc \
    "BEGIN; SELECT set_config('app.current_tenant', '$tid', true); $1; ROLLBACK;" >/dev/null 2>"$AC_OUT/app-refused.err" &&
    grep -Eq "$2" "$AC_OUT/app-refused.err"
}

ac_setup() {
  local code=0 tid
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug "$AC_TENANT" --name 'Runtime Context' >/dev/null) || return 1
  tid="$(ac_tid)"
  # Synthetic accounts and a person (test data written by the owner; the CLIs below are the subject).
  ac_sql "INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES
            ('$AC_C1', '$tid', 'Runtime Context Trust', now(), now()),
            ('$AC_C2', '$tid', 'Runtime Context School', now(), now());
          INSERT INTO persons (id, tenant_id, primary_email, first_name, company_id, created_at, updated_at)
            VALUES ('$AC_P1', '$tid', 'runtime.context@example.test', 'Runtime', '$AC_C1', now(), now());" >/dev/null || return 1
  [ "$(ac_sql "SELECT string_agg(version || ':' || reason, ',' ORDER BY seq) FROM tenant_canonical_adoptions WHERE tenant_id = '$tid'")" = "0.6:new_tenant" ] || return 1
  [ "$(ac_count tenant_module_settings "module_key = 'account_context' AND enabled")" = 0 ] || return 1
  # Module disabled (Q17): an operator write is refused (exit 2) and writes nothing.
  ac_ctx write --account "$AC_C1" --type deal_desk --dim region=emea --name 'Refused' --reason runtime_check >"$AC_OUT/write-disabled.json" || code=$?
  ac_refused "$AC_OUT/write-disabled.json" '' "$code" || return 1
  [ "$(ac_count tenant_account_contexts)" = 0 ]
}
check "a new tenant is at canonical 0.6 with module account_context disabled; an operator write is refused (exit 2)" ac_setup

ac_adoption() {
  # M10F: a new tenant is at 0.6; step back to 0.5 first (nothing of M10F is enabled).
  ac_cli canonical adopt --tenant "$AC_TENANT" --version 0.5 --expected-current 0.6 --actor "$AC_ACTOR" --execute >"$AC_OUT/adopt-05-from-06.json" || {
    ac_dump "$AC_OUT/adopt-05-from-06.json"
    return 1
  }
  ac_cli canonical adopt --tenant "$AC_TENANT" --version 0.4 --expected-current 0.5 --actor "$AC_ACTOR" --execute >"$AC_OUT/adopt-04.json" || {
    ac_dump "$AC_OUT/adopt-04.json"
    return 1
  }
  ac_cli canonical adopt --tenant "$AC_TENANT" --version 0.5 --expected-current 0.4 >"$AC_OUT/adopt-05-dry.json" || {
    ac_dump "$AC_OUT/adopt-05-dry.json"
    return 1
  }
  ac_expect "$AC_OUT/adopt-05-dry.json" 'r.modulesNewlyAvailable.includes("account_context")' true || return 1
  ac_cli canonical adopt --tenant "$AC_TENANT" --version 0.5 --expected-current 0.4 --actor "$AC_ACTOR" --execute >"$AC_OUT/adopt-05.json" || {
    ac_dump "$AC_OUT/adopt-05.json"
    return 1
  }
  ac_cli canonical module --tenant "$AC_TENANT" --module account_context --enable --expected-version 0 \
    --actor "$AC_ACTOR" --execute >"$AC_OUT/module.json" || {
    ac_dump "$AC_OUT/module.json"
    return 1
  }
  [ "$(ac_count tenant_module_settings "module_key = 'account_context' AND enabled")" = 1 ]
}
check "adoption 0.4 → 0.5 dry run lists account_context newly available; 0.5 adopted and the module enabled" ac_adoption

ac_registry() {
  local hash
  node -e 'process.stdout.write(JSON.stringify({
    schema_version: 1,
    types: [{ key: "deal_desk", title: "Deal desk", description: "A regional deal desk of an account",
              dimensions: [
                { key: "region", type: "code", required: true, codes: ["emea", "apac"],
                  sensitivity: "internal", categories: ["operational"] },
                { key: "segment", type: "string", required: false,
                  sensitivity: "confidential", categories: ["commercial"] }
              ],
              member_roles: ["champion", "buyer"] }]
  }))' >"$AC_IN/context-types.json"
  ac_cli canonical registry-publish --tenant "$AC_TENANT" --kind context_type --file "$AC_IN/context-types.json" >"$AC_OUT/registry-dry.json" || {
    ac_dump "$AC_OUT/registry-dry.json"
    return 1
  }
  hash="$(ac_json "$AC_OUT/registry-dry.json" 'r.contentHash')"
  [ "${#hash}" -eq 64 ] || {
    ac_dump "$AC_OUT/registry-dry.json"
    return 1
  }
  ac_cli canonical registry-publish --tenant "$AC_TENANT" --kind context_type --file "$AC_IN/context-types.json" \
    --based-on 0 --expected-hash "$hash" --actor "$AC_ACTOR" --execute >"$AC_OUT/registry-pub.json" || {
    ac_dump "$AC_OUT/registry-pub.json"
    return 1
  }
  [ "$(ac_count tenant_registry_entries "kind = 'context_type' AND key = 'deal_desk' AND status = 'active'")" = 1 ]
}
check "registry: a context_type document published with the dry-run hash projects one active type" ac_registry

ac_write() {
  local id
  ac_ctx write --account "$AC_C1" --type deal_desk --dim region=emea --dim "segment=$AC_PROBE" \
    --name 'EMEA desk' --renewal-date 2027-03-01 --reason runtime_check >"$AC_OUT/write-1.json" || {
    ac_dump "$AC_OUT/write-1.json"
    return 1
  }
  ac_expect "$AC_OUT/write-1.json" 'r.context.created + ":" + r.context.type + ":" + r.context.status' "true:deal_desk:active" || return 1
  id="$(ac_json "$AC_OUT/write-1.json" 'r.context.contextId')"
  # The same natural key (account, type, dimensions) updates the same context.
  ac_ctx write --account "$AC_C1" --type deal_desk --dim region=emea --dim "segment=$AC_PROBE" \
    --name 'EMEA deal desk' --reason runtime_check >"$AC_OUT/write-2.json" || {
    ac_dump "$AC_OUT/write-2.json"
    return 1
  }
  ac_expect "$AC_OUT/write-2.json" 'r.context.created + ":" + r.context.contextId' "false:$id" || return 1
  [ "$(ac_count tenant_account_contexts)" = 1 ] || return 1
  ac_ctx member add --context "$id" --person "$AC_P1" --role champion --reason runtime_check >"$AC_OUT/member.json" || {
    ac_dump "$AC_OUT/member.json"
    return 1
  }
  ac_expect "$AC_OUT/member.json" 'r.member.outcome' added || return 1
  [ "$(ac_count tenant_account_context_persons "status = 'active' AND role_code = 'champion'")" = 1 ] || return 1
  [ "$(ac_count tenant_audit_events "action IN ('account_context.write', 'account_context.member.set') AND outcome = 'allowed'")" = 3 ]
}
check "operator write by natural key creates then updates one context; member add (one audit event each)" ac_write

ac_read() {
  local id code=0
  id="$(ac_sql "SELECT id FROM tenant_account_contexts WHERE tenant_id = '$(ac_tid)'")"
  ac_ctx show --context "$id" --lines >"$AC_OUT/show.json" || {
    ac_dump "$AC_OUT/show.json"
    return 1
  }
  # Confidential values withheld: the renewal date and the confidential dimension.
  ac_expect "$AC_OUT/show.json" 'r.context.withheld.slice().sort().join(",")' "dimension.segment,renewalDate" || return 1
  ac_expect "$AC_OUT/show.json" 'r.context.dimensions.region + ":" + r.context.renewalDate + ":" + r.context.persons.length + ":" + r.lines.lines.length' "emea:null:1:0" || return 1
  # Hardening #90: --include-confidential without data.account_context.read_confidential is
  # refused (exit 2), not redacted, and recorded as denied with that capability.
  ac_ctx show --context "$id" --include-confidential >"$AC_OUT/show-confidential-refused.json" || code=$?
  ac_refused "$AC_OUT/show-confidential-refused.json" authorization_denied "$code" || return 1
  [ "$(ac_count tenant_audit_events "action = 'account_context.read' AND outcome = 'denied' AND capability = 'data.account_context.read_confidential' AND reason_code = 'capability_not_granted'")" = 1 ] || return 1
  # A self-grant is refused (exit 2); another operator grants it (one audit event).
  code=0
  ac_cli security grant --tenant "$AC_TENANT" --grantee "$AC_ACTOR" --capability data.account_context.read_confidential \
    --actor "$AC_ACTOR" >"$AC_OUT/grant-self.json" || code=$?
  ac_refused "$AC_OUT/grant-self.json" self_grant_refused "$code" || return 1
  ac_cli security grant --tenant "$AC_TENANT" --grantee "$AC_ACTOR" --capability data.account_context.read_confidential \
    --actor "$AC_GRANTOR" >"$AC_OUT/grant.json" || {
    ac_dump "$AC_OUT/grant.json"
    return 1
  }
  ac_expect "$AC_OUT/grant.json" 'r.ok + ":" + r.grant.active + ":" + r.grant.version' "true:true:1" || return 1
  [ "$(ac_count tenant_capability_grants "active AND actor_id = '$AC_ACTOR' AND granted_by_id = '$AC_GRANTOR'")" = 1 ] || return 1
  [ "$(ac_count tenant_audit_events "action = 'capability.grant' AND outcome = 'allowed' AND capability = 'security.capability.grant'")" = 1 ] || return 1
  ac_ctx show --context "$id" --include-confidential >"$AC_OUT/show-confidential.json" || {
    ac_dump "$AC_OUT/show-confidential.json"
    return 1
  }
  ac_expect "$AC_OUT/show-confidential.json" 'r.context.renewalDate + ":" + r.context.withheld.length' "2027-03-01:0" || return 1
  # The allowed read names the capability, includeConfidential and the released keys (never values).
  [ "$(ac_sql "SELECT (details ->> 'includeConfidential') || ':' || (details -> 'releasedKeys')::text FROM tenant_audit_events
          WHERE tenant_id = '$(ac_tid)' AND action = 'account_context.read' AND outcome = 'allowed'
            AND capability = 'data.account_context.read_confidential'")" = 'true:["dimension.segment", "renewalDate"]' ] || {
    echo "    confidential read audit event missing or wrong" >&2
    return 1
  }
  # Re-review m3: the grantor revokes it (one allowed capability.revoke audit event, row kept
  # inactive at version 2); the flag is refused again (exit 2).
  ac_cli security revoke --tenant "$AC_TENANT" --grantee "$AC_ACTOR" --capability data.account_context.read_confidential \
    --actor "$AC_GRANTOR" >"$AC_OUT/revoke.json" || {
    ac_dump "$AC_OUT/revoke.json"
    return 1
  }
  ac_expect "$AC_OUT/revoke.json" 'r.ok + ":" + r.grant.active + ":" + r.grant.version' "true:false:2" || return 1
  [ "$(ac_count tenant_capability_grants "NOT active AND version = 2 AND actor_id = '$AC_ACTOR' AND revoked_by_id = '$AC_GRANTOR'")" = 1 ] || return 1
  [ "$(ac_count tenant_audit_events "action = 'capability.revoke' AND outcome = 'allowed' AND capability = 'security.capability.grant' AND target_ref = 'data.account_context.read_confidential:$AC_ACTOR'")" = 1 ] || {
    echo "    capability.revoke audit event missing or wrong" >&2
    return 1
  }
  code=0
  ac_ctx show --context "$id" --include-confidential >"$AC_OUT/show-confidential-revoked.json" || code=$?
  ac_refused "$AC_OUT/show-confidential-revoked.json" authorization_denied "$code" || return 1
  ac_ctx list --account "$AC_C1" --account "$AC_C2" >"$AC_OUT/list.json" || {
    ac_dump "$AC_OUT/list.json"
    return 1
  }
  ac_expect "$AC_OUT/list.json" 'r.contexts.length + ":" + r.truncated' "1:false" || return 1
  [ "$(ac_count tenant_audit_events "action = 'account_context.read' AND outcome = 'allowed'")" = 4 ]
}
check "reads withhold the renewal date and confidential dimensions; --include-confidential is refused (exit 2, denied audit) until another operator grants data.account_context.read_confidential (self-grant refused), then released (audited, keys only); revoke audited and refused again; list batches accounts" ac_read

ac_lifecycle() {
  local id code=0
  id="$(ac_sql "SELECT id FROM tenant_account_contexts WHERE tenant_id = '$(ac_tid)'")"
  ac_ctx retire --context "$id" --reason runtime_check >"$AC_OUT/retire.json" || {
    ac_dump "$AC_OUT/retire.json"
    return 1
  }
  ac_expect "$AC_OUT/retire.json" 'r.context.status' retired || return 1
  ac_ctx reactivate --context "$id" --reason runtime_check >"$AC_OUT/reactivate.json" || {
    ac_dump "$AC_OUT/reactivate.json"
    return 1
  }
  ac_expect "$AC_OUT/reactivate.json" 'r.context.status' active || return 1
  ac_ctx release --context "$id" --reason runtime_check >"$AC_OUT/release.json" || {
    ac_dump "$AC_OUT/release.json"
    return 1
  }
  ac_expect "$AC_OUT/release.json" 'r.context.released > 0' true || return 1
  # An unknown line is refused (exit 2) and nothing is assigned.
  ac_ctx line-assign --line "$AC_UNKNOWN" --context "$id" --reason runtime_check >"$AC_OUT/line-unknown.json" || code=$?
  ac_refused "$AC_OUT/line-unknown.json" validation_failed "$code" || return 1
  [ "$(ac_count tenant_audit_events "action = 'account_context.retire' AND outcome = 'allowed'")" = 1 ] || return 1
  [ "$(ac_count tenant_audit_events "action = 'account_context.release' AND outcome = 'allowed'")" = 1 ]
}
check "retire / reactivate / release (audited); line-assign to an unknown line refused (exit 2)" ac_lifecycle

ac_integrity() {
  local checks c
  ac_cli security integrity-verify --tenant "$AC_TENANT" --actor "$AC_ACTOR" --execute >"$AC_OUT/integrity.json" || {
    ac_dump "$AC_OUT/integrity.json"
    return 1
  }
  grep -q '"outcome": "passed"' "$AC_OUT/integrity.json" || {
    ac_dump "$AC_OUT/integrity.json"
    return 1
  }
  checks="$(ac_sql "SELECT checks::text FROM tenant_integrity_runs WHERE tenant_id = '$(ac_tid)' ORDER BY started_at DESC LIMIT 1")" || return 1
  for c in account_context_company_mismatch account_context_natural_key_drift account_context_type_mismatch \
    account_context_dangling_merge account_context_member_role_unknown; do
    printf '%s' "$checks" | grep -q "$c" || {
      echo "    integrity run lacks check $c" >&2
      return 1
    }
  done
}
check "integrity verification runs the five M10E checks with zero findings" ac_integrity

ac_app_role() {
  ac_app_refused "DELETE FROM tenant_account_contexts" 'permission denied' || return 1
  ac_app_refused "DELETE FROM tenant_account_context_persons" 'permission denied' || return 1
  ac_app_refused "UPDATE tenant_account_contexts SET natural_key_hash = repeat('0', 64)" 'account_context_identity_immutable'
}
check "the app role cannot delete contexts or memberships or change a natural key" ac_app_role

ac_rollback() {
  local code=0 id
  id="$(ac_sql "SELECT id FROM tenant_account_contexts WHERE tenant_id = '$(ac_tid)'")"
  ac_cli canonical adopt --tenant "$AC_TENANT" --version 0.4 --expected-current 0.5 >"$AC_OUT/rollback-dry.json" || {
    ac_dump "$AC_OUT/rollback-dry.json"
    return 1
  }
  ac_expect "$AC_OUT/rollback-dry.json" 'r.modulesStranded.includes("account_context")' true || return 1
  ac_cli canonical adopt --tenant "$AC_TENANT" --version 0.4 --expected-current 0.5 --actor "$AC_ACTOR" --execute >"$AC_OUT/rollback.json" || {
    ac_dump "$AC_OUT/rollback.json"
    return 1
  }
  # Reads work; writes are refused (exit 2, audited) and change nothing.
  ac_ctx show --context "$id" >"$AC_OUT/show-04.json" || {
    ac_dump "$AC_OUT/show-04.json"
    return 1
  }
  ac_expect "$AC_OUT/show-04.json" 'r.context.name' 'EMEA deal desk' || return 1
  ac_ctx write --context "$id" --name 'Refused at 0.4' --reason runtime_check >"$AC_OUT/write-04.json" || code=$?
  ac_refused "$AC_OUT/write-04.json" canonical_version_too_low "$code" || return 1
  [ "$(ac_count tenant_account_contexts "name = 'EMEA deal desk'")" = 1 ] || return 1
  [ "$(ac_count tenant_audit_events "action = 'account_context.write' AND outcome = 'failed' AND reason_code = 'canonical_version_too_low'")" = 1 ] || return 1
  ac_cli canonical adopt --tenant "$AC_TENANT" --version 0.5 --expected-current 0.4 --actor "$AC_ACTOR" --execute >"$AC_OUT/adopt-05-again.json" || {
    ac_dump "$AC_OUT/adopt-05-again.json"
    return 1
  }
  ac_ctx write --context "$id" --name 'EMEA desk again' --reason runtime_check >"$AC_OUT/write-05.json" || {
    ac_dump "$AC_OUT/write-05.json"
    return 1
  }
  [ "$(ac_count tenant_account_contexts "name = 'EMEA desk again'")" = 1 ]
}
check "rollback 0.5 → 0.4 with the module on: dry run lists it stranded; reads work, writes refused (exit 2, audited); 0.5 again restores writes" ac_rollback

ac_no_values() {
  local logs=("$WORK/api.log" "$WORK/worker.log") log rc=0
  for log in "${logs[@]}"; do
    [ -f "$log" ] || {
      echo "    log file missing: $log" >&2
      return 1
    }
  done
  # The confidential probe is stored as a dimension value, never echoed.
  [ "$(ac_count tenant_account_contexts "dimensions ->> 'segment' = '$AC_PROBE'")" = 1 ] || return 1
  # Only the --include-confidential read may print it.
  grep -lF "$AC_PROBE" "${logs[@]}" "$AC_OUT"/*.json "$AC_OUT/cli.stderr" >"$AC_OUT/probe-hits.txt" || rc=$?
  if [ "$rc" -ne 1 ] && [ "$(grep -cv 'show-confidential.json' "$AC_OUT/probe-hits.txt")" != 0 ]; then
    echo "    probe found in: $(tr '\n' ' ' <"$AC_OUT/probe-hits.txt")" >&2
    return 1
  fi
  [ "$(ac_count tenant_audit_events "details::text LIKE '%$AC_PROBE%' OR details::text LIKE '%2027-03-01%'")" = 0 ]
}
check "the confidential dimension and renewal date reach no log, other CLI output, stderr or audit details" ac_no_values
