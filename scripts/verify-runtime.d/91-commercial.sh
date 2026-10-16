# shellcheck shell=bash
# Milestone 10F (plan §23 / §24, ADR 0032): the commercial model (price offer,
# contract, entitlement, line references) through the real `commercial` CLI
# against the real database (app role, forced RLS). Every CLI prints JSON on
# stdout; the checks read it, and on a mismatch print the CLI output as one
# JSON line on stderr (the CI log tail shows it). Proves: a new tenant is at
# canonical 0.6 with module `commercial` disabled, so operator writes are
# refused (exit 2, module_disabled); the 0.5 → 0.6 adoption dry run lists the
# module as newly available; 0.6 adopted and the module enabled; operator
# price offer / contract / renews link / entitlement / line assignment
# (contract, offer, predecessor) round trip with one audit event each; a link
# closing a cycle, a cross-account link and a cross-account line assignment
# are refused (exit 2) and change nothing; a secret-like status is refused
# before anything is written; reads withhold the list amount, the renewal date
# and the contract total value by default; --include-confidential is refused
# (exit 2, a denied audit event naming data.commercial.read_confidential)
# until another operator grants that capability (`security grant`; a
# self-grant is refused), then releases them (allowed audit event naming the
# capability and the released keys only) until the grantor revokes it (one
# capability.revoke audit event; refused again); release hands line
# references back to the source; integrity runs the six M10F checks with zero
# findings; app-role refusals (delete of offers / contracts / entitlements,
# self link, cycle through raw SQL, self-superseding line); a rollback to 0.5
# lists the module stranded, keeps reads and refuses writes (exit 2, audited)
# until 0.6 is adopted again; the amount / renewal date probes and the
# secret-like token never reach a log, other CLI output, stderr, audit details,
# change records, value history or conflict rows (V24 remainder). Process
# metrics are in-process only (no exporter endpoint in this stack): the CLIs
# emit none for commercial writes, so the log scan is the exported surface.

