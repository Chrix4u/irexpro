#!/usr/bin/env bash
# shellcheck disable=SC2016
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly REPO_ROOT
DEPLOY_SCRIPT="$SCRIPT_DIR/deploy-staging.sh"
HEALTH_CONTROLLER="$REPO_ROOT/apps/api/src/health/health.controller.ts"
HEALTH_SERVICE="$REPO_ROOT/apps/api/src/health/health.service.ts"

fail() {
  printf 'TEST FAILURE: %s\n' "$1" >&2
  exit 1
}

grep -Fq 'require_health_field "$LOCAL_API_READY_URL" status ready' "$DEPLOY_SCRIPT" ||
  fail 'Deployment must require readiness status=ready.'

if grep -Fq 'require_health_field "$LOCAL_API_READY_URL" database connected' "$DEPLOY_SCRIPT"; then
  fail 'Deployment must not require internal database field from the public readiness response.'
fi

if grep -Fq 'require_health_field "$LOCAL_API_READY_URL" redis connected' "$DEPLOY_SCRIPT"; then
  fail 'Deployment must not require internal redis field from the public readiness response.'
fi

grep -Fq 'const publicReadiness = { status: readiness.status };' "$HEALTH_CONTROLLER" ||
  fail 'Health controller public readiness contract changed; review deployment checks.'

grep -Fq "status: databaseReady && redisReady ? 'ready' : 'not_ready'" "$HEALTH_SERVICE" ||
  fail 'Readiness no longer proves both database and Redis dependency probes.'

printf 'Deployment/public health contract tests passed.\n'
