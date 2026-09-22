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
[[ "$deploy_lock_count" -eq 1 ]] ||
  fail 'Staging Deploy must hold the shared staging-worktree concurrency lock.'

# The lock must be job-level, not workflow-level. Trigger events whose job
# condition evaluates false must never consume/cancel the shared pending slot.
deploy_top_level_concurrency="$(grep -c '^concurrency:' "$WORKFLOW" || true)"
deploy_job_level_concurrency="$(grep -c '^    concurrency:' "$WORKFLOW" || true)"
[[ "$deploy_top_level_concurrency" -eq 0 ]] ||
  fail 'Staging Deploy concurrency must not be workflow-level.'
[[ "$deploy_job_level_concurrency" -eq 1 ]] ||
  fail 'Staging Deploy must acquire the shared lock at job level.'

grep -Fq 'cancel-in-progress: true' "$WORKFLOW" ||
  fail 'Staging Deploy must preempt stale work when a newer verified main SHA is ready.'

# ---------------------------------------------------------------------------
# Research Resilience V2 architecture invariants.
#
# The research workflow is a chain of bounded, independently resumable stage
# jobs. These assertions prove the properties that keep it safe under the
# GitHub-hosted six-hour job ceiling.
# ---------------------------------------------------------------------------

# 1. Every VPS-touching job must hold the shared staging-worktree lock at job
#    level, and must never cancel an active owner.
research_top_level_concurrency="$(grep -c '^concurrency:' "$RESEARCH_WORKFLOW" || true)"
[[ "$research_top_level_concurrency" -eq 0 ]] ||
  fail 'Six Pair Research concurrency must not be workflow-level.'

vps_job_count="$(python3 - "$RESEARCH_WORKFLOW" <<'PY'
import sys, yaml
data = yaml.safe_load(open(sys.argv[1]))
print(sum(1 for job in data["jobs"].values() if "concurrency" in job))
PY
)"
lock_count="$(grep -F -c 'group: irexpro-staging-worktree' "$RESEARCH_WORKFLOW" || true)"
[[ "$lock_count" -ge 12 ]] ||
  fail 'Six Pair Research must hold the shared staging-worktree lock in every stage job.'
[[ "$lock_count" -eq "$vps_job_count" ]] ||
  fail "Six Pair Research lock count ($lock_count) must equal its VPS-touching job count ($vps_job_count)."

research_cancel_false="$(grep -F -c 'cancel-in-progress: false' "$RESEARCH_WORKFLOW" || true)"
[[ "$research_cancel_false" -eq "$vps_job_count" ]] ||
  fail 'Every Six Pair Research stage job must use cancel-in-progress: false.'

# 2. No job may rely on surviving the GitHub-hosted six-hour ceiling, and the
#    monolithic >6h timeout is prohibited.
timeout_over_ceiling="$(python3 - "$RESEARCH_WORKFLOW" <<'PY'
import sys, yaml
data = yaml.safe_load(open(sys.argv[1]))
bad = [
    (name, job.get("timeout-minutes"))
    for name, job in data["jobs"].items()
    if not isinstance(job.get("timeout-minutes"), int)
    or job["timeout-minutes"] > 360
]
for name, value in bad:
    print(f"{name}={value}")
PY
)"
[[ -z "$timeout_over_ceiling" ]] ||
  fail "Research jobs must declare timeout-minutes <= 360 (violations: $timeout_over_ceiling)."
if grep -Eq 'timeout-minutes: *(4[3-9][0-9]|[5-9][0-9][0-9])' "$RESEARCH_WORKFLOW"; then
  fail 'Six Pair Research must not retain a monolithic >360 minute job timeout.'
fi

# 3. The single monolithic six-pair runner invocation is gone: collection is
#    split into one bounded job per pair and one bounded job per horizon.
runner_calls="$(grep -c "run_first_six_pair \\\\$" "$RESEARCH_WORKFLOW" || true)"
[[ "$runner_calls" -ge 11 ]] ||
  fail 'Expected at least 11 bounded runner invocations (init + 6 pairs + 3 horizons + summarize).'
for instrument in EURUSD GBPUSD USDJPY AUDUSD USDCAD USDCHF; do
  grep -Fq -- "--stage-instruments $instrument" "$RESEARCH_WORKFLOW" ||
    fail "Missing dedicated pair stage for $instrument."
done
for horizon in 1 5 10; do
  grep -Fq -- "--stage-horizons $horizon" "$RESEARCH_WORKFLOW" ||
    fail "Missing dedicated horizon stage for ${horizon}m."
done
grep -Fq -- '--stage init' "$RESEARCH_WORKFLOW" ||
  fail 'Missing the init stage that freezes the study cutoff and orchestration plan.'
grep -Fq -- '--stage summarize' "$RESEARCH_WORKFLOW" ||
  fail 'Missing the summarize stage that assembles the final study summary.'
monolithic_calls="$(python3 - "$RESEARCH_WORKFLOW" <<'PY'
import sys

lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
violations = []
for index, line in enumerate(lines, start=1):
    if line.rstrip().endswith("run_first_six_pair \\"):
        if index >= len(lines) or "--stage " not in lines[index]:
            violations.append(str(index))
print(",".join(violations))
PY
)"
[[ -z "$monolithic_calls" ]] ||
  fail "Every runner invocation must be stage-scoped; the monolithic study call is prohibited (violations at lines: $monolithic_calls)."

# 4. Stage boundaries and sequential execution: pair stages follow validate,
#    every horizon stage needs all six pair stages, selection needs all three
#    horizon stages, the final model needs the selection, promotion needs the
#    final model, and nothing runs collectors in a parallel matrix.
if grep -q '^    strategy:' "$RESEARCH_WORKFLOW"; then
  fail 'Six Pair Research must not fan out collectors through a parallel matrix.'
fi
stage_graph="$(python3 - "$RESEARCH_WORKFLOW" <<'PY'
import sys, yaml
data = yaml.safe_load(open(sys.argv[1]))
jobs = data["jobs"]
problems = []
pairs = [f"pair-{p.lower()}" for p in
         ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF"]]
horizons = [f"horizon-{h}m" for h in [1, 5, 10]]
for pair in pairs:
    if jobs.get(pair, {}).get("needs") != ["validate"]:
        problems.append(f"{pair} must need exactly [validate]")
for horizon in horizons:
    if set(jobs.get(horizon, {}).get("needs") or []) != set(pairs):
        problems.append(f"{horizon} must need all six pair stages")
for horizon in horizons:
    if jobs.get(horizon, {}).get("if") != "needs.validate.outputs.run == 'true'":
        problems.append(f"{horizon} must be gated on the relevance decision")
if set(jobs.get("select-horizon", {}).get("needs") or []) != set(horizons):
    problems.append("select-horizon must need all three horizon stages")
if "select-horizon" not in (jobs.get("final-model", {}).get("needs") or []):
    problems.append("final-model must need select-horizon")
if "final-model" not in (jobs.get("paper-promotion", {}).get("needs") or []):
    problems.append("paper-promotion must need final-model")
cleanup = jobs.get("cleanup", {})
if cleanup.get("if") != "${{ always() }}":
    problems.append("cleanup must run always")
print("; ".join(problems))
PY
)"
[[ -z "$stage_graph" ]] ||
  fail "Research stage graph is wrong: $stage_graph"

# 5. Superseded triggers and stages skip cleanly; expensive stages stay
#    guarded by the relevance decision and the exact-main check.
grep -Fq 'id: current' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must expose an exact-main current-candidate decision.'
grep -Fq 'RESEARCH_SKIPPED reason=deployed_candidate_superseded' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must report superseded deploy triggers as a clean skip.'
current_guard_count="$(grep -F -c "if: steps.current.outputs.current == 'true'" "$RESEARCH_WORKFLOW" || true)"
[[ "$current_guard_count" -ge 12 ]] ||
  fail 'Every research stage job must guard its VPS work on the exact-main decision.'
grep -Fq 'id: relevance' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must classify research relevance before the heavy run.'
grep -Fq "if: steps.relevance.outputs.run == 'true'" "$RESEARCH_WORKFLOW" ||
  fail 'The expensive research stages must be guarded by the relevance decision.'

# 6. Candidate integrity: the init stage is allowed to create the plan, while
#    every post-init stage must verify the exact candidate-bound plan before work.
init_stage_bypass_count="$(grep -F -c 'export IREXPRO_INIT_STAGE=1' "$RESEARCH_WORKFLOW" || true)"
[[ "$init_stage_bypass_count" -eq 1 ]] ||
  fail 'Exactly one research init stage must be allowed to create the orchestration plan.'
# shellcheck disable=SC2016
grep -Fq 'if [[ "${IREXPRO_INIT_STAGE:-0}" != "1" ]]; then' "$RESEARCH_WORKFLOW" ||
  fail 'The shared staged prologue must exempt only the init stage from the pre-existing-plan check.'
plan_holds="$(grep -F -c 'staged execution requires the orchestration plan' "$RESEARCH_WORKFLOW" || true)"
[[ "$plan_holds" -ge 6 ]] ||
  fail 'Every post-init stage must fail closed when the orchestration plan is missing.'
plan_mismatches="$(grep -F -c 'orchestration plan candidate mismatch' "$RESEARCH_WORKFLOW" || true)"
[[ "$plan_mismatches" -ge 6 ]] ||
  fail 'Every post-init stage must reject an orchestration plan bound to another candidate.'
safe_plan_env_count="$(grep -F -c 'IREXPRO_PLAN_PATH="$PLAN_PATH" node -e' "$RESEARCH_WORKFLOW" || true)"
[[ "$safe_plan_env_count" -ge 12 ]] ||
  fail 'Post-init plan readers must pass the readonly plan path through a distinct environment variable.'
