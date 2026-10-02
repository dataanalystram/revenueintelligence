# shellcheck shell=bash
# Milestone 7: product catalogue, subscriptions and eligibility through the
# real CLI processes against the real database (app role, forced RLS). No
# connector and no credentials: the documented example model and CSV
# (apps/api/config/examples) are the only input. Proves: coverage gating
# (unknown before a full load, never eligible whitespace from no data);
# validate/publish dry runs write nothing; publish is atomic and a K1
# violation is refused; CSV dry run writes nothing, a malformed file writes
# nothing; a full import establishes coverage; evaluate/whitespace answers;
# a recorded snapshot replays after the facts change; a full import without a
# line tombstones it; products:report invariants; RLS; no record values in output.

PE_TENANT="rtproducts"
PE_EXAMPLES="$API_DIR/config/examples"
PE_OUT="$WORK/products"
mkdir -p "$PE_OUT"
pe_cli() { (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/products.js "$@"); }
pe_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
pe_json() { node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=($1);process.stdout.write(typeof v==='string'?v:JSON.stringify(v))"; }

pe_setup() {
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug "$PE_TENANT" --name 'Runtime Products' >/dev/null) || return 1
  # Fixture accounts (in production these arrive through the M6 context pipeline).
  pe_sql "
    WITH t AS (SELECT id FROM tenants WHERE slug = '$PE_TENANT'),
    c AS (
      INSERT INTO companies (tenant_id, id, name, customer_status, created_at, updated_at)
      SELECT t.id, gen_random_uuid(), n, 'customer', now(), now() FROM t, (VALUES ('Runtime Fixture One'), ('Runtime Fixture Two')) v(n)
      RETURNING tenant_id, id, name)
    INSERT INTO company_external_refs (tenant_id, system, object_type, external_id, company_id)
    SELECT tenant_id, 'hubspot', 'companies', CASE name WHEN 'Runtime Fixture One' THEN 'ex-1001' ELSE 'ex-1002' END, id FROM c" >/dev/null
}
check "tenant $PE_TENANT provisioned with two fixture accounts" pe_setup
PE_C1="$(pe_sql "SELECT company_id FROM company_external_refs r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = '$PE_TENANT' AND external_id = 'ex-1001'")"

pe_unknown_first() {
  local out
  pe_cli model validate --tenant "$PE_TENANT" --file "$PE_EXAMPLES/product-model.example.json" >"$PE_OUT/validate.json" || return 1
  [[ "$(pe_json 'o.ok && o.nextVersion' <"$PE_OUT/validate.json")" == "1" ]] || return 1
  pe_cli model publish --tenant "$PE_TENANT" --file "$PE_EXAMPLES/product-model.example.json" >"$PE_OUT/publish-dry.json" || return 1
  [[ "$(pe_json 'o.dryRun' <"$PE_OUT/publish-dry.json")" == "true" ]] || return 1
  [[ "$(pe_sql "SELECT count(*) FROM tenant_product_models m JOIN tenants t ON t.id = m.tenant_id WHERE t.slug = '$PE_TENANT'")" == "0" ]]
}
check "model validate and publish dry run write nothing" pe_unknown_first

pe_publish() {
  pe_cli model publish --tenant "$PE_TENANT" --file "$PE_EXAMPLES/product-model.example.json" --actor runtime --execute >"$PE_OUT/publish.json" || return 1
  [[ "$(pe_json 'o.published.version' <"$PE_OUT/publish.json")" == "1" ]] || return 1
  [[ "$(pe_sql "SELECT count(*) FROM tenant_products p JOIN tenants t ON t.id = p.tenant_id WHERE t.slug = '$PE_TENANT' AND p.model_version = 1")" == "8" ]]
}
check "model published atomically (version 1, projection of 8 products)" pe_publish

pe_k1() {
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    m.products = m.products.filter((p) => p.key !== "self-hosted");
    m.relationships = m.relationships.filter((r) => r.id !== "hosted-excludes-self-hosted");
    process.stdout.write(JSON.stringify(m));' "$PE_EXAMPLES/product-model.example.json" >"$PE_OUT/removed.json"
  local code=0
  pe_cli model publish --tenant "$PE_TENANT" --file "$PE_OUT/removed.json" --execute >"$PE_OUT/k1.json" || code=$?
  [[ $code -eq 2 ]] && grep -q '"product_key_removed"' "$PE_OUT/k1.json" &&
    [[ "$(pe_sql "SELECT max(version) FROM tenant_product_models m JOIN tenants t ON t.id = m.tenant_id WHERE t.slug = '$PE_TENANT'")" == "1" ]]
}
check "a model dropping a product key is refused (K1, exit 2, no version 2)" pe_k1

