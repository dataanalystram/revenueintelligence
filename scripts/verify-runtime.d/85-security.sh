# shellcheck shell=bash
# Milestone 10A1: the security foundation through the real CLI processes
# against the real database (app role, forced RLS). Proves: a writing command
# without an operator id is refused before any write and recorded as a denied
# audit event (Q1); a dry run needs no operator id; an allowed publish writes
# an audit event with the asserted operator; a secret-like configuration value
# is refused, audited as denied, emitted as a security event, and never
# printed, logged or stored; the audit chain verifies, and a tampered row
# (owner, trigger disabled) is detected with exit code 3; the app role cannot
# change audit events; token key rotation (rekey to a new key id, key usage);
# the audit purge reports and refuses to execute (Q3).

SE_TENANT="rtsecurity"
SE_TAMPER="rtsectamper"
SE_OUT="$WORK/security"
mkdir -p "$SE_OUT"
SE_ENV=(DATABASE_URL="$APP_DB_URL" MIGRATION_DATABASE_URL="$OWNER_DB_URL")
se_cli() { (cd "$API_DIR" && env "${SE_ENV[@]}" node "dist/cli/$1.js" "${@:2}"); }
# The same command with no operator id at all (neither --actor nor LIP_OPERATOR_ID).
se_cli_anon() { (cd "$API_DIR" && env -u LIP_OPERATOR_ID "${SE_ENV[@]}" node "dist/cli/$1.js" "${@:2}"); }
se_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
se_events() {
  se_sql "SELECT e.action || '|' || e.outcome || '|' || coalesce(e.reason_code, '-') || '|' || e.actor_kind || '|' || e.actor_id || '|' || e.actor_assurance
            FROM tenant_audit_events e JOIN tenants t ON t.id = e.tenant_id WHERE t.slug = '$1' ORDER BY e.seq"
}
# A Stripe-shaped value assembled at runtime from a random marker (no real credential).
SE_MARKER="$(node -e 'process.stdout.write(require("crypto").randomBytes(10).toString("hex"))')"
SE_SECRET="sk_live_${SE_MARKER}abcdef"

se_setup() {
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug "$SE_TENANT" --name 'Runtime Security' >/dev/null) || return 1
  (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js --slug "$SE_TAMPER" --name 'Runtime Tamper' >/dev/null) || return 1
  se_events "$SE_TENANT" | grep -q '^tenant.provision|allowed|-|operator|runtime-operator|asserted$'
}
check "tenants provisioned; provisioning audited with the asserted operator" se_setup

se_denied() {
  local code=0
  se_cli_anon products model publish --tenant "$SE_TENANT" --file "$API_DIR/config/examples/product-model.example.json" \
    --based-on 0 --execute >"$SE_OUT/anon.json" 2>"$SE_OUT/anon.err" || code=$?
  [ "$code" -ne 0 ] && grep -q 'LIP_OPERATOR_ID is required' "$SE_OUT/anon.err" || return 1
  [ "$(se_sql "SELECT count(*) FROM tenant_product_models m JOIN tenants t ON t.id = m.tenant_id WHERE t.slug = '$SE_TENANT'")" = 0 ] || return 1
  se_events "$SE_TENANT" | grep -q '^product_model.publish|denied|operator_id_required|operator|unidentified|asserted$'
}
check "--execute without --actor / LIP_OPERATOR_ID → refused before any write, denied audit event (Q1)" se_denied

se_dry_run() {
  se_cli_anon products model validate --tenant "$SE_TENANT" --file "$API_DIR/config/examples/product-model.example.json" >"$SE_OUT/validate.json" || return 1
  grep -q '"ok": true' "$SE_OUT/validate.json"
}
check "a dry run needs no operator id" se_dry_run