CM_TENANT="rtcommercial"
CM_OUT="$WORK/commercial"
mkdir -p "$CM_OUT"
CM_ENV=(DATABASE_URL="$APP_DB_URL" MIGRATION_DATABASE_URL="$OWNER_DB_URL")
CM_ACTOR="runtime-commercial"
# The operator that grants the confidential read (never the reader itself).
CM_GRANTOR="runtime-commercial-grantor"
# Confidential values that must never be printed or logged outside the granted read (checked at the end).
CM_PROBE_LIST="918273645"
CM_PROBE_TOTAL="564738291"
CM_PROBE_RENEWAL="2031-07-15"
# A token shape the secret-like detector refuses, built at run time (never a real credential).
CM_SECRET="ghp_$(printf 'A1b2C3d4E5%.0s' 1 2 3 4)"
CM_C1="8f100000-0000-48f1-88f1-000000000001"
CM_C2="8f100000-0000-48f1-88f1-000000000002"
CM_L1="8f100000-0000-48f1-88f1-000000000021"
CM_L2="8f100000-0000-48f1-88f1-000000000022"
CM_L3="8f100000-0000-48f1-88f1-000000000023"
: >"$CM_OUT/cli.stderr"
cm_cli() { (cd "$API_DIR" && env "${CM_ENV[@]}" node "dist/cli/$1.js" "${@:2}" 2>>"$CM_OUT/cli.stderr"); }
cm_com() { cm_cli commercial "$@" --tenant "$CM_TENANT" --actor "$CM_ACTOR"; }
cm_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
cm_tid() { cm_sql "SELECT id FROM tenants WHERE slug = '$CM_TENANT'"; }
cm_count() { cm_sql "SELECT count(*) FROM $1 WHERE tenant_id = '$(cm_tid)'${2:+ AND $2}"; }
# Evaluates a JS expression over a CLI's JSON output (r = the parsed document); empty on a parse error.
# The CLI's JSON document is the last top-level object on stdout (a refused write may log a
# security event line before it).
CM_DOC='const t = require("fs").readFileSync(process.argv[1], "utf8"); const i = t.lastIndexOf("\n{\n"); const doc = JSON.parse(i >= 0 ? t.slice(i + 1) : t);'
cm_json() { node -e "$CM_DOC"' try { const r = doc; process.stdout.write(String(eval(process.argv[2]))); } catch (e) { process.stdout.write(""); }' "$1" "$2" 2>/dev/null; }
# One line of the CLI output on stderr (identifiers and codes; probes are only ever withheld).
cm_dump() {
  printf '    %s: %s\n' "$(basename "$1")" "$(node -e 'try { '"$CM_DOC"' process.stdout.write(JSON.stringify(doc).slice(0, 1500)); } catch (e) { process.stdout.write("<unparseable or missing> " + JSON.stringify(require("fs").existsSync(process.argv[1]) ? require("fs").readFileSync(process.argv[1], "utf8").slice(0, 600) : "")); }' "$1" 2>/dev/null)" >&2
  printf '    cli.stderr tail: %s\n' "$(tail -n 3 "$CM_OUT/cli.stderr" | tr '\n' ' ' | cut -c1-600)" >&2
}
# cm_expect <file> <expr> <expected>: the expression over the file equals the expected value, else dump.
cm_expect() {
  local got
  got="$(cm_json "$1" "$2")"
  [ "$got" = "$3" ] && return 0
  printf '    expected %s = %s, got %s\n' "$2" "$3" "$got" >&2
  cm_dump "$1"
  return 1
}
# cm_ok <file> <cmd…>: run, write stdout to the file, dump on a non-zero exit.
cm_ok() {
  local f="$1"
  shift
  "$@" >"$f" || {
    cm_dump "$f"
    return 1
  }
}
# cm_refused <file> <code> <exit>: the command exited 2 and printed ok:false (with the code when given).
cm_refused() {
  [ "$3" -eq 2 ] || {
    printf '    expected exit 2, got %s\n' "$3" >&2
    cm_dump "$1"
    return 1
  }
  cm_expect "$1" 'r.ok' false || return 1
  [ -z "$2" ] || cm_expect "$1" 'r.code' "$2"
}
cm_app_refused() {
  local tid
  tid="$(cm_tid)"
  ! compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -v ON_ERROR_STOP=1 -Atc \
    "BEGIN; SELECT set_config('app.current_tenant', '$tid', true); $1; ROLLBACK;" >/dev/null 2>"$CM_OUT/app-refused.err" &&
    grep -Eq "$2" "$CM_OUT/app-refused.err"
}
cm_contract() { cm_sql "SELECT id FROM tenant_contracts WHERE tenant_id = '$(cm_tid)' AND $1"; }

cm_setup() {
  local code=0 tid
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug "$CM_TENANT" --name 'Runtime Commercial' >/dev/null) || return 1
  tid="$(cm_tid)"
  # Synthetic accounts and products (test data written by the owner; the CLI is the subject).
  cm_sql "INSERT INTO companies (id, tenant_id, name, created_at, updated_at) VALUES
            ('$CM_C1', '$tid', 'Runtime Commercial One', now(), now()),
            ('$CM_C2', '$tid', 'Runtime Commercial Two', now(), now());
          INSERT INTO tenant_products (tenant_id, key, name, active, created_at, updated_at) VALUES
            ('$tid', 'core', 'Core', true, now(), now()),
            ('$tid', 'analytics', 'Analytics', true, now(), now());" >/dev/null || return 1
  [ "$(cm_sql "SELECT string_agg(version || ':' || reason, ',' ORDER BY seq) FROM tenant_canonical_adoptions WHERE tenant_id = '$tid'")" = "0.6:new_tenant" ] || return 1
  [ "$(cm_count tenant_module_settings "module_key = 'commercial' AND enabled")" = 0 ] || return 1
  # Module disabled: an operator write is refused (exit 2, module_disabled) and writes nothing.
  cm_com price-offer write --product core --currency EUR --reason runtime_check >"$CM_OUT/write-disabled.json" || code=$?
  cm_refused "$CM_OUT/write-disabled.json" module_disabled "$code" || return 1
  [ "$(cm_count tenant_price_offers)" = 0 ] || return 1
  [ "$(cm_count tenant_audit_events "outcome = 'denied' AND reason_code = 'module_disabled'")" -ge 1 ]
}
check "a new tenant is at canonical 0.6 with module commercial disabled; an operator write is refused (exit 2, module_disabled, audited)" cm_setup

