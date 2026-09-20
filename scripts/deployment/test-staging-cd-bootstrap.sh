#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
readonly REPO_ROOT
WORKFLOW="$REPO_ROOT/.github/workflows/staging-deploy.yml"
RESEARCH_WORKFLOW="$REPO_ROOT/.github/workflows/six-pair-research-run.yml"

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

# Staging deploy and model research share one mutable VPS checkout. They must
# never run concurrently or cancel the active checkout owner.
deploy_lock_count="$(grep -F -c 'group: irexpro-staging-worktree' "$WORKFLOW" || true)"
research_lock_count="$(grep -F -c 'group: irexpro-staging-worktree' "$RESEARCH_WORKFLOW" || true)"
[[ "$deploy_lock_count" -eq 1 ]] ||
  fail 'Staging Deploy must hold the shared staging-worktree concurrency lock.'
[[ "$research_lock_count" -eq 1 ]] ||
  fail 'Six Pair Research must hold the shared staging-worktree concurrency lock.'

grep -Fq 'cancel-in-progress: false' "$WORKFLOW" ||
  fail 'Staging Deploy must never cancel an active staging-worktree owner.'
grep -Fq 'cancel-in-progress: false' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must never cancel an active staging-worktree owner.'

# Expensive research is lineage-aware: irrelevant deploys skip retraining, while
# operators retain an explicit manual rerun path.
grep -Fq 'workflow_dispatch:' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must retain a manual rerun trigger.'
grep -Fq 'last-research-sha' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must persist the evaluated-SHA lineage marker.'
grep -Fq 'id: relevance' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must classify research relevance before the heavy run.'
grep -Fq "if: steps.relevance.outputs.run == 'true'" "$RESEARCH_WORKFLOW" ||
  fail 'The expensive six-pair step must be guarded by the relevance decision.'

# When there is no successful research lineage yet, irrelevant deploys may
# skip the heavy study but must leave the marker absent so the next relevant
# model/training change is still forced to research.
# shellcheck disable=SC2016
grep -Fq 'changed_files="$(git diff --name-only "$parent_sha" "$candidate_sha")"' "$RESEARCH_WORKFLOW" ||
  fail 'Unbaselined research relevance must inspect the candidate parent diff.'
grep -Fq 'do NOT launch the' "$RESEARCH_WORKFLOW" ||
  fail 'Research workflow must document the unbaselined irrelevant-deploy path.'

printf 'Staging CD bootstrap and research-coordination regression tests passed.\n'