if grep -Fq 'plan_candidate="$(PLAN_PATH="$PLAN_PATH" node -e' "$RESEARCH_WORKFLOW" ||
   grep -Fq 'bootstrap_root="$(PLAN_PATH="$PLAN_PATH" node -e' "$RESEARCH_WORKFLOW"; then
  fail 'A readonly PLAN_PATH must never be reused as a command-prefix environment assignment.'
fi

# 7. Expensive research is lineage-aware: irrelevant deploys skip retraining,
#    while operators retain an explicit manual rerun path.
grep -Fq 'workflow_dispatch:' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must retain a manual rerun trigger.'
grep -Fq 'last-research-sha' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must persist the evaluated-SHA lineage marker.'

# Without a successful/evaluated lineage, research must fail safe and retry.
# An unrelated later deploy must not hide a failed/timed-out model study.
grep -Fq 'No successful/evaluated research lineage exists yet. Fail safe:' "$RESEARCH_WORKFLOW" ||
  fail 'Research workflow must document fail-safe retry for an unresolved lineage.'
grep -Fq 'Retry until a research' "$RESEARCH_WORKFLOW" ||
  fail 'Research workflow must retain unresolved-lineage retry semantics.'

# 8. Long SSH-backed stages must emit periodic liveness evidence without
#    changing the stage process result. This keeps operators informed while
#    preserving the exact remote exit status.
grep -Fq 'RESEARCH_HEARTBEAT candidate=%s elapsed_seconds=%s' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must emit periodic progress heartbeats.'
# shellcheck disable=SC2016
grep -Fq 'if wait "$research_pid"; then' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must capture the remote research exit status explicitly.'
# shellcheck disable=SC2016
grep -Fq 'exit "$research_status"' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must return the original remote research status.'

# 9. Bounded CPU parallelism, progress telemetry, and verified same-candidate
#    checkpoint resume remain enabled for every stage. The bounded-worker
#    contract is the one recovered by PR #146 after Run #55 exited 137: the
#    historical fixed bound (xgb_n_jobs=4) proved too aggressive for the
#    shared staging host, so every training stage must stay within [1-4] and
#    each XGBoost stage must declare its own bounded worker count.
grep -Fq 'export IREXPRO_RESEARCH_PROGRESS=1' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must enable detailed stage/fold progress telemetry.'
grep -Eq 'export IREXPRO_XGB_N_JOBS=[1-4]' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must request bounded XGBoost CPU parallelism.'
if grep -Eq 'export IREXPRO_XGB_N_JOBS=([5-9]|[0-9]{2,})' "$RESEARCH_WORKFLOW"; then
  fail 'Six Pair Research must never configure an unbounded XGBoost worker count.'
fi
xgb_stage_exports="$(grep -E -c 'export IREXPRO_XGB_N_JOBS=[1-4]' "$RESEARCH_WORKFLOW" || true)"
[[ "$xgb_stage_exports" -ge 5 ]] ||
  fail "Every XGBoost training stage must declare its own bounded worker count (found $xgb_stage_exports of at least 5)."
grep -Fq 'recovery=run55_exit137' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must retain the Run #55 exit-137 recovery configuration provenance.'
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

# 10. Ancestor bootstrap stays guarded against data/corpus semantic changes
#     and remains a bounded first-parent search.
grep -Fq 'bootstrap_unsafe_pattern=' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must guard ancestor bootstrap against data/corpus semantic changes.'
grep -Fq 'git rev-list --first-parent --max-count=20' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must search bounded first-parent ancestry for resumable pair evidence.'
# shellcheck disable=SC2016
grep -Fq -- '--bootstrap-dir "$bootstrap_root"' "$RESEARCH_WORKFLOW" ||
  fail 'Six Pair Research must pass the validated ancestor bootstrap directory to the runner.'

# 11. Model promotion stays fail-closed: it must never enable live approval
#     and must re-verify that main has not moved before activation.
grep -Fq 'approved_for_live=false' "$RESEARCH_WORKFLOW" ||
  fail 'Research promotion must remain paper-only.'
grep -Fq 'reason=candidate_superseded_before_activation' "$RESEARCH_WORKFLOW" ||
  fail 'Research promotion must re-verify the candidate before runtime activation.'
grep -Fq 'approved_for_live !== false' "$RESEARCH_WORKFLOW" ||
  fail 'Research promotion must verify the runtime never reports a live-approved model.'

# 12. The cleanup job must only remove ephemeral runner material and must not
#     contain any duplicated research script.
cleanup_body="$(python3 - "$RESEARCH_WORKFLOW" <<'PY'
import sys, yaml
data = yaml.safe_load(open(sys.argv[1]))
steps = data["jobs"]["cleanup"]["steps"]
run = steps[-1].get("run", "")
print(len(run.strip().splitlines()))
PY
)"
[[ "$cleanup_body" -eq 1 ]] ||
  fail "The research cleanup job must only remove ephemeral SSH material (found $cleanup_body lines)."

printf 'Staging CD bootstrap and research-coordination regression tests passed.\n'