cm_adoption() {
  cm_ok "$CM_OUT/adopt-05.json" cm_cli canonical adopt --tenant "$CM_TENANT" --version 0.5 --expected-current 0.6 --actor "$CM_ACTOR" --execute || return 1
  cm_ok "$CM_OUT/adopt-06-dry.json" cm_cli canonical adopt --tenant "$CM_TENANT" --version 0.6 --expected-current 0.5 || return 1
  cm_expect "$CM_OUT/adopt-06-dry.json" 'r.modulesNewlyAvailable.includes("commercial")' true || return 1
  # The dry run writes nothing.
  [ "$(cm_sql "SELECT version FROM tenant_canonical_adoptions WHERE tenant_id = '$(cm_tid)' ORDER BY seq DESC LIMIT 1")" = 0.5 ] || return 1
  cm_ok "$CM_OUT/adopt-06.json" cm_cli canonical adopt --tenant "$CM_TENANT" --version 0.6 --expected-current 0.5 --actor "$CM_ACTOR" --execute || return 1
  cm_ok "$CM_OUT/module.json" cm_cli canonical module --tenant "$CM_TENANT" --module commercial --enable --expected-version 0 \
    --actor "$CM_ACTOR" --execute || return 1
  [ "$(cm_count tenant_module_settings "module_key = 'commercial' AND enabled")" = 1 ]
}
check "adoption 0.5 → 0.6 dry run lists commercial newly available (writes nothing); 0.6 adopted and the module enabled" cm_adoption

