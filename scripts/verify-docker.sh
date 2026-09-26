#!/usr/bin/env bash
# Docker verification: builds the runtime and migrate images, then runs the
# migrate job, API and worker containers against isolated PostgreSQL/Redis and
# checks readiness. Removes everything on exit.
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
CONTAINERS=()

free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
pass() { PASSED=$((PASSED + 1)); printf '  PASS  %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf '  FAIL  %s\n' "$*"; }
compose() { docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" "$@"; }
cleanup() {
  for c in "${CONTAINERS[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$TAG-runtime" "$TAG-migrate" >/dev/null 2>&1 || true
}
trap cleanup EXIT

export LIP_POSTGRES_PORT="$(free_port)" LIP_REDIS_PORT="$(free_port)"
API_PORT="$(free_port)"
# shellcheck disable=SC2086
build() { docker build ${LIP_DOCKER_BUILD_ARGS:-} -f "$DOCKERFILE" --target "$1" -t "$TAG-$1" "$ROOT" >/dev/null; }

echo "== Build images"
build runtime && pass "runtime image builds" || { fail "runtime image build"; exit 1; }
build migrate && pass "migrate image builds" || { fail "migrate image build"; exit 1; }
user="$(docker run --rm --entrypoint id "$TAG-runtime" -un)"
[[ "$user" == "node" ]] && pass "runtime image runs as non-root user '$user'" || fail "runtime image user is '$user'"

echo "== Run containers (host network, isolated ports)"
compose up -d --wait postgres redis >/dev/null 2>&1 && pass "postgres and redis healthy" || { fail "dependencies"; exit 1; }
OWNER="postgresql://lip:lip@127.0.0.1:$LIP_POSTGRES_PORT/lip"
APP="postgresql://lip_api:lip_api@127.0.0.1:$LIP_POSTGRES_PORT/lip"
REDIS="redis://127.0.0.1:$LIP_REDIS_PORT"

docker run --rm --network host -e MIGRATION_DATABASE_URL="$OWNER" "$TAG-migrate" 2>&1 | grep -q 'successfully applied' \
  && pass "migrate job applies migrations (owner credentials only)" || fail "migrate job"

CONTAINERS+=("$PROJECT-api" "$PROJECT-worker")
docker run -d --name "$PROJECT-api" --network host -e PORT="$API_PORT" -e DATABASE_URL="$APP" -e REDIS_URL="$REDIS" "$TAG-runtime" >/dev/null
docker run -d --name "$PROJECT-worker" --network host -e DATABASE_URL="$APP" -e REDIS_URL="$REDIS" "$TAG-runtime" node dist/worker.js >/dev/null

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
docker run --rm --network host -e DATABASE_URL="$APP" -e REDIS_URL="$REDIS" "$TAG-runtime" \
  node dist/cli/provision-tenant.js --slug dockerco --name "Docker Co" --template juniper 2>&1 | grep -q '"slug": "dockerco"' \
  && pass "provisioning CLI works inside the image (template shipped)" || fail "provisioning CLI in image"

printf '\n== Summary: %d passed, %d failed\n' "$PASSED" "$FAILED"
[[ $FAILED -eq 0 ]]
