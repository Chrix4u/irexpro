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
readonly MIGRATION_MAX_ATTEMPTS="${MIGRATION_MAX_ATTEMPTS:-5}"
readonly MIGRATION_RETRY_SECONDS="${MIGRATION_RETRY_SECONDS:-3}"
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

require_ai_scheduler_enabled() {
  local payload
  payload="$(safe_curl "$AI_HEALTH_URL")"
  HEALTH_PAYLOAD="$payload" node --input-type=module <<'NODE'
let payload;
try {
  payload = JSON.parse(process.env.HEALTH_PAYLOAD);
} catch {
  process.exit(2);
}
if (payload.scheduler_enabled !== true) process.exit(3);
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

wait_for_http_status() {
  local url="$1"
  local allowed_csv="$2"
  local attempt
  for ((attempt = 1; attempt <= MAX_HEALTH_ATTEMPTS; attempt += 1)); do
    if require_http_status "$url" "$allowed_csv" 2>/dev/null; then
      return 0
    fi
    if ((attempt < MAX_HEALTH_ATTEMPTS)); then
      sleep "$HEALTH_RETRY_SECONDS"
    fi
  done
  die "HTTP endpoint did not become ready within the allowed attempts."
}

is_transient_postgres_migration_failure() {
  local output_file="$1"
  grep -Eiq     'database system is not yet accepting connections|database system is in recovery mode|database system is starting up|database system is shutting down|could not connect to server|connection refused|ECONNREFUSED|server closed the connection unexpectedly|Connection terminated unexpectedly'     "$output_file"
}

run_database_migrations() {
  local attempt
  local exit_code
  local output_file
  output_file="$(mktemp)"

  for ((attempt = 1; attempt <= MIGRATION_MAX_ATTEMPTS; attempt += 1)); do
    : > "$output_file"

    if corepack pnpm@"$PNPM_VERSION" --filter @irexpro/api migration:run >"$output_file" 2>&1; then
      cat "$output_file"
      rm -f "$output_file"
      return 0
    else
      exit_code=$?
      cat "$output_file" >&2
    fi

    if ! is_transient_postgres_migration_failure "$output_file"; then
      rm -f "$output_file"
      return "$exit_code"
    fi

    if ((attempt >= MIGRATION_MAX_ATTEMPTS)); then
      printf 'Database migration transient failure persisted after %s attempts.\n'         "$MIGRATION_MAX_ATTEMPTS" >&2
      rm -f "$output_file"
      return "$exit_code"
    fi

    printf 'Database is temporarily unavailable; retrying migration attempt %s/%s.\n'       "$((attempt + 1))" "$MIGRATION_MAX_ATTEMPTS" >&2
    sleep "$MIGRATION_RETRY_SECONDS"
  done

  rm -f "$output_file"
  return 1
}

[[ "$#" -eq 1 ]] || die "Usage: deploy-staging.sh <40-character-commit-sha>"
CANDIDATE_SHA="$1"
readonly CANDIDATE_SHA
[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "Candidate must be a full lowercase commit SHA."

for name in \
  STAGING_ROOT \
  API_PM2_NAME \
  AI_PM2_NAME \
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

# Staging is our paper/demo UAT environment. Enable both sides of scheduler
# coordination explicitly for this process restart without changing production
# defaults or committing secrets.
export AI_ENGINE_SCHEDULER_ENABLED=true
export AI_SCHEDULER_ENABLED=true

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

# Keep the staging database schema on the same immutable release as the API.
# Migrations run only after every application build succeeds and before ANY
# PM2 process is restarted. A migration failure therefore fails closed while
# the previously running release remains untouched.
STAGE="database-migrations"
run_database_migrations

STAGE="restart-ai"
pm2 restart "$AI_PM2_NAME" --update-env
STAGE="ai-runtime-readiness"
require_ai_paper_mode
require_ai_scheduler_enabled

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
wait_for_http_status "$LOCAL_WEB_URL" 200
wait_for_http_status "$LOCAL_ADMIN_URL" "$ADMIN_EXPECTED_STATUSES"
STAGE="public-smoke"
require_http_status "$PUBLIC_WEB_URL" 200
require_http_status "$PUBLIC_ADMIN_URL" "$ADMIN_EXPECTED_STATUSES"
require_health_field "$PUBLIC_API_LIVE_URL" status alive
require_health_field "$PUBLIC_API_READY_URL" status ready

if [[ -n "${AI_HEALTH_URL:-}" ]]; then
  STAGE="ai-paper-mode-observation"
  require_ai_paper_mode
  require_ai_scheduler_enabled
fi

STAGE="final-sha-verification"
[[ "$(git rev-parse HEAD)" == "$CANDIDATE_SHA" ]] || die "Final exact-SHA verification failed."

trap - ERR
printf 'STAGING DEPLOYMENT VERIFIED\n'
printf 'timestamp_utc=%s\n' "$(utc_now)"
printf 'candidate_sha=%s\n' "$CANDIDATE_SHA"
printf 'previous_sha=%s\n' "$PREVIOUS_SHA"
printf 'paper_mode_observed=%s\n' "$([[ -n "${AI_HEALTH_URL:-}" ]] && printf true || printf false)"