cm_write() {
  local tid offer k1 k2 ent
  tid="$(cm_tid)"
  cm_ok "$CM_OUT/offer.json" cm_com price-offer write --product core --currency EUR --billing-period 1 --billing-period-unit month \
    --pricing-model per_unit --list-amount-minor "$CM_PROBE_LIST" --reason runtime_check || return 1
  cm_expect "$CM_OUT/offer.json" 'r.priceOffer.created' true || return 1
  offer="$(cm_json "$CM_OUT/offer.json" 'r.priceOffer.priceOfferId')"
  cm_ok "$CM_OUT/k1.json" cm_com contract write --account "$CM_C1" --starts-at 2030-01-01T00:00:00.000Z --ends-at 2030-12-31T00:00:00.000Z \
    --renewal-date "$CM_PROBE_RENEWAL" --auto-renew true --status active --total-value-minor "$CM_PROBE_TOTAL" \
    --total-value-currency EUR --reason runtime_check || return 1
  k1="$(cm_json "$CM_OUT/k1.json" 'r.contract.contractId')"
  cm_ok "$CM_OUT/k2.json" cm_com contract write --account "$CM_C1" --starts-at 2031-01-01T00:00:00.000Z --ends-at 2031-12-31T00:00:00.000Z \
    --status draft --reason runtime_check || return 1
  k2="$(cm_json "$CM_OUT/k2.json" 'r.contract.contractId')"
  [ "${#k1}" -eq 36 ] && [ "${#k2}" -eq 36 ] || {
    cm_dump "$CM_OUT/k2.json"
    return 1
  }
  # The renewal links to the first contract.
  cm_ok "$CM_OUT/link.json" cm_com contract link --contract "$k2" --kind renews --target "$k1" --reason runtime_check || return 1
  cm_expect "$CM_OUT/link.json" 'r.contract.changed' true || return 1
  [ "$(cm_sql "SELECT renews_contract_id FROM tenant_contracts WHERE id = '$k2'")" = "$k1" ] || return 1
  cm_ok "$CM_OUT/entitlement.json" cm_com entitlement write --account "$CM_C1" --product core --quantity 25 --status active \
    --reason runtime_check || return 1
  ent="$(cm_json "$CM_OUT/entitlement.json" 'r.entitlement.entitlementId')"
  [ "${#ent}" -eq 36 ] || return 1
  # Synthetic subscription lines (owner SQL; the line sync is not the subject here).
  cm_sql "INSERT INTO tenant_subscriptions (tenant_id, id, company_id, product_key, state, source_system,
                                            source_object_type, source_record_id, observed_at) VALUES
            ('$tid', '$CM_L1', '$CM_C1', 'core', 'active', 'hubspot', 'line_items', 'rt-line-1', now()),
            ('$tid', '$CM_L2', '$CM_C1', 'core', 'active', 'hubspot', 'line_items', 'rt-line-2', now()),
            ('$tid', '$CM_L3', '$CM_C2', 'analytics', 'active', 'hubspot', 'line_items', 'rt-line-3', now());" >/dev/null || return 1
  cm_ok "$CM_OUT/line-contract.json" cm_com line assign-contract --line "$CM_L1" --target "$k1" --reason runtime_check || return 1
  cm_ok "$CM_OUT/line-offer.json" cm_com line assign-price-offer --line "$CM_L1" --target "$offer" --reason runtime_check || return 1
  cm_ok "$CM_OUT/line-renewal.json" cm_com line assign-contract --line "$CM_L2" --target "$k2" --reason runtime_check || return 1
  cm_ok "$CM_OUT/line-supersedes.json" cm_com line set-supersedes --line "$CM_L2" --target "$CM_L1" --reason runtime_check || return 1
  cm_expect "$CM_OUT/line-supersedes.json" 'r.line.changed' true || return 1
  [ "$(cm_sql "SELECT contract_id || ':' || price_offer_id FROM tenant_subscriptions WHERE id = '$CM_L1'")" = "$k1:$offer" ] || return 1
  [ "$(cm_sql "SELECT contract_id || ':' || supersedes_line_id FROM tenant_subscriptions WHERE id = '$CM_L2'")" = "$k2:$CM_L1" ] || return 1
  # One allowed audit event per write.
  [ "$(cm_count tenant_audit_events "action = 'commercial.price_offer.write' AND outcome = 'allowed'")" = 1 ] || return 1
  [ "$(cm_count tenant_audit_events "action = 'commercial.contract.write' AND outcome = 'allowed'")" = 2 ] || return 1
  [ "$(cm_count tenant_audit_events "action = 'commercial.contract.link' AND outcome = 'allowed'")" = 1 ] || return 1
  [ "$(cm_count tenant_audit_events "action = 'commercial.entitlement.write' AND outcome = 'allowed'")" = 1 ] || return 1
  [ "$(cm_count tenant_audit_events "action = 'commercial.line.reference' AND outcome = 'allowed'")" = 4 ] || return 1
  # Value history for the line's contract and offer, and for the contract status.
  [ "$(cm_count tenant_value_history "entity_id = '$CM_L1' AND field IN ('contract_id', 'price_offer_id')")" = 2 ] || return 1
  [ "$(cm_count tenant_value_history "entity_id = '$k1' AND field = 'status'")" -ge 1 ]
}
check "operator price offer / contract / renews link / entitlement / line contract, offer and predecessor (one audit event each, value history)" cm_write

