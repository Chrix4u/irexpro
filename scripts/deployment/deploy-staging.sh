#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly EXPECTED_HTTPS_ORIGIN="https://github.com/Chrix4u/irexpro.git"
readonly EXPECTED_SSH_ORIGIN="git@github.com:Chrix4u/irexpro.git"
readonly EXPECTED_SSH_URL_ORIGIN="ssh://git@github.com/Chrix4u/irexpro.git"
readonly PNPM_VERSION="10.34.5"
readonly RELEASE_NODE_MAJOR="22"
readonly MAX_HEALTH_ATTEMPTS="${MAX_HEALTH_ATTEMPTS:-30}"
readonly HEALTH_RETRY_SECONDS="${HEALTH_RETRY_SECONDS:-2}"
readonly ADMIN_EXPECTED_STATUSES="${ADMIN_EXPECTED_STATUSES:-200,302,303,307,308,401,403}"

STAGE="preflight"
PREVIOUS_SHA="unknown"
CANDIDATE_SHA="unknown"

utc_now() {
  date -u +'%Y-%m-%dT%H:%M:%SZ'
}

emit_failure_evidence() {
  local exit_code=$?
  printf 'STAGING DEPLOYMENT FAILED\n' >&2
  printf 'timestamp_utc=%s\n' "$(utc_now)" >&2
  printf 'candidate_sha=%s\n' "$CANDIDATE_SHA" >&2
  printf 'previous_sha=%s\n' "$PREVIOUS_SHA" >&2
  printf 'failed_stage=%s\n' "$STAGE" >&2
  printf 'exit_code=%s\n' "$exit_code" >&2
}
trap emit_failure_evidence ERR

die() {
  printf 'DEPLOYMENT HOLD: %s\n' "$1" >&2
  return 1
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "Required configuration is missing: ${name}"
}

safe_curl() {
  curl --fail --silent --show-error --max-time 10 "$1"
}

require_http_status() {
  local url="$1"
  local allowed_csv="$2"
  local actual
  actual="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 "$url")"
  [[ ",${allowed_csv}," == *",${actual},"* ]] || die "Unexpected HTTP status from a smoke-test endpoint."
}

require_health_field() {
  local url="$1"
  local field="$2"
  local expected="$3"
  local payload
  payload="$(safe_curl "$url")"
  HEALTH_PAYLOAD="$payload" node --input-type=module - "$field" "$expected" <<'NODE'
const [field, expected] = process.argv.slice(2);
let payload;
try {
  payload = JSON.parse(process.env.HEALTH_PAYLOAD);
} catch {
  process.exit(2);
}
if (String(payload[field]) !== expected) {
  process.exit(3);
}
NODE
}

require_ai_paper_mode() {
  local payload
  payload="$(safe_curl "$AI_HEALTH_URL")"
  HEALTH_PAYLOAD="$payload" node --input-type=module <<'NODE'
let payload;
try {
  payload = JSON.parse(process.env.HEALTH_PAYLOAD);
} catch {
  process.exit(2);
}
const candidates = [
  payload.signal_mode,
  payload.execution_mode,
  payload.mode,
  payload.paper_mode,
  payload.paperMode,
];
const verified = candidates.some((value) =>
  value === true || String(value).toLowerCase() === 'paper' || String(value).toLowerCase() === 'paper-only'
);
if (!verified) process.exit(3);
NODE
}

wait_for_api() {
  local attempt
  for ((attempt = 1; attempt <= MAX_HEALTH_ATTEMPTS; attempt += 1)); do
    if require_health_field "$LOCAL_API_LIVE_URL" status alive 2>/dev/null; then
      return 0
    fi
    sleep "$HEALTH_RETRY_SECONDS"
  done
  die "API did not become live within the allowed attempts."
}