se_allowed() {
  se_cli products model publish --tenant "$SE_TENANT" --file "$API_DIR/config/examples/product-model.example.json" \
    --based-on 0 --actor runtime-sec --execute >"$SE_OUT/publish.json" || return 1
  se_events "$SE_TENANT" | grep -q '^product_model.publish|allowed|-|operator|runtime-sec|asserted$'
}
check "allowed publish → one audit event with the asserted operator" se_allowed

se_secret() {
  local code=0
  node -e 'process.stdout.write(JSON.stringify({ site: "synthetic-test", note: process.argv[1] }))' "$SE_SECRET" >"$SE_OUT/secret-config.json"
  se_cli sources configure --tenant "$SE_TENANT" --kind chargebee --label 'Billing' --file "$SE_OUT/secret-config.json" \
    --credential chargebee_api --execute >"$SE_OUT/secret.json" 2>"$SE_OUT/secret.err" || code=$?
  [ "$code" -ne 0 ] && grep -q 'looks like a credential (stripe_key)' "$SE_OUT/secret.err" || return 1
  # The security event is logged (warn, structured) by the CLI process: code and field path only.
  cat "$SE_OUT/secret.json" "$SE_OUT/secret.err" | grep -q 'secret_like_refused' || return 1
  se_events "$SE_TENANT" | grep -q '^source_connection.configure|denied|secret_like_value|operator|runtime-operator|asserted$' || return 1
  ! grep -q "$SE_MARKER" "$SE_OUT/secret.json" "$SE_OUT/secret.err" || return 1
  [ "$(se_sql "SELECT count(*) FROM tenant_source_connections c JOIN tenants t ON t.id = c.tenant_id WHERE t.slug = '$SE_TENANT' AND c.kind = 'chargebee'")" = 0 ]
}
check "secret-like config value → refused, denied audit event, security event; value never printed" se_secret

se_no_trace() {
  ! compose exec -T -e PGPASSWORD=lip postgres pg_dump -h 127.0.0.1 -U lip -d lip --data-only 2>/dev/null | grep -q "$SE_MARKER"
}
check "the secret-like value is in no table (pg_dump --data-only)" se_no_trace

se_verify() {
  se_cli security audit-verify --tenant "$SE_TENANT" --actor runtime-sec >"$SE_OUT/verify.json" || return 1
  grep -q '"ok": true' "$SE_OUT/verify.json" && se_events "$SE_TENANT" | grep -q '^security.audit.verify|completed|'
}
check "security audit-verify: the tenant's chain verifies (and the verification is recorded)" se_verify

se_tamper() {
  local code=0
  se_cli products model publish --tenant "$SE_TAMPER" --file "$API_DIR/config/examples/product-model.example.json" \
    --based-on 0 --actor runtime-sec --execute >/dev/null || return 1
  se_sql "BEGIN; ALTER TABLE tenant_audit_events DISABLE TRIGGER USER;
          UPDATE tenant_audit_events SET actor_id = 'forged' WHERE tenant_id = (SELECT id FROM tenants WHERE slug = '$SE_TAMPER') AND seq = 1;
          ALTER TABLE tenant_audit_events ENABLE TRIGGER USER; COMMIT;" >/dev/null || return 1
  se_cli security audit-verify --tenant "$SE_TAMPER" --actor runtime-sec >"$SE_OUT/tamper.json" 2>"$SE_OUT/tamper.err" || code=$?
  [ "$code" -eq 3 ] && grep -q '"ok": false' "$SE_OUT/tamper.json" && grep -q '"brokenAtSeq": 1' "$SE_OUT/tamper.json" &&
    grep -q '"reason": "hash_mismatch"' "$SE_OUT/tamper.json"
}
check "a tampered audit row (owner, trigger disabled) is detected: exit 3, broken at seq 1" se_tamper

se_app_role() {
  local out
  out="$(compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -Atc \
    "UPDATE tenant_audit_events SET actor_id = 'x'" 2>&1 || true)"
  [[ "$out" == *'permission denied for table tenant_audit_events'* ]] || return 1
  out="$(compose exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -Atc \
    "DELETE FROM tenant_context_changes" 2>&1 || true)"
  [[ "$out" == *'permission denied for table tenant_context_changes'* ]]
}
check "the app role cannot update audit events or delete change records (privileges)" se_app_role