pe_coverage_unknown() {
  pe_cli whitespace --tenant "$PE_TENANT" --company hubspot:companies:ex-1001 >"$PE_OUT/ws-unknown.json" || return 1
  # Only the retired product fails outright (fail > unknown); everything else is unknown.
  [[ "$(pe_json 'o.summary.eligible_whitespace.length + ":" + o.summary.owned.length + ":" + o.summary.unknown.length + ":" + o.summary.ineligible_whitespace.join()' <"$PE_OUT/ws-unknown.json")" == "0:0:7:classic-reports" ]]
}
check "before a full load: no eligible whitespace, nothing owned, the rest unknown" pe_coverage_unknown

pe_import_dry_and_bad() {
  pe_cli import --tenant "$PE_TENANT" --file "$PE_EXAMPLES/subscriptions.example.csv" --source example_billing --mode full >"$PE_OUT/import-dry.json" || return 1
  [[ "$(pe_json 'o.status + ":" + o.rows' <"$PE_OUT/import-dry.json")" == "valid:3" ]] || return 1
  printf 'record_id,account,product,state,starts_at,ends_at,quantity,source_updated_at\nB1,hubspot:companies:ex-1001,core,active,2026-01-01,,,\n' >"$PE_OUT/bad.csv"
  local code=0
  pe_cli import --tenant "$PE_TENANT" --file "$PE_OUT/bad.csv" --source example_billing --mode full --execute >"$PE_OUT/import-bad.json" || code=$?
  [[ $code -eq 2 ]] && grep -q '"ambiguous_timezone"' "$PE_OUT/import-bad.json" &&
    [[ "$(pe_sql "SELECT count(*) FROM tenant_subscriptions s JOIN tenants t ON t.id = s.tenant_id WHERE t.slug = '$PE_TENANT'")" == "0" ]] &&
    [[ "$(pe_sql "SELECT count(*) FROM tenant_sync_checkpoints s JOIN tenants t ON t.id = s.tenant_id WHERE t.slug = '$PE_TENANT'")" == "0" ]]
}
check "CSV dry run and a malformed file write nothing" pe_import_dry_and_bad

pe_import() {
  pe_cli import --tenant "$PE_TENANT" --file "$PE_EXAMPLES/subscriptions.example.csv" --source example_billing --mode full --execute >"$PE_OUT/import.json" || return 1
  [[ "$(pe_json 'o.status + ":" + o.outcomes.created + ":" + o.coverageKnown' <"$PE_OUT/import.json")" == "completed:3:true" ]] || return 1
  pe_cli coverage --tenant "$PE_TENANT" >"$PE_OUT/coverage.json" && [[ "$(pe_json 'o.coverage' <"$PE_OUT/coverage.json")" == "known" ]]
}
check "full import completes and makes coverage known" pe_import

pe_evaluate() {
  pe_cli evaluate --tenant "$PE_TENANT" --company hubspot:companies:ex-1001 --product insights >"$PE_OUT/eval.json" || return 1
  [[ "$(pe_json 'o.status + ":" + o.ownership + ":" + o.evaluatedCompanyId' <"$PE_OUT/eval.json")" == "eligible:not_owned:$PE_C1" ]] || return 1
  pe_cli whitespace --tenant "$PE_TENANT" --company hubspot:companies:ex-1001 >"$PE_OUT/ws.json" || return 1
  [[ "$(pe_json 'o.summary.owned.join(",")' <"$PE_OUT/ws.json")" == "core,reports" ]] &&
    [[ "$(pe_json 'o.summary.ineligible_whitespace.includes("self-hosted")' <"$PE_OUT/ws.json")" == "true" ]]
}
check "evaluate and whitespace answer from the facts (owned core+reports; self-hosted excluded)" pe_evaluate