cm_refusals() {
  local code k1 k2 k3
  k1="$(cm_contract "status = 'active'")"
  k2="$(cm_contract "status = 'draft'")"
  # A link closing a cycle (k1 renews k2 while k2 renews k1): exit 2, nothing changed.
  code=0
  cm_com contract link --contract "$k1" --kind renews --target "$k2" --reason runtime_check >"$CM_OUT/link-cycle.json" || code=$?
  cm_refused "$CM_OUT/link-cycle.json" validation_failed "$code" || return 1
  cm_expect "$CM_OUT/link-cycle.json" 'r.message.includes("contract_link_cycle")' true || return 1
  # The amends kind closes the same union cycle.
  code=0
  cm_com contract link --contract "$k1" --kind amends --target "$k2" --reason runtime_check >"$CM_OUT/link-cycle-amends.json" || code=$?
  cm_refused "$CM_OUT/link-cycle-amends.json" validation_failed "$code" || return 1
  [ "$(cm_sql "SELECT coalesce(renews_contract_id::text, '-') || coalesce(amends_contract_id::text, '-') FROM tenant_contracts WHERE id = '$k1'")" = "--" ] || return 1
  # A link to another account's contract: exit 2.
  cm_ok "$CM_OUT/k3.json" cm_com contract write --account "$CM_C2" --status active --reason runtime_check || return 1
  k3="$(cm_json "$CM_OUT/k3.json" 'r.contract.contractId')"
  code=0
  cm_com contract link --contract "$k2" --kind parent --target "$k3" --reason runtime_check >"$CM_OUT/link-cross.json" || code=$?
  cm_refused "$CM_OUT/link-cross.json" validation_failed "$code" || return 1
  cm_expect "$CM_OUT/link-cross.json" 'r.message.includes("contract_link_cross_account")' true || return 1
  # A line of the second account assigned to the first account's contract: exit 2.
  code=0
  cm_com line assign-contract --line "$CM_L3" --target "$k1" --reason runtime_check >"$CM_OUT/line-cross.json" || code=$?
  cm_refused "$CM_OUT/line-cross.json" validation_failed "$code" || return 1
  cm_expect "$CM_OUT/line-cross.json" 'r.message.includes("line_contract_company_mismatch")' true || return 1
  [ "$(cm_sql "SELECT coalesce(contract_id::text, '-') FROM tenant_subscriptions WHERE id = '$CM_L3'")" = "-" ] || return 1
  # A secret-like status is refused before anything is written (exit 2, denied audit event).
  code=0
  cm_com contract write --contract "$k2" --status "$CM_SECRET" --reason runtime_check >"$CM_OUT/write-secret.json" || code=$?
  cm_refused "$CM_OUT/write-secret.json" secret_like_value "$code" || return 1
  [ "$(cm_sql "SELECT status FROM tenant_contracts WHERE id = '$k2'")" = draft ] || return 1
  [ "$(cm_count tenant_audit_events "action = 'commercial.contract.write' AND outcome = 'denied' AND reason_code = 'secret_like_value'")" = 1 ]
}
check "a link closing a cycle (renews / amends), a cross-account link, a cross-account line assignment and a secret-like status are refused (exit 2) and change nothing" cm_refusals

