#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly REPO_ROOT
WORKFLOW="$REPO_ROOT/.github/workflows/staging-deploy.yml"

fail() {
  printf 'TEST FAILURE: %s\n' "$1" >&2
  exit 1
}

# The following assertions intentionally search for literal shell expressions
# inside the workflow source; expansion would make the regression ineffective.
# shellcheck disable=SC2016
grep -Fq 'bootstrap_script="$(mktemp)"' "$WORKFLOW" ||
  fail 'Staging CD must create an out-of-tree bootstrap script.'

# shellcheck disable=SC2016
grep -Fq 'git show "${candidate_sha}:scripts/deployment/deploy-staging.sh" > "$bootstrap_script"' "$WORKFLOW" ||
  fail 'Staging CD must extract deploy-staging.sh from the authorized candidate SHA.'

# shellcheck disable=SC2016
grep -Fq 'bash "$bootstrap_script" "$candidate_sha"' "$WORKFLOW" ||
  fail 'Staging CD must execute the extracted candidate deployment script.'

# shellcheck disable=SC2016
if grep -Fq 'bash scripts/deployment/deploy-staging.sh "$candidate_sha"' "$WORKFLOW"; then
  fail 'Staging CD must not assume the currently deployed checkout already contains deploy-staging.sh.'
fi

printf 'Staging CD bootstrap regression tests passed.\n'