pe_snapshot() {
  pe_cli evaluate --tenant "$PE_TENANT" --company hubspot:companies:ex-1001 --product insights --record --purpose runtime_check >"$PE_OUT/rec-dry.json" || return 1
  [[ "$(pe_json 'o.dryRun' <"$PE_OUT/rec-dry.json")" == "true" ]] || return 1
  [[ "$(pe_sql "SELECT count(*) FROM tenant_eligibility_snapshots s JOIN tenants t ON t.id = s.tenant_id WHERE t.slug = '$PE_TENANT'")" == "0" ]] || return 1
  pe_cli evaluate --tenant "$PE_TENANT" --company hubspot:companies:ex-1001 --product insights --record --purpose runtime_check --execute >"$PE_OUT/rec.json" || return 1
  PE_SNAPSHOT="$(pe_json 'o.snapshotId' <"$PE_OUT/rec.json")"
  [[ "$PE_SNAPSHOT" =~ ^[0-9a-f-]{36}$ ]] || return 1
  pe_cli replay --tenant "$PE_TENANT" --snapshot "$PE_SNAPSHOT" >"$PE_OUT/replay.json" && [[ "$(pe_json 'o.reason' <"$PE_OUT/replay.json")" == "reproduced" ]]
}
check "recorded snapshot (dry run writes none) replays as reproduced" pe_snapshot

pe_tombstone() {
  head -n 3 "$PE_EXAMPLES/subscriptions.example.csv" | grep -v '^EX-2,' >"$PE_OUT/fewer.csv"
  printf 'EX-4,hubspot:companies:ex-1001,insights,active,2026-01-01T00:00:00Z,,,\n' >>"$PE_OUT/fewer.csv"
  pe_cli import --tenant "$PE_TENANT" --file "$PE_OUT/fewer.csv" --source example_billing --mode full --execute >"$PE_OUT/import2.json" || return 1
  [[ "$(pe_json 'o.status + ":" + o.tombstoned' <"$PE_OUT/import2.json")" == "completed:2" ]] || return 1
  [[ "$(pe_sql "SELECT string_agg(source_record_id || '=' || record_state, ',' ORDER BY source_record_id) FROM tenant_subscriptions s JOIN tenants t ON t.id = s.tenant_id WHERE t.slug = '$PE_TENANT'")" == "EX-1=active,EX-2=deleted,EX-3=deleted,EX-4=active" ]] || return 1
  pe_cli evaluate --tenant "$PE_TENANT" --company hubspot:companies:ex-1001 --product insights >"$PE_OUT/eval2.json" || return 1
  [[ "$(pe_json 'o.ownership' <"$PE_OUT/eval2.json")" == "owned" ]] || return 1
  pe_cli replay --tenant "$PE_TENANT" --snapshot "$PE_SNAPSHOT" >"$PE_OUT/replay2.json" &&
    [[ "$(pe_json 'o.reason + ":" + o.recorded.status' <"$PE_OUT/replay2.json")" == "reproduced:eligible" ]]
}
check "full import without lines tombstones them; live answer changes, snapshot still replays" pe_tombstone

pe_report() {
  pe_cli report --tenant "$PE_TENANT" >"$PE_OUT/report.json" || return 1
  [[ "$(pe_json 'o.invariants.noActiveLinesOnMergedCompanies + ":" + o.modelVersions.length + ":" + o.coverage.coverage' <"$PE_OUT/report.json")" == "true:1:known" ]] || return 1
  pe_cli show --tenant "$PE_TENANT" --company "$PE_C1" >"$PE_OUT/show.json" && [[ "$(pe_json 'o.subscriptions.length' <"$PE_OUT/show.json")" == "3" ]]
}
check "products:report invariants hold; subscriptions:show lists lines incl. tombstones" pe_report

pe_rls() {
  [[ "$(compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -Atc 'SELECT (SELECT count(*) FROM tenant_subscriptions) + (SELECT count(*) FROM tenant_product_models) + (SELECT count(*) FROM tenant_eligibility_snapshots)')" == "0" ]]
}
check "app role with no tenant set sees no models, subscriptions or snapshots (RLS)" pe_rls

pe_no_values() {
  ! grep -rq 'Runtime Fixture' "$PE_OUT"
}
check "CLI output carries ids, codes and hashes only (no account names)" pe_no_values
