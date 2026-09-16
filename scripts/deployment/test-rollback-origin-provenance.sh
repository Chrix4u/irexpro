#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
TMP_ROOT="$(mktemp -d)"
readonly TMP_ROOT
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'TEST FAILURE: %s\n' "$1" >&2
  exit 1
}

expect_rollback_origin_rejection() {
  local name="$1"
  local remote_url="$2"
  local root="$TMP_ROOT/$name"
  local repo="$root/repo"

  mkdir -p "$repo/scripts/deployment"
  git -C "$repo" init --quiet --initial-branch=main
  git -C "$repo" config user.email 'ci@example.invalid'
  git -C "$repo" config user.name 'Rollback Origin Safety CI'

  cp "$SCRIPT_DIR/deploy-staging.sh" "$repo/scripts/deployment/deploy-staging.sh"
  cp "$SCRIPT_DIR/rollback-staging.sh" "$repo/scripts/deployment/rollback-staging.sh"

  printf 'prior\n' > "$repo/release-marker.txt"
  git -C "$repo" add .
  git -C "$repo" commit --quiet -m 'fixture: prior release'
  local prior_sha
  prior_sha="$(git -C "$repo" rev-parse HEAD)"

  printf 'candidate\n' > "$repo/release-marker.txt"
  git -C "$repo" add release-marker.txt
  git -C "$repo" commit --quiet -m 'fixture: failed candidate'
  local failed_sha
  failed_sha="$(git -C "$repo" rev-parse HEAD)"

  git -C "$repo" remote add origin "$remote_url"

  local output
  if output="$(STAGING_ROOT="$repo" bash "$SCRIPT_DIR/rollback-staging.sh" "$failed_sha" "$prior_sha" 2>&1)"; then
    fail "Rollback unexpectedly accepted unapproved origin: $remote_url"
  fi

  [[ "$output" == *'Unexpected origin repository.'* ]] ||
    fail "Rollback rejection for $remote_url did not report the origin-provenance hold."
  [[ "$output" == *'failed_stage=rollback-preflight'* ]] ||
    fail "Rollback rejection for $remote_url did not occur during preflight."
  [[ "$(git -C "$repo" rev-parse HEAD)" == "$failed_sha" ]] ||
    fail "Rollback origin rejection mutated the checkout for $remote_url."
}

bash -n "$SCRIPT_DIR/rollback-staging.sh"

expect_rollback_origin_rejection \
  'lookalike-origin' \
  'https://github.com/Chrix4u/irexpro-lookalike.git'

expect_rollback_origin_rejection \
  'stale-owner-origin' \
  'https://github.com/christianagbotah/irexpro.git'

printf 'Rollback origin provenance tests passed.\n'
