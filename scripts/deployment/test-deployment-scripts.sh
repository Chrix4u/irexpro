#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly REPO_ROOT
ROOT_PACKAGE_MANAGER="$(node -e "const p=require(process.argv[1]); process.stdout.write(p.packageManager || '')" "$REPO_ROOT/package.json")"
readonly ROOT_PACKAGE_MANAGER
DEPLOY_PNPM_VERSION="$(sed -n 's/^readonly PNPM_VERSION="\([^"\]*\)"/\1/p' "$SCRIPT_DIR/deploy-staging.sh")"
readonly DEPLOY_PNPM_VERSION
REAL_NODE="$(command -v node)"
readonly REAL_NODE
DEPLOY_NODE_MAJOR="$(sed -n 's/^readonly RELEASE_NODE_MAJOR="\([^"\]*\)"/\1/p' "$SCRIPT_DIR/deploy-staging.sh")"
readonly DEPLOY_NODE_MAJOR
TMP_ROOT="$(mktemp -d)"
readonly TMP_ROOT
readonly EXPECTED_HTTPS_ORIGIN="https://github.com/Chrix4u/irexpro.git"
trap 'rm -rf "$TMP_ROOT"' EXIT

FIXTURE_REPO=""
FIXTURE_PRIOR_SHA=""
FIXTURE_CANDIDATE_SHA=""
FAKE_BIN=""
COMMAND_LOG=""

fail() {
  printf 'TEST FAILURE: %s\n' "$1" >&2
  exit 1
}

[[ -n "$ROOT_PACKAGE_MANAGER" ]] || fail 'Root package.json must declare packageManager.'
[[ -n "$DEPLOY_PNPM_VERSION" ]] || fail 'deploy-staging.sh must declare PNPM_VERSION.'
[[ "$ROOT_PACKAGE_MANAGER" == "pnpm@${DEPLOY_PNPM_VERSION}" ]] || fail "Deployment pnpm pin (${DEPLOY_PNPM_VERSION}) does not match root packageManager (${ROOT_PACKAGE_MANAGER})."
[[ -n "$REAL_NODE" ]] || fail 'Node.js must be available to run deployment safety tests.'
[[ -n "$DEPLOY_NODE_MAJOR" ]] || fail 'deploy-staging.sh must declare RELEASE_NODE_MAJOR.'
[[ "$("$REAL_NODE" -p "process.versions.node.split('.')[0]")" == "$DEPLOY_NODE_MAJOR" ]] || fail "Deployment Node major (${DEPLOY_NODE_MAJOR}) does not match the CI validation runtime."

expect_failure() {
  local expected="$1"
  shift
  local output
  if output="$("$@" 2>&1)"; then
    fail "Expected command to fail: $*"
  fi
  [[ "$output" == *"$expected"* ]] || fail "Failure did not contain expected safe marker: $expected"
}

make_fixture() {
  local name="$1"
  local root="$TMP_ROOT/$name"
  local remote="$root/remotes/Chrix4u/irexpro.git"
  local repo="$root/repo"

  mkdir -p "$(dirname "$remote")" "$repo/scripts/deployment"
  git init --quiet --bare --initial-branch=main "$remote"
  git -C "$repo" init --quiet --initial-branch=main
  git -C "$repo" config user.email 'ci@example.invalid'
  git -C "$repo" config user.name 'Deployment Safety CI'

  cp "$SCRIPT_DIR/deploy-staging.sh" "$repo/scripts/deployment/deploy-staging.sh"
  cp "$SCRIPT_DIR/rollback-staging.sh" "$repo/scripts/deployment/rollback-staging.sh"
  printf '{"packageManager":"%s"}\n' "$ROOT_PACKAGE_MANAGER" > "$repo/package.json"
  printf 'prior\n' > "$repo/release-marker.txt"
  git -C "$repo" add .
  git -C "$repo" commit --quiet -m 'fixture: prior verified release'
  FIXTURE_PRIOR_SHA="$(git -C "$repo" rev-parse HEAD)"

  printf 'candidate\n' > "$repo/release-marker.txt"
  git -C "$repo" add release-marker.txt
  git -C "$repo" commit --quiet -m 'fixture: candidate release'
  FIXTURE_CANDIDATE_SHA="$(git -C "$repo" rev-parse HEAD)"

  # Seed a disposable local origin, then expose the exact production URL in
  # remote.origin.url. Git's repository-local insteadOf rule redirects fetches
  # back to the disposable origin, so CI tests the real allowlist without any
  # network or deployment credentials.
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push --quiet -u origin main
  git -C "$repo" remote set-url origin "$EXPECTED_HTTPS_ORIGIN"
  git -C "$repo" config "url.${remote}.insteadOf" "$EXPECTED_HTTPS_ORIGIN"

  FIXTURE_REPO="$repo"
  make_command_shims "$root"
}

make_command_shims() {
  local root="$1"
  FAKE_BIN="$root/fake-bin"
  COMMAND_LOG="$root/commands.log"
  mkdir -p "$FAKE_BIN"
  : > "$COMMAND_LOG"

  cat > "$FAKE_BIN/node" <<'SHIM'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -n "${FAKE_NODE_MAJOR:-}" && "${1:-}" == '-p' && "${2:-}" == "process.versions.node.split('.')[0]" ]]; then
  printf '%s\n' "$FAKE_NODE_MAJOR"
  exit 0
fi
exec "$REAL_NODE" "$@"
SHIM

  cat > "$FAKE_BIN/corepack" <<'SHIM'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'corepack %s\n' "$*" >> "$COMMAND_LOG"
if [[ "${FAKE_BUILD_FAILURE:-}" == 'api' && "$*" == *'--filter @irexpro/api build'* ]]; then
  printf 'simulated API build failure\n' >&2
  exit 41
fi
exit 0
SHIM

  cat > "$FAKE_BIN/pm2" <<'SHIM'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'pm2 %s\n' "$*" >> "$COMMAND_LOG"
exit 0
SHIM

  cat > "$FAKE_BIN/curl" <<'SHIM'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'curl %s\n' "$*" >> "$COMMAND_LOG"
url="${*: -1}"
if [[ "$url" == 'http://local.test/web' && "${FAKE_WEB_CONNECT_FAILURES:-0}" =~ ^[0-9]+$ ]]; then
  web_attempts="$(grep -F -c 'http://local.test/web' "$COMMAND_LOG" || true)"
  if (( web_attempts <= FAKE_WEB_CONNECT_FAILURES )); then
    printf 'simulated connection refused\n' >&2
    exit 7
  fi
fi
if [[ "$*" == *"--write-out"* ]]; then
  if [[ "$url" == *admin* ]]; then
    printf '307'
  else
    printf '200'
  fi
  exit 0
fi
if [[ "$url" == *ready* ]]; then
  if [[ "${FAKE_READY_FAILURE:-0}" == '1' ]]; then
    printf '{"status":"not-ready","database":"connected","redis":"connected"}'
  else
    printf '{"status":"ready","database":"connected","redis":"connected"}'
  fi
elif [[ "$url" == *live* ]]; then
  printf '{"status":"alive"}'
elif [[ "$url" == *ai* ]]; then
  printf '{"signal_mode":"paper"}'
else
  printf '{"status":"ok"}'
fi
SHIM

  chmod 700 "$FAKE_BIN/node" "$FAKE_BIN/corepack" "$FAKE_BIN/pm2" "$FAKE_BIN/curl"
}

run_deploy() {
  local candidate="$1"
  shift
  env \
    PATH="$FAKE_BIN:$PATH" \
    REAL_NODE="$REAL_NODE" \
    COMMAND_LOG="$COMMAND_LOG" \
    STAGING_ROOT="$FIXTURE_REPO" \
    API_PM2_NAME='irexpro-api-staging' \
    WEB_PM2_NAME='irexpro-web-staging' \
    ADMIN_PM2_NAME='irexpro-admin-staging' \
    LOCAL_API_LIVE_URL='http://local.test/api/live' \
    LOCAL_API_READY_URL='http://local.test/api/ready' \
    LOCAL_API_HEALTH_URL='http://local.test/api/health' \
    LOCAL_WEB_URL='http://local.test/web' \
    LOCAL_ADMIN_URL='http://local.test/admin' \
    PUBLIC_API_LIVE_URL='https://public.test/api/live' \
    PUBLIC_API_READY_URL='https://public.test/api/ready' \
    PUBLIC_WEB_URL='https://public.test/web' \
    PUBLIC_ADMIN_URL='https://public.test/admin' \
    AI_HEALTH_URL='http://local.test/ai/health' \
    MAX_HEALTH_ATTEMPTS=1 \
    HEALTH_RETRY_SECONDS=0 \
    "$@" \
    bash "$SCRIPT_DIR/deploy-staging.sh" "$candidate"
}

run_rollback() {
  local failed_sha="$1"
  local rollback_sha="$2"
  env \
    PATH="$FAKE_BIN:$PATH" \
    REAL_NODE="$REAL_NODE" \
    COMMAND_LOG="$COMMAND_LOG" \
    STAGING_ROOT="$FIXTURE_REPO" \
    API_PM2_NAME='irexpro-api-staging' \
    WEB_PM2_NAME='irexpro-web-staging' \
    ADMIN_PM2_NAME='irexpro-admin-staging' \
    LOCAL_API_LIVE_URL='http://local.test/api/live' \
    LOCAL_API_READY_URL='http://local.test/api/ready' \
    LOCAL_API_HEALTH_URL='http://local.test/api/health' \
    LOCAL_WEB_URL='http://local.test/web' \
    LOCAL_ADMIN_URL='http://local.test/admin' \
    PUBLIC_API_LIVE_URL='https://public.test/api/live' \
    PUBLIC_API_READY_URL='https://public.test/api/ready' \
    PUBLIC_WEB_URL='https://public.test/web' \
    PUBLIC_ADMIN_URL='https://public.test/admin' \
    AI_HEALTH_URL='http://local.test/ai/health' \
    MAX_HEALTH_ATTEMPTS=1 \
    HEALTH_RETRY_SECONDS=0 \
    bash "$SCRIPT_DIR/rollback-staging.sh" "$failed_sha" "$rollback_sha"
}

bash -n "$SCRIPT_DIR/deploy-staging.sh"
bash -n "$SCRIPT_DIR/rollback-staging.sh"

expect_failure 'Usage:' bash "$SCRIPT_DIR/deploy-staging.sh"
expect_failure 'full lowercase commit SHA' bash "$SCRIPT_DIR/deploy-staging.sh" main
expect_failure 'Usage:' bash "$SCRIPT_DIR/rollback-staging.sh"
expect_failure 'must differ' bash "$SCRIPT_DIR/rollback-staging.sh" \
  1111111111111111111111111111111111111111 \
  1111111111111111111111111111111111111111

make_fixture 'bad-sha'
git -C "$FIXTURE_REPO" switch --quiet --detach "$FIXTURE_PRIOR_SHA"
expect_failure 'Candidate commit is unavailable' run_deploy 9999999999999999999999999999999999999999

make_fixture 'dirty-tree'
git -C "$FIXTURE_REPO" switch --quiet --detach "$FIXTURE_PRIOR_SHA"
printf 'dirty\n' > "$FIXTURE_REPO/untracked.txt"
expect_failure 'Working tree is not clean' run_deploy "$FIXTURE_CANDIDATE_SHA"
[[ ! -s "$COMMAND_LOG" ]] || fail 'Dirty-tree rejection must happen before install/build/restart commands.'

make_fixture 'unexpected-origin'
git -C "$FIXTURE_REPO" switch --quiet --detach "$FIXTURE_PRIOR_SHA"
git -C "$FIXTURE_REPO" remote set-url origin 'https://github.com/Chrix4u/irexpro-lookalike.git'
expect_failure 'Unexpected origin repository' run_deploy "$FIXTURE_CANDIDATE_SHA"
[[ ! -s "$COMMAND_LOG" ]] || fail 'Unexpected-origin rejection must happen before install/build/restart commands.'

make_fixture 'stale-owner-origin'
git -C "$FIXTURE_REPO" switch --quiet --detach "$FIXTURE_PRIOR_SHA"
git -C "$FIXTURE_REPO" remote set-url origin 'https://github.com/christianagbotah/irexpro.git'
expect_failure 'Unexpected origin repository' run_deploy "$FIXTURE_CANDIDATE_SHA"
[[ ! -s "$COMMAND_LOG" ]] || fail 'Stale-owner origin rejection must happen before install/build/restart commands.'

make_fixture 'node-major-mismatch'
git -C "$FIXTURE_REPO" switch --quiet --detach "$FIXTURE_PRIOR_SHA"
expect_failure 'Node.js major version does not match the verified release baseline' run_deploy "$FIXTURE_CANDIDATE_SHA" FAKE_NODE_MAJOR=20
[[ ! -s "$COMMAND_LOG" ]] || fail 'Node-major rejection must happen before install/build/restart commands.'

make_fixture 'build-failure'
git -C "$FIXTURE_REPO" switch --quiet --detach "$FIXTURE_PRIOR_SHA"
expect_failure 'failed_stage=build-api' run_deploy "$FIXTURE_CANDIDATE_SHA" FAKE_BUILD_FAILURE=api
if grep -q '^pm2 ' "$COMMAND_LOG"; then
  fail 'Runtime mutation occurred even though the API build failed.'
fi

grep -q '@irexpro/api build' "$COMMAND_LOG" || fail 'API build was not attempted.'
if grep -q '@irexpro/web build' "$COMMAND_LOG"; then
  fail 'Web build must not continue after an API build failure.'
fi

make_fixture 'readiness-failure'
git -C "$FIXTURE_REPO" switch --quiet --detach "$FIXTURE_PRIOR_SHA"
expect_failure 'failed_stage=api-readiness' run_deploy "$FIXTURE_CANDIDATE_SHA" FAKE_READY_FAILURE=1
grep -q '^pm2 restart irexpro-api-staging ' "$COMMAND_LOG" || fail 'API was not restarted before readiness verification.'
if grep -q '^pm2 restart irexpro-web-staging ' "$COMMAND_LOG" || grep -q '^pm2 restart irexpro-admin-staging ' "$COMMAND_LOG"; then
  fail 'Web/Admin restart occurred after API readiness failure.'
fi

make_fixture 'web-startup-retry'
git -C "$FIXTURE_REPO" switch --quiet --detach "$FIXTURE_PRIOR_SHA"
retry_output="$(run_deploy "$FIXTURE_CANDIDATE_SHA" FAKE_WEB_CONNECT_FAILURES=1 MAX_HEALTH_ATTEMPTS=2)"
[[ "$retry_output" == *'STAGING DEPLOYMENT VERIFIED'* ]] || fail 'Transient web startup failure was not recovered by bounded smoke retries.'
web_attempt_count="$(grep -F -c 'http://local.test/web' "$COMMAND_LOG" || true)"
[[ "$web_attempt_count" -eq 2 ]] || fail 'Transient web startup regression test did not exercise exactly one retry.'

make_fixture 'successful-deploy'
git -C "$FIXTURE_REPO" switch --quiet --detach "$FIXTURE_PRIOR_SHA"
deploy_output="$(run_deploy "$FIXTURE_CANDIDATE_SHA")"
[[ "$deploy_output" == *'STAGING DEPLOYMENT VERIFIED'* ]] || fail 'Successful deploy evidence marker missing.'
[[ "$(git -C "$FIXTURE_REPO" rev-parse HEAD)" == "$FIXTURE_CANDIDATE_SHA" ]] || fail 'Successful deploy did not finish on the exact candidate SHA.'
grep -q '@irexpro/api build' "$COMMAND_LOG" || fail 'API build missing.'
grep -q '@irexpro/web build' "$COMMAND_LOG" || fail 'Web build missing.'
grep -q '@irexpro/admin build' "$COMMAND_LOG" || fail 'Admin build missing.'

make_fixture 'rollback-verification'
rollback_output="$(run_rollback "$FIXTURE_CANDIDATE_SHA" "$FIXTURE_PRIOR_SHA")"
[[ "$rollback_output" == *'STAGING ROLLBACK VERIFIED'* ]] || fail 'Rollback evidence marker missing.'
[[ "$rollback_output" == *"failed_sha=$FIXTURE_CANDIDATE_SHA"* ]] || fail 'Rollback evidence omitted failed SHA.'
[[ "$rollback_output" == *"rollback_sha=$FIXTURE_PRIOR_SHA"* ]] || fail 'Rollback evidence omitted rollback SHA.'
[[ "$(git -C "$FIXTURE_REPO" rev-parse HEAD)" == "$FIXTURE_PRIOR_SHA" ]] || fail 'Rollback did not finish on the exact rollback SHA.'

printf 'Deployment script safety tests passed.\n'