[[ "$#" -eq 1 ]] || die "Usage: deploy-staging.sh <40-character-commit-sha>"
CANDIDATE_SHA="$1"
readonly CANDIDATE_SHA
[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "Candidate must be a full lowercase commit SHA."

for name in \
  STAGING_ROOT \
  API_PM2_NAME \
  WEB_PM2_NAME \
  ADMIN_PM2_NAME \
  LOCAL_API_LIVE_URL \
  LOCAL_API_READY_URL \
  LOCAL_API_HEALTH_URL \
  LOCAL_WEB_URL \
  LOCAL_ADMIN_URL \
  PUBLIC_API_LIVE_URL \
  PUBLIC_API_READY_URL \
  PUBLIC_WEB_URL \
  PUBLIC_ADMIN_URL; do
  require_value "$name"
done

STAGE="repository-preflight"
cd "$STAGING_ROOT"
[[ "$(git rev-parse --show-toplevel)" == "$STAGING_ROOT" ]] || die "STAGING_ROOT is not the repository root."
[[ -z "$(git status --porcelain)" ]] || die "Working tree is not clean."

remote_url="$(git config --get remote.origin.url || true)"
case "$remote_url" in
  "$EXPECTED_HTTPS_ORIGIN"|"$EXPECTED_SSH_ORIGIN"|"$EXPECTED_SSH_URL_ORIGIN") ;;
  *) die "Unexpected origin repository." ;;
esac

PREVIOUS_SHA="$(git rev-parse HEAD)"
readonly PREVIOUS_SHA

STAGE="candidate-verification"
git fetch --quiet origin main
git cat-file -e "${CANDIDATE_SHA}^{commit}" 2>/dev/null || die "Candidate commit is unavailable."
git merge-base --is-ancestor "$CANDIDATE_SHA" origin/main || die "Candidate is not contained in origin/main."
git switch --quiet --detach "$CANDIDATE_SHA"
[[ "$(git rev-parse HEAD)" == "$CANDIDATE_SHA" ]] || die "Exact candidate checkout failed."
[[ -z "$(git status --porcelain)" ]] || die "Exact candidate checkout is not clean."

STAGE="release-toolchain-verification"
node_major="$(node -p "process.versions.node.split('.')[0]")"
[[ "$node_major" == "$RELEASE_NODE_MAJOR" ]] || die "Node.js major version does not match the verified release baseline (expected ${RELEASE_NODE_MAJOR})."

STAGE="package-manager-verification"
package_manager="$(node -p "require('./package.json').packageManager || ''")"
[[ "$package_manager" == "pnpm@${PNPM_VERSION}" ]] || die "Candidate packageManager does not match the approved pnpm version."

STAGE="dependency-install"
corepack pnpm@"$PNPM_VERSION" install --frozen-lockfile

STAGE="build-api"
corepack pnpm@"$PNPM_VERSION" --filter @irexpro/api build
STAGE="build-web"
corepack pnpm@"$PNPM_VERSION" --filter @irexpro/web build
STAGE="build-admin"
corepack pnpm@"$PNPM_VERSION" --filter @irexpro/admin build

STAGE="restart-api"
pm2 restart "$API_PM2_NAME" --update-env
STAGE="api-liveness"
wait_for_api
STAGE="api-readiness"
# The public readiness controller intentionally exposes only {status}. The
# underlying HealthService derives `ready` only when both PostgreSQL and Redis
# probes succeed, so validating status=ready preserves dependency fail-closed
# behavior without requiring internal dependency fields to be publicly exposed.
require_health_field "$LOCAL_API_READY_URL" status ready
STAGE="api-aggregate-health"
require_health_field "$LOCAL_API_HEALTH_URL" status ok

STAGE="restart-web-admin"
pm2 restart "$WEB_PM2_NAME" --update-env
pm2 restart "$ADMIN_PM2_NAME" --update-env

STAGE="local-smoke"
require_http_status "$LOCAL_WEB_URL" 200
require_http_status "$LOCAL_ADMIN_URL" "$ADMIN_EXPECTED_STATUSES"
STAGE="public-smoke"
require_http_status "$PUBLIC_WEB_URL" 200
require_http_status "$PUBLIC_ADMIN_URL" "$ADMIN_EXPECTED_STATUSES"
require_health_field "$PUBLIC_API_LIVE_URL" status alive
require_health_field "$PUBLIC_API_READY_URL" status ready

if [[ -n "${AI_HEALTH_URL:-}" ]]; then
  STAGE="ai-paper-mode-observation"
  require_ai_paper_mode
fi

STAGE="final-sha-verification"
[[ "$(git rev-parse HEAD)" == "$CANDIDATE_SHA" ]] || die "Final exact-SHA verification failed."

trap - ERR
printf 'STAGING DEPLOYMENT VERIFIED\n'
printf 'timestamp_utc=%s\n' "$(utc_now)"
printf 'candidate_sha=%s\n' "$CANDIDATE_SHA"
printf 'previous_sha=%s\n' "$PREVIOUS_SHA"
printf 'paper_mode_observed=%s\n' "$([[ -n "${AI_HEALTH_URL:-}" ]] && printf true || printf false)"