cm_read() {
  local k1 offer code=0
  k1="$(cm_contract "status = 'active' AND company_id = '$CM_C1'")"
  offer="$(cm_sql "SELECT id FROM tenant_price_offers WHERE tenant_id = '$(cm_tid)'")"
  cm_ok "$CM_OUT/show.json" cm_com contract show --contract "$k1" --lines || return 1
  # Confidential values withheld (keys listed, values null); links and lines visible.
  cm_expect "$CM_OUT/show.json" 'r.contract.withheld.slice().sort().join(",")' "renewalDate,totalValueCurrency,totalValueMinor" || return 1
  cm_expect "$CM_OUT/show.json" 'r.contract.renewalDate + ":" + r.contract.totalValueMinor + ":" + r.contract.status + ":" + r.contract.autoRenew' "null:null:active:true" || return 1
  cm_expect "$CM_OUT/show.json" 'r.contract.linkedFrom.map((l) => l.kind).join(",") + ":" + r.lines.lines.length + ":" + r.lines.lines[0].priceOfferId' "renews:1:$offer" || return 1
  cm_ok "$CM_OUT/offer-show.json" cm_com price-offer show --price-offer "$offer" || return 1
  cm_expect "$CM_OUT/offer-show.json" 'r.priceOffer.withheld.join(",") + ":" + r.priceOffer.listAmountMinor + ":" + r.priceOffer.currency' "listAmountMinor:null:EUR" || return 1
  cm_ok "$CM_OUT/list.json" cm_com contract list --account "$CM_C1" --account "$CM_C2" || return 1
  cm_expect "$CM_OUT/list.json" 'r.contracts.length + ":" + r.truncated' "3:false" || return 1
  cm_ok "$CM_OUT/entitlement-list.json" cm_com entitlement list --account "$CM_C1" || return 1
  cm_expect "$CM_OUT/entitlement-list.json" 'r.entitlements.length + ":" + r.entitlements[0].quantity' "1:25" || return 1
  # --include-confidential without data.commercial.read_confidential is refused (exit 2), not
  # redacted, and recorded as denied with that capability.
  cm_com contract show --contract "$k1" --include-confidential >"$CM_OUT/show-confidential-refused.json" || code=$?
  cm_refused "$CM_OUT/show-confidential-refused.json" authorization_denied "$code" || return 1
  [ "$(cm_count tenant_audit_events "action = 'commercial.read' AND outcome = 'denied' AND capability = 'data.commercial.read_confidential' AND reason_code = 'capability_not_granted'")" = 1 ] || return 1
  # A self-grant is refused (exit 2); another operator grants it (one audit event).
  code=0
  cm_cli security grant --tenant "$CM_TENANT" --grantee "$CM_ACTOR" --capability data.commercial.read_confidential \
    --actor "$CM_ACTOR" >"$CM_OUT/grant-self.json" || code=$?
  cm_refused "$CM_OUT/grant-self.json" self_grant_refused "$code" || return 1
  cm_ok "$CM_OUT/grant.json" cm_cli security grant --tenant "$CM_TENANT" --grantee "$CM_ACTOR" --capability data.commercial.read_confidential \
    --actor "$CM_GRANTOR" || return 1
  cm_expect "$CM_OUT/grant.json" 'r.ok + ":" + r.grant.active + ":" + r.grant.version' "true:true:1" || return 1
  [ "$(cm_count tenant_capability_grants "active AND actor_id = '$CM_ACTOR' AND capability = 'data.commercial.read_confidential' AND granted_by_id = '$CM_GRANTOR'")" = 1 ] || return 1
  [ "$(cm_count tenant_audit_events "action = 'capability.grant' AND outcome = 'allowed' AND capability = 'security.capability.grant' AND target_ref = 'data.commercial.read_confidential:$CM_ACTOR'")" = 1 ] || {
    echo "    capability.grant audit event missing or wrong" >&2
    return 1
  }
  cm_ok "$CM_OUT/show-confidential.json" cm_com contract show --contract "$k1" --include-confidential || return 1
  cm_expect "$CM_OUT/show-confidential.json" 'r.contract.renewalDate + ":" + r.contract.totalValueMinor + ":" + r.contract.totalValueCurrency + ":" + r.contract.withheld.length' "$CM_PROBE_RENEWAL:$CM_PROBE_TOTAL:EUR:0" || return 1
  # The allowed read names the capability, includeConfidential and the released keys (never values).
  [ "$(cm_sql "SELECT (details ->> 'includeConfidential') || ':' ||
                      (details -> 'releasedKeys' @> '[\"contract.renewalDate\", \"contract.totalValueMinor\", \"contract.totalValueCurrency\"]'::jsonb)::text || ':' ||
                      jsonb_array_length(details -> 'releasedKeys')
                 FROM tenant_audit_events
                WHERE tenant_id = '$(cm_tid)' AND action = 'commercial.read' AND outcome = 'allowed'
                  AND capability = 'data.commercial.read_confidential'")" = 'true:true:3' ] || {
    echo "    confidential read audit event missing or wrong" >&2
    return 1
  }
  # The grantor revokes it (one allowed capability.revoke audit event, row kept inactive at
  # version 2); the flag is refused again (exit 2).
  cm_ok "$CM_OUT/revoke.json" cm_cli security revoke --tenant "$CM_TENANT" --grantee "$CM_ACTOR" --capability data.commercial.read_confidential \
    --actor "$CM_GRANTOR" || return 1
  cm_expect "$CM_OUT/revoke.json" 'r.ok + ":" + r.grant.active + ":" + r.grant.version' "true:false:2" || return 1
  [ "$(cm_count tenant_capability_grants "NOT active AND version = 2 AND actor_id = '$CM_ACTOR' AND capability = 'data.commercial.read_confidential' AND revoked_by_id = '$CM_GRANTOR'")" = 1 ] || return 1
  [ "$(cm_count tenant_audit_events "action = 'capability.revoke' AND outcome = 'allowed' AND capability = 'security.capability.grant' AND target_ref = 'data.commercial.read_confidential:$CM_ACTOR'")" = 1 ] || {
    echo "    capability.revoke audit event missing or wrong" >&2
    return 1
  }
  code=0
  cm_com contract show --contract "$k1" --include-confidential >"$CM_OUT/show-confidential-revoked.json" || code=$?
  cm_refused "$CM_OUT/show-confidential-revoked.json" authorization_denied "$code" || return 1
  # Exactly one allowed commercial.read event per successful read call: show --lines (contract +
  # its lines = two calls), offer show, list, entitlement list, granted show.
  [ "$(cm_count tenant_audit_events "action = 'commercial.read' AND outcome = 'allowed'")" = 6 ]
}
check "reads withhold list amount, renewal date and total value; --include-confidential is refused (exit 2, denied audit) until another operator grants data.commercial.read_confidential (self-grant refused), then released (audited, keys only); revoke audited and refused again" cm_read

