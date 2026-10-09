#!/usr/bin/env bash
# Runtime verification: runs the real application against real PostgreSQL and
# Redis and checks its behaviour end to end. Supplements (never replaces)
# `pnpm verify`.
#
#   pnpm verify:runtime            # from the repository root
#
# Requires: Docker (with compose v2), Node 22, pnpm, curl. No credentials.
# Uses an isolated compose project on free ports and removes everything on exit.
# Milestone-specific checks live in scripts/verify-runtime.d/*.sh and are
# sourced after the core checks.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/apps/api"
PROJECT="lipverify$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/lip-verify.XXXXXX")"
PASSED=0
FAILED=0
API_PID=""
WORKER_PID=""

# A currently free port, other than any given as arguments: ports picked
# before anything binds them could otherwise be handed out twice.
free_port() {
  local p _
  for _ in $(seq 1 20); do
    p="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")" || p=""
    [[ "$p" =~ ^[0-9]+$ ]] || { echo "free_port: could not get a free port" >&2; return 1; }
    [[ " $* " == *" $p "* ]] || { echo "$p"; return 0; }
  done
  echo "free_port: no distinct free port after 20 attempts" >&2
  return 1
}
log() { printf '\n== %s\n' "$*"; }
pass() { PASSED=$((PASSED + 1)); printf '  PASS  %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf '  FAIL  %s\n' "$*"; }
check() { local name="$1"; shift; if "$@" >>"$WORK/checks.log" 2>&1; then pass "$name"; else fail "$name"; fi; }
compose() { docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" "$@"; }

# Every process this run starts inherits LIP_VERIFY_RUN, so it can be found and
# stopped even if PID tracking is wrong (Linux: /proc/<pid>/environ).
export LIP_VERIFY_RUN="$PROJECT"
tagged_pids() {
  local env pid
  for env in /proc/[0-9]*/environ; do
    pid="${env#/proc/}"; pid="${pid%/environ}"
    [[ "$pid" == "$$" || "$pid" == "$BASHPID" ]] && continue
    # Processes can exit mid-scan: silence the redirection itself, not just tr.
    { tr '\0' '\n' <"$env"; } 2>/dev/null | grep -qx "LIP_VERIFY_RUN=$PROJECT" || continue
    # Only application processes (and test fakes), not this script's own helper shells.
    case "$({ tr '\0' ' ' <"/proc/$pid/cmdline"; } 2>/dev/null)" in
      node\ dist/* | node\ *test/support/fake-*) echo "$pid" ;;
    esac
  done
  return 0
}

cleanup() {
  local code=$? leftover
  [[ -n "$API_PID" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "$WORKER_PID" ]] && kill "$WORKER_PID" 2>/dev/null || true
  leftover="$(tagged_pids | tr '\n' ' ')"
  if [[ -n "${leftover// /}" ]]; then
    echo "Cleanup: killing leftover application processes from this run: $leftover"
    # shellcheck disable=SC2086
    kill -KILL $leftover 2>/dev/null || true
    code=1
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  local label="com.docker.compose.project=$PROJECT"
  if [[ -n "$(docker ps -aq --filter "label=$label")$(docker volume ls -q --filter "label=$label")$(docker network ls -q --filter "label=$label")" ]]; then
    echo "Cleanup FAILED: containers, volumes or networks of $PROJECT remain"; code=1
  fi
  if [[ $code -eq 0 && $FAILED -eq 0 ]]; then rm -rf "$WORK"; else echo "Logs kept in $WORK"; fi
  exit "$code"
}
trap cleanup EXIT

# Assigned before export so that a failing free_port stops the script (set -e).
LIP_POSTGRES_PORT="${LIP_VERIFY_PG_PORT:-$(free_port "${LIP_VERIFY_REDIS_PORT:-}")}"
LIP_REDIS_PORT="${LIP_VERIFY_REDIS_PORT:-$(free_port "$LIP_POSTGRES_PORT")}"
export LIP_POSTGRES_PORT LIP_REDIS_PORT
API_PORT="$(free_port "$LIP_POSTGRES_PORT" "$LIP_REDIS_PORT")"
API_URL="http://127.0.0.1:$API_PORT"
OWNER_DB_URL="postgresql://lip:lip@127.0.0.1:$LIP_POSTGRES_PORT/lip"
# Development-only credentials created by docker/postgres/init/01-app-role.sql.
APP_DB_URL="postgresql://lip_api:lip_api@127.0.0.1:$LIP_POSTGRES_PORT/lip"
REDIS_URL="redis://127.0.0.1:$LIP_REDIS_PORT"
export REDIS_URL

log "1. Install and build"
(cd "$ROOT" && pnpm install --frozen-lockfile >"$WORK/install.log" 2>&1) && pass "pnpm install --frozen-lockfile" || { fail "install"; exit 1; }
(cd "$ROOT" && pnpm --filter @lip/api build >"$WORK/build.log" 2>&1) && pass "build (prisma generate + nest build)" || { fail "build"; exit 1; }

# The application processes below run exactly as in production.
export NODE_ENV=production LOG_LEVEL=info
# M10A1 (Q1): writing CLI commands need an operator id (recorded as asserted).
# 85-security.sh proves the refusal without it.
export LIP_OPERATOR_ID=runtime-operator

log "2. Start PostgreSQL and Redis (compose project $PROJECT, ports $LIP_POSTGRES_PORT/$LIP_REDIS_PORT)"
compose up -d --wait postgres redis >"$WORK/compose.log" 2>&1 && pass "postgres and redis healthy" || { fail "dependencies"; exit 1; }

log "3. Migrations (schema owner via MIGRATION_DATABASE_URL)"
migrate() { (cd "$API_DIR" && MIGRATION_DATABASE_URL="$OWNER_DB_URL" DATABASE_URL="" pnpm exec prisma migrate deploy); }
check "migrate deploy applies" migrate
check "migrate deploy re-run is a no-op" bash -c "$(declare -f migrate); cd '$API_DIR' && MIGRATION_DATABASE_URL='$OWNER_DB_URL' DATABASE_URL='' pnpm exec prisma migrate deploy | grep -q 'No pending migrations'"

log "4. Start API and worker (non-privileged role lip_api)"
# `exec` replaces the subshell with node, so $! is node's own PID: signals and
# exit codes below refer to the application process, not a wrapper shell.
(cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" PORT="$API_PORT" exec node dist/main.js >"$WORK/api.log" 2>&1) &
API_PID=$!
(cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" exec node dist/worker.js >"$WORK/worker.log" 2>&1) &
WORKER_PID=$!

wait_ready() {
  for _ in $(seq 1 60); do
    curl -fsS "$API_URL/health/ready" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}
wait_ready && pass "API ready at $API_URL" || { fail "API did not become ready"; tail -20 "$WORK/api.log"; exit 1; }
sleep 1
check "worker process running" kill -0 "$WORKER_PID"
check "worker logged start-up" grep -q 'Worker started' "$WORK/worker.log"
check "worker registered the context processors (M6)" grep -q 'Context processors registered' "$WORK/worker.log"

log "5. HTTP behaviour"
json_field() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const v=$1;process.stdout.write(String(v(JSON.parse(d))))})"; }
check "GET /health/live → 200" bash -c "curl -fsS '$API_URL/health/live' | grep -q '\"status\":\"ok\"'"
check "GET /health/ready → database+redis up" bash -c "curl -fsS '$API_URL/health/ready' | grep -q '\"database\":{\"status\":\"up\"' && curl -fsS '$API_URL/health/ready' | grep -q '\"redis\":{\"status\":\"up\"'"
check "x-request-id echoed" bash -c "curl -fsS -D - -o /dev/null -H 'x-request-id: verify-123' '$API_URL/health/live' | grep -qi '^x-request-id: verify-123'"
check "unknown route → 404 standard error body" bash -c "curl -sS '$API_URL/nope' | grep -q '\"statusCode\":404'"
check "security headers (nosniff, no x-powered-by)" bash -c "h=\$(curl -fsS -D - -o /dev/null '$API_URL/health/live'); echo \"\$h\" | grep -qi 'x-content-type-options: nosniff' && ! echo \"\$h\" | grep -qi 'x-powered-by'"

log "6. Tenancy at runtime"
provision() { (cd "$API_DIR" && DATABASE_URL="$APP_DB_URL" node dist/cli/provision-tenant.js "$@"); }
check "provision tenant 'verifyco' from the juniper template" bash -c "$(declare -f provision); API_DIR='$API_DIR' APP_DB_URL='$APP_DB_URL'; provision --slug verifyco --name 'Verify Co' --template juniper | grep -q '\"slug\": \"verifyco\"'"
check "duplicate provisioning refused" bash -c "$(declare -f provision); API_DIR='$API_DIR' APP_DB_URL='$APP_DB_URL'; ! provision --slug verifyco --name Again 2>&1 && provision --slug verifyco --name Again 2>&1 | grep -q 'already exists'"
psql_as() { compose exec -T -e PGPASSWORD="$2" postgres psql -h 127.0.0.1 -U "$1" -d lip -Atc "$3"; }
check "owner sees provisioned config rows" bash -c "[ \"\$(docker compose -p '$PROJECT' -f '$ROOT/docker-compose.yml' exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -Atc 'SELECT count(*) FROM tenant_lead_source_mappings')\" -gt 0 ]"
check "app role with no tenant set sees nothing (RLS)" bash -c "[ \"\$(docker compose -p '$PROJECT' -f '$ROOT/docker-compose.yml' exec -T -e PGPASSWORD=lip_api postgres psql -h 127.0.0.1 -U lip_api -d lip -Atc 'SELECT count(*) FROM tenant_lead_source_mappings')\" = 0 ]"
# Passes only on PostgreSQL's own permission error for this table (SQLSTATE
# 42501), after the same connection has proved it works. A refused connection,
# wrong password, missing database or missing container cannot pass it. It
# connects by service name, not loopback, so password authentication applies
# (the postgres image trusts 127.0.0.1 inside the container).
app_sql() { compose exec -T -e PGPASSWORD="$2" "$1" psql -h postgres -U lip_api -d "$3" -v VERBOSITY=verbose -Atc "$4" 2>&1; }
migration_history_denied() {
  local service="${1:-postgres}" password="${2:-lip_api}" db="${3:-lip}" out
  out="$(app_sql "$service" "$password" "$db" 'SELECT 1')" || { echo "app role could not run SELECT 1: $out"; return 1; }
  if out="$(app_sql "$service" "$password" "$db" 'SELECT 1 FROM _prisma_migrations LIMIT 1')"; then
    echo "app role CAN read migration history"; return 1
  fi
  echo "$out"
  grep -q '42501' <<<"$out" && grep -q 'permission denied for table _prisma_migrations' <<<"$out"
}
check "app role cannot read migration history (SQLSTATE 42501)" migration_history_denied
# Self-tests: the check must fail when access is granted and when the
# connection itself fails, so a passing result means what it says.
owner_sql() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -v ON_ERROR_STOP=1 -Atc "$1"; }
detects_granted_access() {
  local detected=0
  owner_sql 'GRANT SELECT ON TABLE "_prisma_migrations" TO lip_app' || return 1
  migration_history_denied || detected=1
  owner_sql 'REVOKE ALL ON TABLE "_prisma_migrations" FROM lip_app' || return 1
  [[ $detected -eq 1 ]]
}
check "self-test: migration-history check fails if access is granted" detects_granted_access
fails_on_wrong_password() { ! migration_history_denied postgres not-the-password lip; }
fails_on_missing_database() { ! migration_history_denied postgres lip_api lip_no_such_db; }
fails_on_missing_container() { ! migration_history_denied no_such_service lip_api lip; }
check "self-test: migration-history check fails on a wrong password" fails_on_wrong_password
check "self-test: migration-history check fails on a missing database" fails_on_missing_database
check "self-test: migration-history check fails on a missing container" fails_on_missing_container
check "app role is denied migration history again after the self-test" migration_history_denied

log "7. Resilience"
compose stop redis >/dev/null 2>&1
check "Redis down → readiness 503, redis down" bash -c "for i in \$(seq 1 20); do out=\$(curl -sS -w '%{http_code}' '$API_URL/health/ready'); case \"\$out\" in *'\"redis\":{\"status\":\"down\"'*503) exit 0;; esac; sleep 0.5; done; exit 1"
check "liveness stays 200 while not ready" bash -c "curl -fsS '$API_URL/health/live' >/dev/null"
compose start redis >>"$WORK/checks.log" 2>&1 || echo "compose start redis failed" >>"$WORK/checks.log"
redis_recovers() {
  for _ in $(seq 1 60); do curl -fsS "$API_URL/health/ready" >/dev/null 2>&1 && return 0; sleep 0.5; done
  # Not recovered within 30 s: keep enough to diagnose it (CI uploads these logs).
  echo "--- readiness: $(curl -sS "$API_URL/health/ready" 2>&1)"
  echo "--- redis container"; compose ps redis 2>&1; compose logs --tail 30 redis 2>&1
  echo "--- api log (tail)"; tail -30 "$WORK/api.log"
  return 1
}
check "Redis back → readiness recovers" redis_recovers
check "API refuses to start as the schema owner (superuser)" bash -c "cd '$API_DIR' && ! DATABASE_URL='$OWNER_DB_URL' PORT=$(free_port) timeout 60 node dist/main.js >'$WORK/unsafe.log' 2>&1 && grep -q 'Refusing to use the database connection' '$WORK/unsafe.log'"

# Milestone-specific runtime checks (have access to the variables above).
for extra in "$ROOT"/scripts/verify-runtime.d/*.sh; do
  [[ -e "$extra" ]] || continue
  log "Extra: $(basename "$extra")"
  # shellcheck source=/dev/null
  source "$extra"
done

log "8. Graceful shutdown (real node processes)"
check "API PID is the node process" bash -c "[[ \"\$(ps -o args= -p $API_PID)\" == 'node dist/main.js' ]]"
check "worker PID is the node process" bash -c "[[ \"\$(ps -o args= -p $WORKER_PID)\" == 'node dist/worker.js' ]]"
pg_app_sessions() { compose exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -Atc "SELECT count(*) FROM pg_stat_activity WHERE usename = 'lip_api'"; }
redis_clients() { compose exec -T redis redis-cli CLIENT LIST | awk '!/cmd=client/ { n++ } END { print n + 0 }'; }
# Ensure live DB and Redis connections exist. Not fatal: the check below
# reports missing connections instead of aborting the remaining checks.
curl -fsS "$API_URL/health/ready" >/dev/null 2>&1 || true
# A failing probe counts as 0 so the check below fails instead of set -e aborting the run.
before_pg="$(pg_app_sessions 2>/dev/null || true)"; before_redis="$(redis_clients 2>/dev/null || true)"
before_pg="${before_pg:-0}"; before_redis="${before_redis:-0}"
[[ "$before_pg" -gt 0 && "$before_redis" -gt 0 ]] && pass "before shutdown: $before_pg app DB session(s), $before_redis Redis client(s)" \
  || fail "expected open connections before shutdown (db=$before_pg redis=$before_redis)"
kill -TERM "$API_PID" "$WORKER_PID"
stopped() { for _ in $(seq 1 40); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.25; done; return 1; }
# 0 = exited normally; 143 = Nest closed the app, then re-raised SIGTERM.
# A process that does not exit in time is recorded as a failure and SIGKILLed,
# so a shutdown regression fails the run instead of hanging it in `wait`.
clean_exit() {
  local name="$1" pid="$2" logfile="$3" code=0
  if ! stopped "$pid"; then
    fail "$name node process did not exit within 10s of SIGTERM (killed)"
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    return
  fi
  pass "$name node process exits on SIGTERM within 10s"
  wait "$pid" 2>/dev/null || code=$?
  if [[ $code -ne 0 && $code -ne 143 ]]; then fail "$name exit code $code"; return; fi
  if grep -q '"level":\(50\|60\)' "$logfile"; then fail "$name logged errors"; return; fi
  pass "$name exited (code $code, no errors logged)"
}
clean_exit API "$API_PID" "$WORK/api.log"
clean_exit worker "$WORKER_PID" "$WORK/worker.log"
API_PID=""; WORKER_PID=""
# Written by the app's own onApplicationShutdown hook, after modules were destroyed.
check "API ran its shutdown hooks (Application shut down cleanly)" grep -q 'Application shut down cleanly' "$WORK/api.log"
check "worker ran its shutdown hooks (Application shut down cleanly)" grep -q 'Application shut down cleanly' "$WORK/worker.log"
# No connections left behind. (These pass for any dead process, since the
# kernel closes its sockets; the log-line checks above are what prove an orderly
# shutdown.)
check "no app DB sessions left after shutdown" bash -c "for i in \$(seq 1 20); do [ \"\$(docker compose -p '$PROJECT' -f '$ROOT/docker-compose.yml' exec -T -e PGPASSWORD=lip postgres psql -h 127.0.0.1 -U lip -d lip -Atc \"SELECT count(*) FROM pg_stat_activity WHERE usename = 'lip_api'\")\" = 0 ] && exit 0; sleep 0.25; done; exit 1"
no_tagged_processes() { [[ -z "$(tagged_pids)" ]]; }
check "no application process from this run remains (by run tag)" no_tagged_processes
# Polled like the DB check: the compose healthcheck's own `redis-cli ping`
# (every 5 s) is a client too and can be counted at any single instant
# (shown in the M8 closure). A client the app left behind persists for the
# whole window. On failure the remaining clients are listed (no data).
no_redis_clients() {
  local i
  for i in $(seq 1 20); do
    [[ "$(redis_clients)" == 0 ]] && return 0
    sleep 0.25
  done
  return 1
}
if no_redis_clients; then
  pass "no app Redis clients left after shutdown"
else
  fail "no app Redis clients left after shutdown"
  compose exec -T redis redis-cli CLIENT LIST | grep -v 'cmd=client' \
    | grep -o 'addr=[^ ]*\|name=[^ ]*\|age=[^ ]*\|cmd=[^ ]*' | paste -sd' ' -
fi

printf '\n== Summary: %d passed, %d failed\n' "$PASSED" "$FAILED"
[[ $FAILED -eq 0 ]]
