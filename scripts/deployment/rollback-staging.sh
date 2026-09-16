#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly EXPECTED_HTTPS_ORIGIN="https://github.com/Chrix4u/irexpro.git"
readonly EXPECTED_SSH_ORIGIN="git@github.com:Chrix4u/irexpro.git"
readonly EXPECTED_SSH_URL_ORIGIN="ssh://git@github.com/Chrix4u/irexpro.git"

FAILED_SHA="unknown"
ROLLBACK_SHA="unknown"
STAGE="rollback-preflight"

utc_now() {
  date -u +'%Y-%m-%dT%H:%M:%SZ'
}

emit_failure_evidence() {
  local exit_code=$?
  printf 'STAGING ROLLBACK FAILED\n' >&2
  printf 'timestamp_utc=%s\n' "$(utc_now)" >&2
  printf 'failed_sha=%s\n' "$FAILED_SHA" >&2
  printf 'rollback_sha=%s\n' "$ROLLBACK_SHA" >&2
  printf 'failed_stage=%s\n' "$STAGE" >&2
  printf 'exit_code=%s\n' "$exit_code" >&2
}
trap emit_failure_evidence ERR

die() {
  printf 'ROLLBACK HOLD: %s\n' "$1" >&2
  return 1
}

[[ "$#" -eq 2 ]] || die "Usage: rollback-staging.sh <failed-sha> <rollback-sha>"
FAILED_SHA="$1"
ROLLBACK_SHA="$2"
readonly FAILED_SHA ROLLBACK_SHA

[[ "$FAILED_SHA" =~ ^[0-9a-f]{40}$ ]] || die "Failed candidate must be a full lowercase commit SHA."
[[ "$ROLLBACK_SHA" =~ ^[0-9a-f]{40}$ ]] || die "Rollback target must be a full lowercase commit SHA."
[[ "$FAILED_SHA" != "$ROLLBACK_SHA" ]] || die "Rollback target must differ from the failed candidate."
[[ -n "${STAGING_ROOT:-}" ]] || die "STAGING_ROOT is required."

cd "$STAGING_ROOT"
[[ "$(git rev-parse --show-toplevel)" == "$STAGING_ROOT" ]] || die "STAGING_ROOT is not the repository root."
[[ -z "$(git status --porcelain)" ]] || die "Working tree is not clean."
[[ "$(git rev-parse HEAD)" == "$FAILED_SHA" ]] || die "Current checkout does not match the declared failed candidate."

# Issue #18: rollback must establish repository provenance BEFORE it trusts
# origin/main for either fetch or rollback-target selection. A stale owner,
# lookalike repository, or any unapproved remote fails closed before network
# activity or runtime mutation. Keep this allowlist identical to deploy-staging.sh.
remote_url="$(git config --get remote.origin.url || true)"
case "$remote_url" in
  "$EXPECTED_HTTPS_ORIGIN"|"$EXPECTED_SSH_ORIGIN"|"$EXPECTED_SSH_URL_ORIGIN") ;;
  *) die "Unexpected origin repository." ;;
esac

STAGE="rollback-target-verification"
git fetch --quiet origin main
git cat-file -e "${ROLLBACK_SHA}^{commit}" 2>/dev/null || die "Rollback commit is unavailable."
git merge-base --is-ancestor "$ROLLBACK_SHA" "$FAILED_SHA" || die "Rollback target is not an ancestor of the failed candidate."
git merge-base --is-ancestor "$ROLLBACK_SHA" origin/main || die "Rollback target is not contained in origin/main."

STAGE="rollback-deployment"
script_path="$(mktemp)"
trap 'rm -f "$script_path"' EXIT
git show "${FAILED_SHA}:scripts/deployment/deploy-staging.sh" > "$script_path"
chmod 700 "$script_path"
"$script_path" "$ROLLBACK_SHA"

STAGE="rollback-final-sha-verification"
[[ "$(git rev-parse HEAD)" == "$ROLLBACK_SHA" ]] || die "Rollback exact-SHA verification failed."

trap - ERR
printf 'STAGING ROLLBACK VERIFIED\n'
printf 'timestamp_utc=%s\n' "$(utc_now)"
printf 'failed_sha=%s\n' "$FAILED_SHA"
printf 'rollback_sha=%s\n' "$ROLLBACK_SHA"