cm_release() {
  cm_ok "$CM_OUT/release-line.json" cm_com release --line "$CM_L1" --reason runtime_check || return 1
  cm_expect "$CM_OUT/release-line.json" 'r.released.lineId + ":" + (r.released.released > 0)' "$CM_L1:true" || return 1
  # Released references stay in place until a source states otherwise.
  [ "$(cm_sql "SELECT (contract_id IS NOT NULL)::text FROM tenant_subscriptions WHERE id = '$CM_L1'")" = true ] || return 1
  [ "$(cm_count tenant_audit_events "action = 'commercial.release' AND outcome = 'allowed'")" = 1 ]
}
check "release hands a line's held references back to the source (audited; references kept)" cm_release

cm_integrity() {
  local checks c
  cm_ok "$CM_OUT/integrity.json" cm_cli security integrity-verify --tenant "$CM_TENANT" --actor "$CM_ACTOR" --execute || return 1
  grep -q '"outcome": "passed"' "$CM_OUT/integrity.json" || {
    cm_dump "$CM_OUT/integrity.json"
    return 1
  }
  checks="$(cm_sql "SELECT checks::text FROM tenant_integrity_runs WHERE tenant_id = '$(cm_tid)' ORDER BY started_at DESC LIMIT 1")" || return 1
  for c in commercial_line_contract_company_mismatch commercial_line_price_offer_product_mismatch \
    commercial_contract_link_cycle commercial_contract_link_cross_account commercial_line_lineage_cycle \
    commercial_agreement_contract_drift; do
    printf '%s' "$checks" | grep -q "\"$c\": 0" || {
      echo "    integrity run lacks check $c at zero: $(printf '%s' "$checks" | cut -c1-600)" >&2
      return 1
    }
  done
}
check "integrity verification runs the six M10F checks with zero findings" cm_integrity

cm_app_role() {
  local k1 k2
  k1="$(cm_contract "status = 'active' AND company_id = '$CM_C1'")"
  k2="$(cm_contract "status = 'draft'")"
  cm_app_refused "DELETE FROM tenant_price_offers" 'permission denied' || return 1
  cm_app_refused "DELETE FROM tenant_contracts" 'permission denied' || return 1
  cm_app_refused "DELETE FROM tenant_entitlements" 'permission denied' || return 1
  cm_app_refused "UPDATE tenant_contracts SET renews_contract_id = id WHERE id = '$k1'" 'tenant_contracts_not_renews_self' || return 1
  cm_app_refused "UPDATE tenant_contracts SET parent_contract_id = '$k2' WHERE id = '$k1'" 'contract_link_cycle' || return 1
  cm_app_refused "UPDATE tenant_subscriptions SET supersedes_line_id = id WHERE id = '$CM_L1'" 'tenant_subscriptions_not_superseding_self'
}
check "the app role cannot delete offers / contracts / entitlements, self-link a contract, close a cycle in raw SQL or make a line supersede itself" cm_app_role

