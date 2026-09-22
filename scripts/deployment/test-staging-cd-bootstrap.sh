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

# Staging deploy and model research share one mutable VPS checkout and must
# never run concurrently. A newer verified main deploy may preempt research
# bound to an older SHA because that research is no longer promotion-eligible.
# Research itself must not cancel an active checkout owner.
deploy_lock_count="$(grep -F -c 'group: irexpro-staging-worktree' "$WORKFLOW" || true)"
research_lock_count="$(grep -F -c 'group: irexpro-staging-worktree' "$RESEARCH_WORKFLOW" || true)"
[[ "$deploy_lock_count" -eq 1 ]] ||
  fail 'Staging Deploy must hold the shared staging-worktree concurrency lock.'
[[ "$research_lock_count" -eq 1 ]] ||
  fail 'Six Pair Research must hold the shared staging-worktree concurrency lock.'

# The lock must be job-level, not workflow-level. Trigger events whose job
# condition evaluates false must never consume/cancel the shared pending slot.
deploy_top_level_concurrency="$(grep -c '^concurrency:' "$WORKFLOW" || true)"
research_top_level_concurrency="$(grep -c '^concurrency:' "$RESEARCH_WORKFLOW" || true)"
deploy_job_level_concurrency="$(grep -c '^    concurrency:' "$WORKFLOW" || true)"
research_job_level_concurrency="$(grep -c '^    concurrency:' "$RESEARCH_WORKFLOW" || true)"
[[ "$deploy_top_level_concurrency" -eq 0 ]] ||
  fail 'Staging Deploy concurrency must not be workflow-level.'
[[ "$research_top_level_concurrency" -eq 0 ]] ||
  fail 'Six Pair Research concurrency must not be workflow-level.'
[[ "$deploy_job_level_concurrency" -eq 1 ]] ||
  fail 'Staging Deploy must acquire the shared lock at job level.'
[[ "$research_job_level_concurrency" -eq 1 ]] ||
  fail 'Six Pair Research must acquire the shared lock at job level.'

grep -Fq 'cancel-in-progress: true' "$WORKFLOW" ||
  fail 'Staging Deploy must preempt stale work when a newer verified main SHA is ready.'
grep -Fq 'cancel-in-progress: false' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must never cancel an active staging-worktree owner.'

# A successful staging deploy can finish after main has already advanced.
# That stale workflow_run event is expected and must skip cleanly instead of
# creating a red research failure for a candidate that is no longer promotable.
grep -Fq 'id: current' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must expose an exact-main current-candidate decision.'
grep -Fq 'RESEARCH_SKIPPED reason=deployed_candidate_superseded' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must report superseded deploy triggers as a clean skip.'
grep -Fq "if: steps.current.outputs.current == 'true'" "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must not configure remote research after a stale-trigger skip.'

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

# Without a successful/evaluated lineage, research must fail safe and retry.
# An unrelated later deploy must not hide a failed/timed-out model study.
grep -Fq 'No successful/evaluated research lineage exists yet. Fail safe:' "$RESEARCH_WORKFLOW" ||
  fail 'Research workflow must document fail-safe retry for an unresolved lineage.'
grep -Fq 'Retry until a research' "$RESEARCH_WORKFLOW" ||
  fail 'Research workflow must retain unresolved-lineage retry semantics.'

# Long SSH-backed research must emit periodic liveness evidence without
# changing the research process result. This keeps operators informed while
# preserving the exact remote exit status.
grep -Fq 'RESEARCH_HEARTBEAT candidate=%s elapsed_seconds=%s' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must emit periodic progress heartbeats.'
# shellcheck disable=SC2016
grep -Fq 'if wait "$research_pid"; then' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must capture the remote research exit status explicitly.'
# shellcheck disable=SC2016
grep -Fq 'exit "$research_status"' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must return the original remote research status.'

# The first 100k-row-per-pair run hit the old five-hour ceiling. Preserve a
# finite seven-hour safeguard while bounded CPU parallelism and detailed
# progress telemetry make the next run faster and diagnosable.
grep -Fq 'timeout-minutes: 420' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must retain the seven-hour bounded timeout.'
grep -Fq 'export IREXPRO_RESEARCH_PROGRESS=1' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must enable detailed stage/fold progress telemetry.'
grep -Eq 'export IREXPRO_XGB_N_JOBS=[1-4]' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must request bounded XGBoost CPU parallelism.'
# shellcheck disable=SC2016
grep -Fq 'export IREXPRO_RESEARCH_CANDIDATE_SHA="$candidate_sha"' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must bind resume checkpoints to the exact candidate SHA.'
grep -Fq -- '--resume' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must enable verified same-candidate checkpoint resume.'
# shellcheck disable=SC2016
if grep -Fq 'rm -rf "$OUTPUT_ROOT"' "$RESEARCH_WORKFLOW"; then
  fail 'Six Pair Research must not delete same-candidate checkpoints before a retry.'
fi
grep -Fq 'run-result.json.tmp' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must write the top-level result atomically.'
grep -Fq 'bootstrap_unsafe_pattern=' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must guard ancestor bootstrap against data/corpus semantic changes.'
grep -Fq 'git rev-list --first-parent --max-count=20' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must search bounded first-parent ancestry for resumable pair evidence.'
# shellcheck disable=SC2016
grep -Fq -- '--bootstrap-dir "$bootstrap_root"' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must pass the validated ancestor bootstrap directory to the runner.'

printf 'Staging CD bootstrap and research-coordination regression tests passed.\n'
 "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must request bounded XGBoost CPU parallelism (1..4 workers).'
# shellcheck disable=SC2016
grep -Fq 'export IREXPRO_RESEARCH_CANDIDATE_SHA="$candidate_sha"' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must bind resume checkpoints to the exact candidate SHA.'
grep -Fq -- '--resume' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must enable verified same-candidate checkpoint resume.'
# shellcheck disable=SC2016
if grep -Fq 'rm -rf "$OUTPUT_ROOT"' "$RESEARCH_WORKFLOW"; then
  fail 'Six Pair Research must not delete same-candidate checkpoints before a retry.'
fi
grep -Fq 'run-result.json.tmp' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must write the top-level result atomically.'
grep -Fq 'bootstrap_unsafe_pattern=' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must guard ancestor bootstrap against data/corpus semantic changes.'
grep -Fq 'git rev-list --first-parent --max-count=20' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must search bounded first-parent ancestry for resumable pair evidence.'
# shellcheck disable=SC2016
grep -Fq -- '--bootstrap-dir "$bootstrap_root"' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must pass the validated ancestor bootstrap directory to the runner.'

printf 'Staging CD bootstrap and research-coordination regression tests passed.\n'
