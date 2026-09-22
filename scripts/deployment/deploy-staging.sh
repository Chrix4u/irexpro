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
read_dotenv_value() {
  local file="$1"
  local key="$2"
  local line

  [[ -f "$file" ]] || return 1
  line="$(grep -E "^${key}=[^[:space:]]+$" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  printf '%s' "${line#*=}"
}

configure_xgboost_runtime_env() {
  local ai_env="$STAGING_ROOT/services/ai-engine/.env"
  local model_path=""
  local metadata_path=""

  model_path="$(read_dotenv_value "$ai_env" XGBOOST_MODEL_PATH || true)"
  metadata_path="$(read_dotenv_value "$ai_env" XGBOOST_MODEL_METADATA_PATH || true)"

  if [[ -z "$model_path" && -z "$metadata_path" ]]; then
    # Explicitly clear any older PM2 snapshot so a removed/held model cannot
    # remain active by accident across a later staging deployment.
    export XGBOOST_MODEL_PATH=""
    export XGBOOST_MODEL_METADATA_PATH=""
    return 0
  fi

  [[ -n "$model_path" && -n "$metadata_path" ]] ||
    die "Staging XGBoost model configuration is incomplete."
  [[ "$model_path" = /* && "$metadata_path" = /* ]] ||
    die "Staging XGBoost model paths must be absolute."
  [[ -f "$model_path" ]] ||
    die "Configured staging XGBoost model artifact does not exist."
  [[ -f "$metadata_path" ]] ||
    die "Configured staging XGBoost metadata sidecar does not exist."

  export XGBOOST_MODEL_PATH="$model_path"
  export XGBOOST_MODEL_METADATA_PATH="$metadata_path"
}

sync_ai_python_dependencies() {
  local ai_root="$STAGING_ROOT/services/ai-engine"
  local ai_python="$ai_root/.venv/bin/python"
  local ai_lock="$ai_root/requirements.lock"

  [[ -x "$ai_python" ]] ||
    die "AI engine Python virtualenv is missing or not executable."
  [[ -f "$ai_lock" ]] ||
    die "AI engine locked requirements file is missing."

  "$ai_python" -m pip install \
    --disable-pip-version-check \
    --no-input \
    --require-hashes \
    -r "$ai_lock"
  "$ai_python" -m pip check
  "$ai_python" -c 'import pyarrow'
}

validate_internal_api_key_alignment() {
  local api_env="$STAGING_ROOT/apps/api/.env"
  local ai_env="$STAGING_ROOT/services/ai-engine/.env"
  local api_key
  local ai_key

  api_key="$(read_dotenv_value "$api_env" NESTJS_INTERNAL_API_KEY)" ||
    die "API staging internal API key is missing or malformed."
  ai_key="$(read_dotenv_value "$ai_env" NESTJS_INTERNAL_API_KEY)" ||
    die "AI engine staging internal API key is missing or malformed."

  [[ ${#api_key} -ge 32 ]] || die "API staging internal API key is too short."
  [[ ${#ai_key} -ge 32 ]] || die "AI engine staging internal API key is too short."
  [[ "$api_key" != "dev_internal_key_change_me" ]] ||
    die "API staging internal API key still uses the development placeholder."
  [[ "$ai_key" != "dev_internal_key_change_me" ]] ||
    die "AI engine staging internal API key still uses the development placeholder."
  [[ "$api_key" == "$ai_key" ]] ||
    die "API and AI engine staging internal API keys do not match."

  unset api_key ai_key
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

wait_for_ai() {
  local attempt
  for ((attempt = 1; attempt <= MAX_HEALTH_ATTEMPTS; attempt += 1)); do
    if require_ai_paper_mode 2>/dev/null && require_ai_scheduler_enabled 2>/dev/null; then
      return 0
    fi
    if ((attempt < MAX_HEALTH_ATTEMPTS)); then
      sleep "$HEALTH_RETRY_SECONDS"
    fi
  done
  die "AI engine did not become ready within the allowed attempts."
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
STAGE="internal-api-key-preflight"
validate_internal_api_key_alignment

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

# The AI engine has an independent, hash-locked Python runtime. Keep its
# existing virtualenv synchronized to the exact candidate before migrations or
# any PM2 restart. A dependency failure therefore leaves the running release
# untouched and prevents research-only additions (for example parquet support)
# from drifting away from the deployed source tree.
STAGE="ai-python-dependencies"
sync_ai_python_dependencies

# Keep the staging database schema on the same immutable release as the API.
# Migrations run only after every application build succeeds and before ANY
# PM2 process is restarted. A migration failure therefore fails closed while
# the previously running release remains untouched.
STAGE="database-migrations"
run_database_migrations

STAGE="ai-model-runtime-configuration"
configure_xgboost_runtime_env
STAGE="restart-ai"
pm2 restart "$AI_PM2_NAME" --update-env
STAGE="ai-runtime-readiness"
wait_for_ai

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