se_rotation() {
  local k2 usage
  k2="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
  local rot=(PLATFORM_TOKEN_ENCRYPTION_KEY="$OA_KEY" PLATFORM_TOKEN_ENCRYPTION_KEY_ID=k2 PLATFORM_TOKEN_ENCRYPTION_KEY_K2="$k2")
  (cd "$API_DIR" && env "${SE_ENV[@]}" "${rot[@]}" node dist/cli/security.js key-usage --tenant rtoauth) >"$SE_OUT/usage-before.json" || return 1
  grep -q '"legacy": 2' "$SE_OUT/usage-before.json" && grep -q '"needingRekey": 2' "$SE_OUT/usage-before.json" || return 1
  (cd "$API_DIR" && env "${SE_ENV[@]}" "${rot[@]}" node dist/cli/security.js rekey --tenant rtoauth) >"$SE_OUT/rekey-dry.json" || return 1
  grep -q '"dryRun": true' "$SE_OUT/rekey-dry.json" && grep -q '"ciphertexts": 2' "$SE_OUT/rekey-dry.json" || return 1
  (cd "$API_DIR" && env "${SE_ENV[@]}" "${rot[@]}" node dist/cli/security.js rekey --tenant rtoauth --actor runtime-sec --execute) >"$SE_OUT/rekey.json" || return 1
  grep -q '"grants": 1' "$SE_OUT/rekey.json" && grep -q '"ciphertexts": 2' "$SE_OUT/rekey.json" || return 1
  (cd "$API_DIR" && env "${SE_ENV[@]}" "${rot[@]}" node dist/cli/security.js key-usage --tenant rtoauth) >"$SE_OUT/usage-after.json" || return 1
  grep -q '"k2": 2' "$SE_OUT/usage-after.json" && grep -q '"needingRekey": 0' "$SE_OUT/usage-after.json" || return 1
  usage="$(se_sql "SELECT left(refresh_token_enc, 6) || left(access_token_enc, 6) FROM tenant_oauth_tokens t JOIN tenants x ON x.id = t.tenant_id WHERE x.slug = 'rtoauth'")"
  [ "$usage" = 'v2:k2:v2:k2:' ] || return 1
  se_events rtoauth | grep -q '^security.rekey|completed|-|operator|runtime-sec|asserted$' || return 1
  ! grep -q "$k2" "$SE_OUT"/usage-*.json "$SE_OUT"/rekey*.json
}
check "key rotation: key-usage → rekey dry run → rekey --execute → every ciphertext on k2, audited" se_rotation

se_purge() {
  local code=0
  se_cli security audit-purge --tenant "$SE_TENANT" >"$SE_OUT/purge-report.json" || return 1
  grep -q '"dryRun": true' "$SE_OUT/purge-report.json" && grep -q '"retentionDays": 365' "$SE_OUT/purge-report.json" &&
    grep -q '"eligibleEvents": 0' "$SE_OUT/purge-report.json" || return 1
  se_cli security audit-purge --tenant "$SE_TENANT" --actor runtime-sec --execute >"$SE_OUT/purge.json" 2>"$SE_OUT/purge.err" || code=$?
  [ "$code" -ne 0 ] && grep -q 'disabled until the formal privacy/retention policy is approved' "$SE_OUT/purge.err" || return 1
  se_events "$SE_TENANT" | grep -q '^security.audit.purge|denied|audit_purge_disabled|operator|runtime-sec|asserted$'
}
check "audit purge: report only; --execute refused (audit_purge_disabled) and recorded (Q3)" se_purge

se_no_values() {
  ! grep -rq "$SE_MARKER" "$SE_OUT" "$WORK/api.log" "$WORK/worker.log" 2>/dev/null
}
check "no secret-like value in any CLI output or process log" se_no_values
