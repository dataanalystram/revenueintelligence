#!/usr/bin/env bash
# Docker verification: builds the runtime and migrate images, then runs the
# migrate job, API and worker containers against isolated PostgreSQL/Redis and
# checks readiness. Removes everything it created on exit and verifies that
# nothing is left behind.
#
#   pnpm verify:docker
#
# Optional: LIP_DOCKERFILE (default: Dockerfile) and LIP_DOCKER_BUILD_ARGS
# (extra `docker build` arguments, e.g. for a corporate TLS proxy).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="lipdocker$$"
TAG="lipverify-$$"
DOCKERFILE="${LIP_DOCKERFILE:-$ROOT/Dockerfile}"
PASSED=0
FAILED=0
# Every image and container this run creates carries RUN_LABEL; compose
# resources carry COMPOSE_LABEL. Cleanup only ever touches resources with these
# run-specific labels, never other developer resources.
RUN_LABEL="lip.verify.run=$PROJECT"
COMPOSE_LABEL="com.docker.compose.project=$PROJECT"

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
pass() { PASSED=$((PASSED + 1)); printf '  PASS  %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf '  FAIL  %s\n' "$*"; }
compose() { docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" "$@"; }
# Lists this run's remaining resources, one "<kind> <id>" per line. Docker
# errors are listed too, so a broken daemon cannot look like a clean state.
leftovers() {
  {
    docker ps -aq --filter "label=$RUN_LABEL" 2>&1 | sed 's/^/container /'
    docker ps -aq --filter "label=$COMPOSE_LABEL" 2>&1 | sed 's/^/container /'
    docker volume ls -q --filter "label=$COMPOSE_LABEL" 2>&1 | sed 's/^/volume /'
    docker network ls -q --filter "label=$COMPOSE_LABEL" 2>&1 | sed 's/^/network /'
    docker image ls -q --filter "label=$RUN_LABEL" 2>&1 | sed 's/^/image /'
  } | sort -u
}
cleanup() {
  local code=$? ids remain
  set +e
  ids="$(docker ps -aq --filter "label=$RUN_LABEL")"
  # shellcheck disable=SC2086
  [[ -z "$ids" ]] || docker rm -f $ids >/dev/null || echo "Cleanup: docker rm reported an error"
  compose down -v --remove-orphans >/dev/null 2>&1 || echo "Cleanup: compose down reported an error"
  ids="$(docker image ls -q --filter "label=$RUN_LABEL" | sort -u)"
  # shellcheck disable=SC2086
  [[ -z "$ids" ]] || docker image rm -f $ids >/dev/null || echo "Cleanup: docker image rm reported an error"
  remain="$(leftovers)"
  if [[ -n "$remain" ]]; then
    printf 'Cleanup FAILED: resources of %s remain:\n%s\n' "$PROJECT" "$remain"
    code=1
  else
    echo "Cleanup verified: no containers, volumes, networks or images of $PROJECT remain"
  fi
  exit "$code"
}
trap cleanup EXIT

LIP_POSTGRES_PORT="$(free_port)"
LIP_REDIS_PORT="$(free_port "$LIP_POSTGRES_PORT")"
export LIP_POSTGRES_PORT LIP_REDIS_PORT
API_PORT="$(free_port "$LIP_POSTGRES_PORT" "$LIP_REDIS_PORT")"
# shellcheck disable=SC2086
build() { docker build ${LIP_DOCKER_BUILD_ARGS:-} --label "$RUN_LABEL" -f "$DOCKERFILE" --target "$1" -t "$TAG-$1" "$ROOT" >/dev/null; }
# One-off containers are named and labelled, so an interrupted run still
# leaves nothing that cleanup cannot find.
run_once() { local name="$1"; shift; docker run --rm --name "$PROJECT-$name" --label "$RUN_LABEL" "$@"; }

echo "== Build images"
build runtime && pass "runtime image builds" || { fail "runtime image build"; exit 1; }
build migrate && pass "migrate image builds" || { fail "migrate image build"; exit 1; }
declare -A APP_DIR=([runtime]=/app [migrate]=/repo)
for target in runtime migrate; do
  user="$(run_once "id-$target" --entrypoint id "$TAG-$target" -un)"
  [[ "$user" == "node" ]] && pass "$target image runs as non-root user '$user'" || fail "$target image user is '$user'"
  # .dockerignore must keep local environment files (e.g. apps/api/.env) out
  # of the build context, so none can be baked into an image.
  if envfiles="$(run_once "env-$target" --entrypoint find "$TAG-$target" "${APP_DIR[$target]}" \( -name .env -o -name '.env.*' \) -not -path '*/node_modules/*' 2>&1)"; then
    [[ -z "$envfiles" ]] && pass "$target image contains no .env files" || fail "$target image contains .env files: $envfiles"
  else
    fail "$target image .env scan failed: $envfiles"
  fi
done

echo "== Run containers (host network, isolated ports)"
compose up -d --wait postgres redis >/dev/null 2>&1 && pass "postgres and redis healthy" || { fail "dependencies"; exit 1; }
OWNER="postgresql://lip:lip@127.0.0.1:$LIP_POSTGRES_PORT/lip"
APP="postgresql://lip_api:lip_api@127.0.0.1:$LIP_POSTGRES_PORT/lip"
REDIS="redis://127.0.0.1:$LIP_REDIS_PORT"

out="$(run_once migrate --network host -e MIGRATION_DATABASE_URL="$OWNER" "$TAG-migrate" 2>&1 || true)"
grep -q 'successfully applied' <<<"$out" && pass "migrate job applies migrations (owner credentials only)" || fail "migrate job"

docker run -d --name "$PROJECT-api" --label "$RUN_LABEL" --network host -e PORT="$API_PORT" -e DATABASE_URL="$APP" -e REDIS_URL="$REDIS" "$TAG-runtime" >/dev/null
docker run -d --name "$PROJECT-worker" --label "$RUN_LABEL" --network host -e DATABASE_URL="$APP" -e REDIS_URL="$REDIS" "$TAG-runtime" node dist/worker.js >/dev/null

ready=""
for _ in $(seq 1 60); do
  ready="$(curl -fsS "http://127.0.0.1:$API_PORT/health/ready" 2>/dev/null || true)"
  [[ "$ready" == *'"status":"ok"'* ]] && break
  sleep 0.5
done
[[ "$ready" == *'"database":{"status":"up"'* && "$ready" == *'"redis":{"status":"up"'* ]] \
  && pass "API container ready (database up, redis up)" || { fail "API container not ready"; docker logs "$PROJECT-api" 2>&1 | tail -20; }
sleep 1
[[ "$(docker inspect -f '{{.State.Status}}' "$PROJECT-worker")" == "running" ]] && docker logs "$PROJECT-worker" 2>&1 | grep -q 'Worker started' \
  && pass "worker container running and started" || fail "worker container"
out="$(run_once cli --network host -e DATABASE_URL="$APP" -e REDIS_URL="$REDIS" "$TAG-runtime" \
  node dist/cli/provision-tenant.js --slug dockerco --name "Docker Co" --template juniper 2>&1 || true)"
grep -q '"slug": "dockerco"' <<<"$out" && pass "provisioning CLI works inside the image (template shipped)" || fail "provisioning CLI in image"

echo "== Cleanup self-test"
# The leftover detector must see every kind of resource this run creates, or
# the final "nothing remains" assertion could pass while resources are left.
# The stopped probe container also checks that cleanup removes non-running ones.
probe="$(docker create --name "$PROJECT-probe" --label "$RUN_LABEL" "$TAG-runtime" | cut -c1-12)"
seen="$(leftovers)"
missing=""
for kind in container volume network image; do grep -q "^$kind " <<<"$seen" || missing+=" $kind"; done
grep -qx "container $probe" <<<"$seen" || missing+=" probe-container"
[[ -z "$missing" ]] && pass "leftover detector sees this run's containers, volumes, network and images" \
  || fail "leftover detector misses:$missing"

printf '\n== Summary: %d passed, %d failed\n' "$PASSED" "$FAILED"
[[ $FAILED -eq 0 ]]