cm_rollback() {
  local code=0 k2
  k2="$(cm_contract "status = 'draft'")"
  cm_ok "$CM_OUT/rollback-dry.json" cm_cli canonical adopt --tenant "$CM_TENANT" --version 0.5 --expected-current 0.6 || return 1
  cm_expect "$CM_OUT/rollback-dry.json" 'r.modulesStranded.includes("commercial")' true || return 1
  cm_ok "$CM_OUT/rollback.json" cm_cli canonical adopt --tenant "$CM_TENANT" --version 0.5 --expected-current 0.6 --actor "$CM_ACTOR" --execute || return 1
  # Reads work; writes are refused (exit 2, audited) and change nothing.
  cm_ok "$CM_OUT/show-05.json" cm_com contract show --contract "$k2" || return 1
  cm_expect "$CM_OUT/show-05.json" 'r.contract.status' draft || return 1
  cm_com contract write --contract "$k2" --status active --reason runtime_check >"$CM_OUT/write-05.json" || code=$?
  cm_refused "$CM_OUT/write-05.json" canonical_version_too_low "$code" || return 1
  [ "$(cm_sql "SELECT status FROM tenant_contracts WHERE id = '$k2'")" = draft ] || return 1
  [ "$(cm_count tenant_audit_events "action = 'commercial.contract.write' AND outcome = 'failed' AND reason_code = 'canonical_version_too_low'")" = 1 ] || return 1
  # Line references are kept.
  [ "$(cm_sql "SELECT (contract_id IS NOT NULL AND supersedes_line_id IS NOT NULL)::text FROM tenant_subscriptions WHERE id = '$CM_L2'")" = true ] || return 1
  cm_ok "$CM_OUT/adopt-06-again.json" cm_cli canonical adopt --tenant "$CM_TENANT" --version 0.6 --expected-current 0.5 --actor "$CM_ACTOR" --execute || return 1
  cm_ok "$CM_OUT/write-06.json" cm_com contract write --contract "$k2" --status active --reason runtime_check || return 1
  [ "$(cm_sql "SELECT status FROM tenant_contracts WHERE id = '$k2'")" = active ]
}
check "rollback 0.6 → 0.5 with the module on: dry run lists it stranded; reads work, writes refused (exit 2, audited), line references kept; 0.6 again restores writes" cm_rollback

cm_no_values() {
  local logs=("$WORK/api.log" "$WORK/worker.log") log rc=0 probe tid
  tid="$(cm_tid)"
  for log in "${logs[@]}"; do
    [ -f "$log" ] || {
      echo "    log file missing: $log" >&2
      return 1
    }
  done
  # The probes are stored (the write happened), never echoed.
  [ "$(cm_count tenant_price_offers "list_amount_minor = $CM_PROBE_LIST")" = 1 ] || return 1
  [ "$(cm_count tenant_contracts "total_value_minor = $CM_PROBE_TOTAL AND renewal_date = '$CM_PROBE_RENEWAL'")" = 1 ] || return 1
  for probe in "$CM_PROBE_LIST" "$CM_PROBE_TOTAL" "$CM_PROBE_RENEWAL" "$CM_SECRET"; do
    rc=0
    grep -lF "$probe" "${logs[@]}" "$CM_OUT"/*.json "$CM_OUT/cli.stderr" >"$CM_OUT/probe-hits.txt" || rc=$?
    # Only the granted --include-confidential read may print the contract's values.
    if [ "$rc" -ne 1 ] && [ "$(grep -cv 'show-confidential.json' "$CM_OUT/probe-hits.txt")" != 0 ]; then
      echo "    probe ${probe:0:4}… found in: $(tr '\n' ' ' <"$CM_OUT/probe-hits.txt")" >&2
      return 1
    fi
    # Audit details, change records, value history and conflict rows carry none of them.
    [ "$(cm_sql "SELECT (SELECT count(*) FROM tenant_audit_events a WHERE a.tenant_id = '$tid' AND a.details::text LIKE '%$probe%')
                      + (SELECT count(*) FROM tenant_context_changes x WHERE x.tenant_id = '$tid' AND x::text LIKE '%$probe%')
                      + (SELECT count(*) FROM tenant_value_history h WHERE h.tenant_id = '$tid' AND h::text LIKE '%$probe%')
                      + (SELECT count(*) FROM tenant_identity_conflicts f WHERE f.tenant_id = '$tid' AND f::text LIKE '%$probe%')")" = 0 ] || {
      echo "    probe ${probe:0:4}… found in audit details, change records, value history or conflicts" >&2
      return 1
    }
  done
  # The renewal-date and list-amount history rows exist and are value-free.
  [ "$(cm_count tenant_value_history "field IN ('renewal_date', 'list_amount_minor') AND NOT values_recorded")" -ge 2 ]
}
check "the list amount, total value, renewal date and secret-like probes reach no log, other CLI output, stderr, audit details, change records, value history or conflicts" cm_no_values
