#!/usr/bin/env python3
"""Generate .github/workflows/six-pair-research-run.yml (Research Resilience V2).

Authoring tool only: emits the committed workflow with consistent per-stage
job bodies. The generated file is checked in; this script is not run in CI.
"""
from __future__ import annotations

PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF"]
HORIZONS = ["1", "5", "10"]

CHECKOUT = """      - name: Checkout exact deployed candidate
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          ref: ${{ env.CANDIDATE_SHA }}
          persist-credentials: false

      - name: Verify exact current main
        id: current
        shell: bash
        run: |
          set -Eeuo pipefail
          [[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]
          git fetch --quiet --no-tags origin main
          test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"

          current_main_sha="$(git rev-parse origin/main)"
          if [[ "$current_main_sha" != "$CANDIDATE_SHA" ]]; then
            printf 'current=false\\n' >> "$GITHUB_OUTPUT"
            printf 'RESEARCH_SKIPPED reason=deployed_candidate_superseded candidate=%s current_main=%s\\n' \\
              "$CANDIDATE_SHA" "$current_main_sha"
            exit 0
          fi

          printf 'current=true\\n' >> "$GITHUB_OUTPUT"
"""

SSH_CONFIG = """      - name: Configure pinned SSH identity
        if: steps.current.outputs.current == 'true'
        shell: bash
        run: |
          set -Eeuo pipefail
          test -n "$STAGING_SSH_USER"
          test -n "$SSH_PRIVATE_KEY"
          test -n "$SSH_KNOWN_HOSTS"
          umask 077
          install -d -m 700 "$HOME/.ssh"
          printf '%s\\n' "$SSH_PRIVATE_KEY" > "$HOME/.ssh/irexpro_staging"
          printf '%s\\n' "$SSH_KNOWN_HOSTS" > "$HOME/.ssh/known_hosts"
          chmod 600 "$HOME/.ssh/irexpro_staging" "$HOME/.ssh/known_hosts"
"""

SSH_REMOVE = """      - name: Remove ephemeral SSH material
        if: ${{ always() }}
        shell: bash
        run: |
          rm -f "$HOME/.ssh/irexpro_staging" "$HOME/.ssh/known_hosts"
"""

# Remote prologue shared by every VPS-touching stage: verify the exact
# candidate worktree, free disk, resolve the pinned virtual environment,
# and fail closed unless the orchestration plan was initialized for this
# exact candidate SHA by the validate stage.
STAGE_PROLOGUE = """          set -Eeuo pipefail
          umask 077

          candidate_sha="$1"
          [[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] || {
            printf 'RESEARCH HOLD: invalid candidate SHA.\\n' >&2
            exit 2
          }

          readonly STAGING_ROOT='/home/lightworld/webapps/irexpro-staging'
          readonly RESEARCH_ROOT='/home/lightworld/research/irexpro-six-pair'
          readonly OUTPUT_ROOT="$RESEARCH_ROOT/$candidate_sha"
          readonly DUKASCOPY_CACHE="/home/lightworld/research/dukascopy-raw-cache"

          cd "$STAGING_ROOT"
          test "$(git rev-parse --show-toplevel)" = "$STAGING_ROOT"
          test "$(git rev-parse HEAD)" = "$candidate_sha"
          test -z "$(git status --porcelain)"

          available_kb="$(df -Pk "$STAGING_ROOT" | awk 'NR==2 {print $4}')"
          [[ "$available_kb" =~ ^[0-9]+$ ]]
          if (( available_kb < 2097152 )); then
            printf 'RESEARCH HOLD: less than 2 GiB free disk space on staging.\\n' >&2
            exit 3
          fi

          python_bin=''
          for candidate in \\
            "$STAGING_ROOT/services/ai-engine/.venv/bin/python" \\
            "$STAGING_ROOT/services/ai-engine/venv/bin/python"; do
            if [[ -x "$candidate" ]]; then
              python_bin="$candidate"
              break
            fi
          done
          [[ -n "$python_bin" ]] || {
            printf 'RESEARCH HOLD: AI Python virtual environment was not found.\\n' >&2
            exit 15
          }

          # WS8: every post-init stage verifies the same candidate identity
          # that the validate/init stage froze into the orchestration plan.
          # The init stage is the sole exception because its purpose is to
          # create that plan. The runner still verifies the persisted study
          # fingerprint before any later stage consumes state.
          readonly PLAN_PATH="$OUTPUT_ROOT/checkpoints/orchestration-plan.json"
          bootstrap_root=''
          bootstrap_args=()
          if [[ "${IREXPRO_INIT_STAGE:-0}" != "1" ]]; then
            test -s "$PLAN_PATH" || {
              printf 'RESEARCH HOLD: staged execution requires the orchestration plan.\\n' >&2
              exit 21
            }
            plan_candidate="$(IREXPRO_PLAN_PATH="$PLAN_PATH" node -e '
              const fs = require("fs");
              const plan = JSON.parse(fs.readFileSync(process.env.IREXPRO_PLAN_PATH, "utf8"));
              if (plan.plan_version !== 1) process.exit(1);
              process.stdout.write(String(plan.candidate_sha || ""));
            ')" || {
              printf 'RESEARCH HOLD: orchestration plan is unreadable.\\n' >&2
              exit 22
            }
            test "$plan_candidate" = "$candidate_sha" || {
              printf 'RESEARCH HOLD: orchestration plan candidate mismatch plan=%s candidate=%s\\n' \\
                "$plan_candidate" "$candidate_sha" >&2
              exit 23
            }

            bootstrap_root="$(IREXPRO_PLAN_PATH="$PLAN_PATH" node -e '
              const fs = require("fs");
              const plan = JSON.parse(fs.readFileSync(process.env.IREXPRO_PLAN_PATH, "utf8"));
              const bootstrap = plan.bootstrap_dir;
              process.stdout.write(bootstrap && bootstrap !== "None" ? String(bootstrap) : "");
            ')"
            if [[ -n "$bootstrap_root" ]]; then
              bootstrap_args=(--bootstrap-dir "$bootstrap_root")
            fi
          fi

          cd "$STAGING_ROOT/services/ai-engine"
          export PYTHONPATH="$PWD"
          export IREXPRO_RESEARCH_PROGRESS=1
          export IREXPRO_RESEARCH_CANDIDATE_SHA="$candidate_sha"
"""

# The heartbeat/watchdog wrapper for one expensive stage: the remote stage
# runs in the background, a local watchdog prints liveness heartbeats and
# aborts the stage early when main has moved past the candidate, and the
# original remote exit status is always returned.
WATCHDOG_RUN = """          research_pid=$!
          superseded_marker="$RUNNER_TEMP/irexpro-research-superseded"
          rm -f "$superseded_marker"

          (
            while kill -0 "$research_pid" 2>/dev/null; do
              sleep 60
              if ! kill -0 "$research_pid" 2>/dev/null; then
                break
              fi

              heartbeat_now="$(date +%s)"
              heartbeat_elapsed=$((heartbeat_now - research_started_epoch))
              printf 'RESEARCH_HEARTBEAT candidate=%s elapsed_seconds=%s\\n' \\
                "$CANDIDATE_SHA" "$heartbeat_elapsed"

              # A model/training commit can move main while this bounded
              # stage is still collecting data or evaluating folds. Abort the
              # stage early so newer exact-main work does not wait on
              # obsolete research; the remaining stages skip cleanly and a
              # future run resumes from the persisted verified state.
              if ! git fetch --quiet --no-tags origin main; then
                printf 'RESEARCH_WATCHDOG_WARNING candidate=%s reason=main_fetch_failed\\n' \\
                  "$CANDIDATE_SHA" >&2
                continue
              fi

              current_main_sha="$(git rev-parse origin/main)"
              if [[ "$current_main_sha" != "$CANDIDATE_SHA" ]]; then
                printf 'RESEARCH_ABORT reason=candidate_superseded candidate=%s current_main=%s\\n' \\
                  "$CANDIDATE_SHA" "$current_main_sha"
                : > "$superseded_marker"
                kill -TERM "$research_pid" 2>/dev/null || true
                sleep 5
                kill -KILL "$research_pid" 2>/dev/null || true
                break
              fi
            done
          ) &
          watchdog_pid=$!

          if wait "$research_pid"; then
            research_status=0
          else
            research_status=$?
          fi

          kill "$watchdog_pid" 2>/dev/null || true
          wait "$watchdog_pid" 2>/dev/null || true

          research_finished_epoch="$(date +%s)"
          research_elapsed=$((research_finished_epoch - research_started_epoch))

          if [[ -f "$superseded_marker" ]]; then
            rm -f "$superseded_marker"
            printf 'RESEARCH_PROCESS_EXIT candidate=%s status=0 elapsed_seconds=%s reason=candidate_superseded\\n' \\
              "$CANDIDATE_SHA" "$research_elapsed"
            exit 0
          fi

          printf 'RESEARCH_PROCESS_EXIT candidate=%s status=%s elapsed_seconds=%s\\n' \\
            "$CANDIDATE_SHA" "$research_status" "$research_elapsed"
          exit "$research_status"
"""

COMMON_RUNNER_ARGS = """ \\
            --source dukascopy \\
            --dukascopy-cache-dir "$DUKASCOPY_CACHE" \\
            --dukascopy-max-lookback-days "$DUKASCOPY_LOOKBACK_DAYS" \\
            --output-dir "$OUTPUT_ROOT" \\
            --target-rows "$TARGET_ROWS" \\
            --horizons 1,5,10 \\
            --confidence-threshold 0.60 \\
            --commission-bps 0 \\
            --slippage-bps 0 \\
            --max-splits 5 \\
            --resume"""

STUDY_CONSTANTS_REMOTE = """          readonly TARGET_ROWS=100000
          readonly DUKASCOPY_LOOKBACK_DAYS=180
          [[ "$TARGET_ROWS" =~ ^[0-9]+$ ]] && (( TARGET_ROWS >= 100000 )) || {
            printf 'RESEARCH HOLD: invalid evidence target rows: %s\\n' "$TARGET_ROWS" >&2
            exit 20
          }
"""


def pair_job(instrument: str, previous_job: str | None = None) -> str:
    job_id = f"pair-{instrument.lower()}"
    needs = "validate" if previous_job is None else f"validate, {previous_job}"
    return f"""  {job_id}:
    name: Pair stage {instrument}
    needs: [{needs}]
    if: needs.validate.outputs.run == 'true'
    # Every VPS-touching stage holds the shared staging-worktree lock. A
    # pending stage is never allowed to cancel an active owner.
    concurrency:
      group: irexpro-staging-worktree
      cancel-in-progress: false
    runs-on: ubuntu-24.04
    # Bounded well under the GitHub-hosted six-hour job ceiling. A cancelled
    # or failed stage resumes from verified per-day materialized chunks and
    # the pair checkpoint; it never reprocesses completed work.
    timeout-minutes: 300
    environment:
      name: staging

    steps:
{CHECKOUT}{SSH_CONFIG}
      - name: Run pair stage {instrument}
        if: steps.current.outputs.current == 'true'
        shell: bash
        run: |
          set -Eeuo pipefail
          research_started_epoch="$(date +%s)"
          printf 'RESEARCH_STAGE_START stage=pair instrument={instrument} candidate=%s started_epoch=%s\\n' \\
            "$CANDIDATE_SHA" "$research_started_epoch"

          ssh \\
            -i "$HOME/.ssh/irexpro_staging" \\
            -p "$STAGING_SSH_PORT" \\
            -o BatchMode=yes \\
            -o IdentitiesOnly=yes \\
            -o StrictHostKeyChecking=yes \\
            "$STAGING_SSH_USER@$STAGING_SSH_HOST" \\
            "bash -s -- $CANDIDATE_SHA" <<'REMOTE' &
{STAGE_PROLOGUE}
{STUDY_CONSTANTS_REMOTE}
          stage_result="$OUTPUT_ROOT/checkpoints/stages/pair-{instrument}.result.json"
          install -d -m 700 "$OUTPUT_ROOT/checkpoints/stages"
          "$python_bin" -m app.domain.training.run_first_six_pair \\
            --stage pairs \\
            --stage-instruments {instrument}{COMMON_RUNNER_ARGS} \\
            "${{bootstrap_args[@]}}" \\
            > "$stage_result.tmp"
          mv "$stage_result.tmp" "$stage_result"
          printf 'RESEARCH_STAGE_COMPLETE stage=pair instrument={instrument}\\n'
          REMOTE

{WATCHDOG_RUN}{SSH_REMOVE}"""


def horizon_job(horizon: str, previous_job: str) -> str:
    job_id = f"horizon-{horizon}m"
    return f"""  {job_id}:
    name: Horizon stage {horizon}m
    needs: [validate, {previous_job}]
    if: needs.validate.outputs.run == 'true'
    concurrency:
      group: irexpro-staging-worktree
      cancel-in-progress: false
    runs-on: ubuntu-24.04
    # One bounded horizon per job. Fold checkpoints make even this stage
    # independently resumable if it is cancelled mid-evaluation.
    timeout-minutes: 240
    environment:
      name: staging

    steps:
{CHECKOUT}{SSH_CONFIG}
      - name: Run horizon stage {horizon}m
        if: steps.current.outputs.current == 'true'
        shell: bash
        run: |
          set -Eeuo pipefail
          research_started_epoch="$(date +%s)"
          printf 'RESEARCH_STAGE_START stage=horizon horizon={horizon}m candidate=%s started_epoch=%s\\n' \\
            "$CANDIDATE_SHA" "$research_started_epoch"

          ssh \\
            -i "$HOME/.ssh/irexpro_staging" \\
            -p "$STAGING_SSH_PORT" \\
            -o BatchMode=yes \\
            -o IdentitiesOnly=yes \\
            -o StrictHostKeyChecking=yes \\
            "$STAGING_SSH_USER@$STAGING_SSH_HOST" \\
            "bash -s -- $CANDIDATE_SHA" <<'REMOTE' &
{STAGE_PROLOGUE}          export IREXPRO_XGB_N_JOBS=2
          printf 'RESEARCH_CONFIGURATION xgb_n_jobs=%s progress=%s resume=true candidate=%s stage=horizon horizon={horizon}m recovery=run55_exit137\\n' \\
            "$IREXPRO_XGB_N_JOBS" "$IREXPRO_RESEARCH_PROGRESS" "$candidate_sha"

{STUDY_CONSTANTS_REMOTE}
          stage_result="$OUTPUT_ROOT/checkpoints/stages/horizon-{horizon}m.result.json"
          install -d -m 700 "$OUTPUT_ROOT/checkpoints/stages"
          "$python_bin" -m app.domain.training.run_first_six_pair \\
            --stage horizons \\
            --stage-horizons {horizon}{COMMON_RUNNER_ARGS} \\
            > "$stage_result.tmp"
          mv "$stage_result.tmp" "$stage_result"
          printf 'RESEARCH_STAGE_COMPLETE stage=horizon horizon={horizon}m\\n'
          REMOTE

{WATCHDOG_RUN}{SSH_REMOVE}"""


VALIDATE_JOB = f"""  validate:
    name: Validate candidate and initialize frozen research state
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.head_branch == 'main')
    # Acquire the shared VPS worktree lock only for a research run that
    # actually passed its trigger condition. workflow_run events from failed
    # or cancelled deploys skip without consuming/cancelling the pending slot.
    concurrency:
      group: irexpro-staging-worktree
      cancel-in-progress: false
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    environment:
      name: staging

    outputs:
      run: ${{{{ steps.relevance.outputs.run }}}}

    steps:
{CHECKOUT}{SSH_CONFIG}
      - name: Determine whether model research is required
        if: steps.current.outputs.current == 'true'
        id: relevance
        shell: bash
        run: |
          set -Eeuo pipefail

          if [[ "$GITHUB_EVENT_NAME" == "workflow_dispatch" ]]; then
            printf 'run=true\\n' >> "$GITHUB_OUTPUT"
            printf 'RESEARCH_REQUIRED reason=manual_dispatch\\n'
            exit 0
          fi

          decision="$(
            ssh \\
              -i "$HOME/.ssh/irexpro_staging" \\
              -p "$STAGING_SSH_PORT" \\
              -o BatchMode=yes \\
              -o IdentitiesOnly=yes \\
              -o StrictHostKeyChecking=yes \\
              "$STAGING_SSH_USER@$STAGING_SSH_HOST" \\
              "bash -s -- $CANDIDATE_SHA" <<'REMOTE'
          set -Eeuo pipefail
          umask 077

          candidate_sha="$1"
          readonly STAGING_ROOT='/home/lightworld/webapps/irexpro-staging'
          readonly RESEARCH_ROOT='/home/lightworld/research/irexpro-six-pair'
          readonly RESEARCH_STATE="$RESEARCH_ROOT/last-research-sha"

          cd "$STAGING_ROOT"
          test "$(git rev-parse --show-toplevel)" = "$STAGING_ROOT"
          test "$(git rev-parse HEAD)" = "$candidate_sha"

          baseline_sha=''
          if [[ -s "$RESEARCH_STATE" ]]; then
            proposed="$(tr -d '[:space:]' < "$RESEARCH_STATE")"
            if [[ "$proposed" =~ ^[0-9a-f]{{40}}$ ]] &&
               git cat-file -e "${{proposed}}^{{commit}}" 2>/dev/null &&
               git merge-base --is-ancestor "$proposed" "$candidate_sha"; then
              baseline_sha="$proposed"
            fi
          fi

          # Bootstrap the marker from the immediately previous main SHA when
          # that SHA already has a completed six-pair summary (e.g. the run
          # which predates introduction of this marker).
          if [[ -z "$baseline_sha" ]]; then
            parent_sha="$(git rev-parse "${{candidate_sha}}^1" 2>/dev/null || true)"
            if [[ "$parent_sha" =~ ^[0-9a-f]{{40}}$ ]] &&
               [[ -s "$RESEARCH_ROOT/$parent_sha/reports/six_pair_walkforward_summary.json" ]]; then
              baseline_sha="$parent_sha"
            fi
          fi

          relevant_pattern='^(services/ai-engine/app/domain/(training|models|agents/(providers|macro_context|context_sources|coordinator))/|services/ai-engine/(pyproject\\.toml|requirements\\.lock)$)'

          if [[ -z "$baseline_sha" ]]; then
            # No successful/evaluated research lineage exists yet. Fail safe:
            # a prior research attempt may have failed or timed out after the
            # model/training change, so an unrelated later deploy must not
            # silently declare those inputs evaluated. Retry until a research
            # PASS or evidence HOLD completes and persists the marker.
            printf 'true'
            exit 0
          fi

          changed_files="$(git diff --name-only "$baseline_sha" "$candidate_sha")"
          if grep -Eq "$relevant_pattern" <<<"$changed_files"; then
            printf 'true'
            exit 0
          fi

          # A prior research result is already valid for these model/training
          # inputs. Carry that evaluated lineage forward atomically.
          install -d -m 700 "$RESEARCH_ROOT"
          temp="$RESEARCH_STATE.tmp"
          printf '%s\\n' "$candidate_sha" > "$temp"
          chmod 600 "$temp"
          mv -f "$temp" "$RESEARCH_STATE"
          printf 'false'
          REMOTE
          )"

          case "$decision" in
            true)
              printf 'run=true\\n' >> "$GITHUB_OUTPUT"
              printf 'RESEARCH_REQUIRED reason=model_training_or_context_inputs_changed\\n'
              ;;
            false)
              printf 'run=false\\n' >> "$GITHUB_OUTPUT"
              printf 'RESEARCH_SKIPPED reason=no_model_or_training_input_changes\\n'
              ;;
            *)
              printf 'RESEARCH HOLD: invalid relevance decision.\\n' >&2
              exit 19
              ;;
          esac

      - name: Initialize frozen research state and stage plan
        if: steps.relevance.outputs.run == 'true'
        shell: bash
        run: |
          set -Eeuo pipefail
          printf 'RESEARCH_INIT candidate=%s\\n' "$CANDIDATE_SHA"

          ssh \\
            -i "$HOME/.ssh/irexpro_staging" \\
            -p "$STAGING_SSH_PORT" \\
            -o BatchMode=yes \\
            -o IdentitiesOnly=yes \\
            -o StrictHostKeyChecking=yes \\
            "$STAGING_SSH_USER@$STAGING_SSH_HOST" \\
            "bash -s -- $CANDIDATE_SHA" <<'REMOTE'
          export IREXPRO_INIT_STAGE=1
{STAGE_PROLOGUE}
{STUDY_CONSTANTS_REMOTE}
          ai_health="$(curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8011/api/v1/health)"
          AI_HEALTH="$ai_health" node <<'NODE'
          const payload = JSON.parse(process.env.AI_HEALTH);
          const paper = [
            payload.signal_mode,
            payload.execution_mode,
            payload.mode,
            payload.paper_mode,
            payload.paperMode,
          ].some((value) =>
            value === true ||
            String(value).toLowerCase() === 'paper' ||
            String(value).toLowerCase() === 'paper-only'
          );
          if (!paper) {{
            process.stderr.write('RESEARCH HOLD: AI staging runtime is not verified paper-only.\\n');
            process.exit(14);
          }}
          NODE
          unset ai_health

          # Keep same-candidate checkpoints across retries/timeouts. OUTPUT_ROOT is
          # already namespaced by exact candidate SHA; the Python runner validates
          # every checkpoint against candidate/config/data fingerprints before reuse.
          install -d -m 700 "$OUTPUT_ROOT" "$DUKASCOPY_CACHE"

          # Salvage completed raw/MTF pair outputs from the nearest first-parent
          # ancestor only when the data/corpus construction code is unchanged.
          # This lets a resumable implementation reuse a timed-out predecessor
          # without mixing incompatible feature/data semantics.
          bootstrap_root=''
          bootstrap_sha=''
          readonly bootstrap_unsafe_pattern='^(services/ai-engine/app/domain/training/(collect_dukascopy\\.py|multitimeframe_corpus\\.py|dataset_builder\\.py)|services/ai-engine/app/domain/models/(feature_engineering\\.py|multitimeframe_features\\.py)|services/ai-engine/(pyproject\\.toml|requirements\\.lock)$)'
          while IFS= read -r ancestor_sha; do
            [[ "$ancestor_sha" == "$candidate_sha" ]] && continue
            ancestor_root="$RESEARCH_ROOT/$ancestor_sha"
            if compgen -G "$ancestor_root/corpora/*_MTF.manifest.json" >/dev/null &&
               compgen -G "$ancestor_root/raw/*_M1.manifest.json" >/dev/null; then
              ancestor_changes="$(git diff --name-only "$ancestor_sha" "$candidate_sha")"
              if ! grep -Eq "$bootstrap_unsafe_pattern" <<<"$ancestor_changes"; then
                bootstrap_root="$ancestor_root"
                bootstrap_sha="$ancestor_sha"
                break
              fi
            fi
          done < <(git rev-list --first-parent --max-count=20 "$candidate_sha")

          bootstrap_args=()
          if [[ -n "$bootstrap_root" ]]; then
            bootstrap_args=(--bootstrap-dir "$bootstrap_root")
            printf 'RESEARCH_BOOTSTRAP source_sha=%s source_root=%s\\n' \\
              "$bootstrap_sha" "$bootstrap_root"
          else
            printf 'RESEARCH_BOOTSTRAP source_sha=none source_root=none\\n'
          fi

          # Freeze the study cutoff (effective_before) and the candidate-bound
          # orchestration plan that every later stage must verify against.
          "$python_bin" -m app.domain.training.run_first_six_pair \\
            --stage init{COMMON_RUNNER_ARGS} \\
            "${{bootstrap_args[@]}}" \\
            > /dev/null

          printf 'RESEARCH_PLAN_INITIALIZED candidate=%s plan=%s\\n' \\
            "$candidate_sha" "$PLAN_PATH"
          REMOTE

{SSH_REMOVE}"""


SELECT_JOB = f"""  select-horizon:
    name: Summarize study and select research horizon
    needs: [validate, horizon-{HORIZONS[-1]}m]
    if: needs.validate.outputs.run == 'true'
    concurrency:
      group: irexpro-staging-worktree
      cancel-in-progress: false
    runs-on: ubuntu-24.04
    timeout-minutes: 90
    environment:
      name: staging

    outputs:
      selected: ${{{{ steps.selection.outputs.selected }}}}

    steps:
{CHECKOUT}{SSH_CONFIG}
      - name: Summarize study and select horizon
        if: steps.current.outputs.current == 'true'
        id: selection
        shell: bash
        run: |
          set -Eeuo pipefail
          research_started_epoch="$(date +%s)"
          printf 'RESEARCH_STAGE_START stage=summarize candidate=%s started_epoch=%s\\n' \\
            "$CANDIDATE_SHA" "$research_started_epoch"

          remote_log="$RUNNER_TEMP/select-horizon-remote.log"
          if ssh \\
            -i "$HOME/.ssh/irexpro_staging" \\
            -p "$STAGING_SSH_PORT" \\
            -o BatchMode=yes \\
            -o IdentitiesOnly=yes \\
            -o StrictHostKeyChecking=yes \\
            "$STAGING_SSH_USER@$STAGING_SSH_HOST" \\
            "bash -s -- $CANDIDATE_SHA" <<'REMOTE' 2>&1 | tee "$remote_log"
{STAGE_PROLOGUE}          export IREXPRO_XGB_N_JOBS=2
          printf 'RESEARCH_CONFIGURATION xgb_n_jobs=%s progress=%s resume=true candidate=%s stage=summarize recovery=run55_exit137\\n' \\
            "$IREXPRO_XGB_N_JOBS" "$IREXPRO_RESEARCH_PROGRESS" "$candidate_sha"

{STUDY_CONSTANTS_REMOTE}
          "$python_bin" -m app.domain.training.run_first_six_pair \\
            --stage summarize{COMMON_RUNNER_ARGS} \\
            > "$OUTPUT_ROOT/run-result.json.tmp"
          mv "$OUTPUT_ROOT/run-result.json.tmp" "$OUTPUT_ROOT/run-result.json"

          summary="$OUTPUT_ROOT/reports/six_pair_walkforward_summary.json"
          test -s "$summary"

          SUMMARY_PATH="$summary" node <<'NODE'
          const fs = require('fs');
          const report = JSON.parse(fs.readFileSync(process.env.SUMMARY_PATH, 'utf8'));
          console.log('SIX_PAIR_RESEARCH_COMPLETED');
          console.log(`data_source=${{report.data_source}}`);
          console.log(`instruments=${{report.instruments.join(',')}}`);
          console.log(`target_rows_per_pair=${{report.target_m1_rows_per_instrument}}`);
          console.log(`dukascopy_max_lookback_days=${{report.dukascopy_max_lookback_days}}`);

          for (const instrument of report.instruments) {{
            const manifest = report.collection_manifests[instrument];
            console.log(
              [
                `corpus=${{instrument}}`,
                `rows=${{manifest.row_count}}`,
                `source=${{manifest.source}}`,
                `spread=${{manifest.spread_basis}}`,
                `sha256=${{manifest.dataset_sha256}}`,
                `chunk_hits=${{manifest.m1_chunk_hits ?? 0}}`,
                `chunks_built=${{manifest.m1_chunks_built ?? 0}}`,
                `decode_hours_avoided=${{manifest.decode_hours_avoided ?? 0}}`,
                `raw_cache_hits=${{manifest.raw_cache_hits ?? 0}}`,
              ].join(' ')
            );
          }}

          for (const horizon of ['1m', '5m', '10m']) {{
            const block = report.horizon_reports[horizon];
            if (!block) continue;
            const c = block.overall.classification;
            const t = block.overall.trading;
            const g = block.research_gate;
            const o = g.observed || {{}};
            const checks = g.checks || {{}};
            const fmt = (value) =>
              value == null || !Number.isFinite(Number(value))
                ? 'null'
                : Number(value).toFixed(6);
            const pass = (name) => checks[name] === true ? 'PASS' : 'HOLD';
            console.log(
              [
                `horizon=${{horizon}}`,
                `balanced_accuracy=${{Number(c.balanced_accuracy).toFixed(6)}}`,
                `precision=${{Number(c.precision).toFixed(6)}}`,
                `recall=${{Number(c.recall).toFixed(6)}}`,
                `f1=${{Number(c.f1).toFixed(6)}}`,
                `sharpe=${{t.sharpe_ratio == null ? 'null' : Number(t.sharpe_ratio).toFixed(6)}}`,
                `profit_factor=${{t.profit_factor == null ? 'null' : Number(t.profit_factor).toFixed(6)}}`,
                `max_drawdown=${{Number(t.max_drawdown).toFixed(6)}}`,
                `trades=${{t.trade_or_period_count}}`,
                `positive_fold_fraction=${{fmt(o.positive_fold_fraction)}}`,
                `positive_instrument_fraction=${{fmt(o.positive_instrument_fraction)}}`,
                `gate_checks=ba:${{pass('balanced_accuracy')}},sharpe:${{pass('sharpe_ratio')}},pf:${{pass('profit_factor')}},dd:${{pass('max_drawdown')}},folds:${{pass('positive_fold_fraction')}},pairs:${{pass('positive_instrument_fraction')}}`,
                `gate=${{g.research_gate_passed ? 'PASS' : 'HOLD'}}`,
              ].join(' ')
            );
          }}
          NODE

          printf 'report_path=%s\\n' "$summary"

          # Select exactly one horizon using research evidence only. The untouched
          # test set is deliberately NOT used for horizon selection; it remains a
          # final gate for the pre-selected candidate.
          selected_horizon="$(SUMMARY_PATH="$summary" node <<'NODE'
          const fs = require('fs');
          const report = JSON.parse(fs.readFileSync(process.env.SUMMARY_PATH, 'utf8'));
          const candidates = [];
          for (const horizon of report.horizons_minutes || []) {{
            const block = report.horizon_reports?.[String(horizon) + 'm'];
            if (!block?.research_gate?.research_gate_passed) continue;
            const classification = block.overall?.classification || {{}};
            const trading = block.overall?.trading || {{}};
            const sharpe = Number(trading.sharpe_ratio);
            const balanced = Number(classification.balanced_accuracy);
            const drawdown = Number(trading.max_drawdown);
            candidates.push({{
              horizon: Number(horizon),
              sharpe: Number.isFinite(sharpe) ? sharpe : -Infinity,
              balanced: Number.isFinite(balanced) ? balanced : -Infinity,
              drawdown: Number.isFinite(drawdown) ? drawdown : Infinity,
            }});
          }}
          candidates.sort((a, b) =>
            (b.sharpe - a.sharpe) ||
            (b.balanced - a.balanced) ||
            (a.drawdown - b.drawdown) ||
            (a.horizon - b.horizon)
          );
          if (candidates.length > 0) process.stdout.write(String(candidates[0].horizon));
          NODE
          )"

          mark_research_evaluated() {{
            install -d -m 700 "$RESEARCH_ROOT"
            local marker_temp="$RESEARCH_ROOT/last-research-sha.tmp"
            printf '%s\\n' "$candidate_sha" > "$marker_temp"
            chmod 600 "$marker_temp"
            mv -f "$marker_temp" "$RESEARCH_ROOT/last-research-sha"
          }}

          if [[ -z "$selected_horizon" ]]; then
            # The study completed and every horizon was evaluated; persist the
            # evaluated-SHA lineage marker so unrelated deploys do not retry a
            # study whose evidence was already produced.
            mark_research_evaluated
            printf 'MODEL_PROMOTION_HOLD reason=no_research_horizon_passed\\n'
            exit 0
          fi
          [[ "$selected_horizon" =~ ^(1|5|10)$ ]] || {{
            printf 'MODEL_PROMOTION_HOLD reason=invalid_selected_horizon\\n' >&2
            exit 16
          }}
          printf 'SELECTED_HORIZON horizon=%sm\\n' "$selected_horizon"

          # Long research runs may outlive the main SHA they started from.
          # Never promote a trained artifact after main has moved; force the
          # next exact-main deployment to research again instead.
          git fetch --quiet --no-tags origin main
          current_main_sha="$(git rev-parse origin/main)"
          if [[ "$current_main_sha" != "$candidate_sha" ]]; then
            printf 'MODEL_PROMOTION_HOLD reason=candidate_superseded candidate=%s current_main=%s\\n' \\
              "$candidate_sha" "$current_main_sha"
            exit 0
          fi

          # Evaluate the advisory Agent Council overlay on the exact outer-fold
          # predictions for the selected research horizon. This is observational
          # evidence only and cannot alter model selection, paper approval,
          # risk limits, or broker execution.
          context_predictions="$OUTPUT_ROOT/reports/six_pair_walkforward_${{selected_horizon}}m_predictions.csv"
          context_root="$OUTPUT_ROOT/context/h$selected_horizon"
          context_result="$context_root/context-run-result.json"
          context_error="$context_root/context-error.log"
          install -d -m 700 "$context_root"

          if [[ ! -s "$context_predictions" ]]; then
            printf 'CONTEXT_RESEARCH_HOLD reason=missing_outer_fold_predictions horizon=%sm\\n' \\
              "$selected_horizon"
          elif "$python_bin" -m app.domain.training.run_bls_context_overlay_study \\
            --predictions "$context_predictions" \\
            --horizon-bars "$selected_horizon" \\
            --output-dir "$context_root" \\
            --pre-event-minutes 30 \\
            --post-event-minutes 15 \\
            > "$context_result" 2> "$context_error"; then
            context_report="$context_root/agent_council_overlay.json"
            if [[ ! -s "$context_report" ]]; then
              printf 'CONTEXT_RESEARCH_HOLD reason=missing_overlay_report horizon=%sm\\n' \\
                "$selected_horizon"
            elif CONTEXT_REPORT_PATH="$context_report" node <<'NODE'
          const fs = require('fs');
          const report = JSON.parse(
            fs.readFileSync(process.env.CONTEXT_REPORT_PATH, 'utf8')
          );
          const quant = report.overall?.quant_only || {{}};
          const candidate = report.overall?.context_block_candidate || {{}};
          const classification = report.overall?.classification_on_active_signals || {{}};
          const archive = report.historical_context_archive || {{}};
          const blocked = report.blocked_signal_diagnostics || {{}};
          const value = (input, digits = 6) =>
            input == null || !Number.isFinite(Number(input))
              ? 'null'
              : Number(input).toFixed(digits);

          console.log('AGENT_CONTEXT_OVERLAY_COMPLETED');
          console.log(
            [
              `horizon=${{report.horizon_bars}}m`,
              `archive_months=${{archive.month_count ?? 0}}`,
              `archive_events=${{archive.event_count ?? 0}}`,
              `retrospective_excluded=${{archive.skipped_retrospective_rows ?? 0}}`,
              `blocked_signals=${{blocked.blocked_signals ?? 0}}`,
              `blocked_winners=${{blocked.blocked_positive_outcomes ?? 0}}`,
              `blocked_losers=${{blocked.blocked_negative_outcomes ?? 0}}`,
            ].join(' ')
          );
          console.log(
            [
              'quant_only',
              `signals=${{quant.raw_active_signals ?? 0}}`,
              `sharpe=${{value(quant.sharpe_ratio)}}`,
              `max_drawdown=${{value(quant.max_drawdown)}}`,
              `precision=${{value(classification.quant_only?.precision)}}`,
              `brier=${{value(classification.quant_only?.brier_score)}}`,
            ].join(' ')
          );
          console.log(
            [
              'context_candidate',
              `signals=${{candidate.raw_active_signals ?? 0}}`,
              `sharpe=${{value(candidate.sharpe_ratio)}}`,
              `max_drawdown=${{value(candidate.max_drawdown)}}`,
              `precision=${{value(classification.context_block_candidate?.precision)}}`,
              `brier=${{value(classification.context_block_candidate?.brier_score)}}`,
              'approved_for_paper_uat=false',
              'approved_for_live=false',
            ].join(' ')
          );
          NODE
            then
              rm -f "$context_error"
              printf 'context_report_path=%s\\n' "$context_report"
            else
              context_status=$?
              printf 'CONTEXT_RESEARCH_HOLD reason=overlay_report_validation_failed status=%s horizon=%sm\\n' \\
                "$context_status" "$selected_horizon"
            fi
          else
            context_status=$?
            context_message=''
            if [[ -s "$context_error" ]]; then
              context_message="$(head -n 1 "$context_error" | tr '\\r\\n' ' ' | cut -c1-240)"
            fi
            printf 'CONTEXT_RESEARCH_HOLD reason=archive_or_overlay_failed status=%s message=%s\\n' \\
              "$context_status" "$context_message"
          fi
          REMOTE
          then
            remote_status=0
          else
            remote_status=$?
          fi

          printf 'RESEARCH_STAGE_EXIT stage=summarize status=%s elapsed_seconds=%s\\n' \\
            "$remote_status" "$(( $(date +%s) - research_started_epoch ))"

          selected_horizon=''
          if grep -Eq '^SELECTED_HORIZON horizon=(1|5|10)m$' "$remote_log"; then
            selected_horizon="$(grep -E '^SELECTED_HORIZON horizon=' "$remote_log" | tail -n 1 | grep -Eo '(1|5|10)' | tail -n 1)"
          fi
          printf 'selected=%s\\n' "$selected_horizon" >> "$GITHUB_OUTPUT"

          exit "$remote_status"

{SSH_REMOVE}"""


FINAL_JOB = f"""  final-model:
    name: Untouched-test final model
    needs: [validate, select-horizon]
    if: >-
      needs.validate.outputs.run == 'true' &&
      needs.select-horizon.outputs.selected != ''
    concurrency:
      group: irexpro-staging-worktree
      cancel-in-progress: false
    runs-on: ubuntu-24.04
    timeout-minutes: 240
    environment:
      name: staging

    outputs:
      promote: ${{{{ steps.training.outputs.promote }}}}
      horizon: ${{{{ steps.training.outputs.horizon }}}}

    steps:
{CHECKOUT}{SSH_CONFIG}
      - name: Train and verify final model on the untouched test tail
        if: steps.current.outputs.current == 'true'
        id: training
        shell: bash
        run: |
          set -Eeuo pipefail
          selected_horizon="${{ needs.select-horizon.outputs.selected }}"
          [[ "$selected_horizon" =~ ^(1|5|10)$ ]] || {{
            printf 'MODEL_PROMOTION_HOLD reason=invalid_selected_horizon\\n' >&2
            exit 16
          }}
          printf 'horizon=%s\\n' "$selected_horizon" >> "$GITHUB_OUTPUT"
          printf 'promote=false\\n' >> "$GITHUB_OUTPUT"

          research_started_epoch="$(date +%s)"
          printf 'RESEARCH_STAGE_START stage=final_model horizon=%sm candidate=%s started_epoch=%s\\n' \\
            "$selected_horizon" "$CANDIDATE_SHA" "$research_started_epoch"

          remote_log="$RUNNER_TEMP/final-model-remote.log"
          ssh \\
            -i "$HOME/.ssh/irexpro_staging" \\
            -p "$STAGING_SSH_PORT" \\
            -o BatchMode=yes \\
            -o IdentitiesOnly=yes \\
            -o StrictHostKeyChecking=yes \\
            "$STAGING_SSH_USER@$STAGING_SSH_HOST" \\
            "bash -s -- $CANDIDATE_SHA $selected_horizon" <<'REMOTE' > "$remote_log" 2>&1 &
{STAGE_PROLOGUE}          export IREXPRO_XGB_N_JOBS=2

          selected_horizon="$2"
          [[ "$selected_horizon" =~ ^(1|5|10)$ ]] || {{
            printf 'MODEL_PROMOTION_HOLD reason=invalid_selected_horizon\\n' >&2
            exit 16
          }}
          printf 'RESEARCH_CONFIGURATION xgb_n_jobs=%s progress=%s resume=true candidate=%s stage=final_model horizon=%sm recovery=run55_exit137\\n' \\
            "$IREXPRO_XGB_N_JOBS" "$IREXPRO_RESEARCH_PROGRESS" "$candidate_sha" "$selected_horizon"

          readonly MODEL_ROOT="/home/lightworld/research/irexpro-models/$candidate_sha/h$selected_horizon"
          readonly MODEL_PATH="$MODEL_ROOT/model.json"
          readonly METADATA_PATH="$MODEL_ROOT/model.metadata.json"
          readonly TRAIN_RESULT="$MODEL_ROOT/train-result.json"
          readonly TRAIN_ERROR="$MODEL_ROOT/train-error.log"
          rm -rf "$MODEL_ROOT"
          install -d -m 700 "$MODEL_ROOT"

          if "$python_bin" -m app.domain.training.train_final_multitimeframe \\
            --dataset "EURUSD=$OUTPUT_ROOT/corpora/EURUSD_MTF.csv" \\
            --dataset "GBPUSD=$OUTPUT_ROOT/corpora/GBPUSD_MTF.csv" \\
            --dataset "USDJPY=$OUTPUT_ROOT/corpora/USDJPY_MTF.csv" \\
            --dataset "AUDUSD=$OUTPUT_ROOT/corpora/AUDUSD_MTF.csv" \\
            --dataset "USDCAD=$OUTPUT_ROOT/corpora/USDCAD_MTF.csv" \\
            --dataset "USDCHF=$OUTPUT_ROOT/corpora/USDCHF_MTF.csv" \\
            --horizon-bars "$selected_horizon" \\
            --output-model "$MODEL_PATH" \\
            --qualification-summary "$OUTPUT_ROOT/reports/six_pair_walkforward_summary.json" \\
            --confidence-threshold 0.60 \\
            --commission-bps 0 \\
            --slippage-bps 0 \\
            --approve-paper \\
            > "$TRAIN_RESULT" 2> "$TRAIN_ERROR"; then
            :
          else
            training_status=$?
            if grep -Fq \\
              'Paper approval requested but research and/or untouched-test gate did not pass' \\
              "$TRAIN_ERROR"; then
              printf 'MODEL_PROMOTION_HOLD reason=untouched_test_gate_failed horizon=%sm\\n' \\
                "$selected_horizon"
              rm -f "$TRAIN_ERROR"
              exit 0
            fi
            cat "$TRAIN_ERROR" >&2
            exit "$training_status"
          fi
          rm -f "$TRAIN_ERROR"
          test -s "$MODEL_PATH"
          test -s "$METADATA_PATH"

          # Load the exact candidate through the production loader before changing
          # the staging process. This re-verifies artifact SHA, feature schema,
          # runtime profile and paper/live governance.
          XGBOOST_MODEL_PATH="$MODEL_PATH" \\
          XGBOOST_MODEL_METADATA_PATH="$METADATA_PATH" \\
          "$python_bin" - <<'PY'
          from app.domain.models.baseline_xgboost import BaselineXGBoostModel

          model = BaselineXGBoostModel()
          if not model.load_model():
              raise SystemExit("MODEL PROMOTION HOLD: verified loader rejected artifact")
          metadata = model.get_model_metadata()
          if metadata.get("mode") != "trained_xgboost_mtf":
              raise SystemExit("MODEL PROMOTION HOLD: model is not trained MTF XGBoost")
          if metadata.get("approved_for_paper") is not True:
              raise SystemExit("MODEL PROMOTION HOLD: artifact is not paper approved")
          if metadata.get("approved_for_live") is not False:
              raise SystemExit("MODEL PROMOTION HOLD: live approval must remain false")
          print("MODEL_ARTIFACT_VERIFIED")
          PY
          REMOTE

{WATCHDOG_RUN}
          cat "$remote_log"

          if grep -Fq 'MODEL_ARTIFACT_VERIFIED' "$remote_log"; then
            printf 'promote=true\\n' >> "$GITHUB_OUTPUT"
            printf 'RESEARCH_STAGE_COMPLETE stage=final_model horizon=%sm\\n' "$selected_horizon"
            exit 0
          fi

          # Exit 0 with a hold (untouched-test gate or superseded candidate)
          # is a valid, complete outcome; only promote on verified artifacts.
          printf 'RESEARCH_STAGE_HOLD stage=final_model horizon=%sm\\n' "$selected_horizon"
          exit 0
{SSH_REMOVE}"""


PROMOTION_JOB = f"""  paper-promotion:
    name: PAPER UAT promotion and runtime verification
    needs: [validate, final-model]
    if: >-
      needs.validate.outputs.run == 'true' &&
      needs.final-model.outputs.promote == 'true'
    concurrency:
      group: irexpro-staging-worktree
      cancel-in-progress: false
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    environment:
      name: staging

    steps:
{CHECKOUT}{SSH_CONFIG}
      - name: Activate verified paper model on staging runtime
        if: steps.current.outputs.current == 'true'
        shell: bash
        run: |
          set -Eeuo pipefail
          selected_horizon="${{ needs.final-model.outputs.horizon }}"
          [[ "$selected_horizon" =~ ^(1|5|10)$ ]] || {{
            printf 'MODEL_PROMOTION_HOLD reason=invalid_selected_horizon\\n' >&2
            exit 16
          }}

          ssh \\
            -i "$HOME/.ssh/irexpro_staging" \\
            -p "$STAGING_SSH_PORT" \\
            -o BatchMode=yes \\
            -o IdentitiesOnly=yes \\
            -o StrictHostKeyChecking=yes \\
            "$STAGING_SSH_USER@$STAGING_SSH_HOST" \\
            "bash -s -- $CANDIDATE_SHA $selected_horizon" <<'REMOTE'
          set -Eeuo pipefail
          umask 077

          candidate_sha="$1"
          selected_horizon="$2"
          [[ "$candidate_sha" =~ ^[0-9a-f]{{40}}$ ]] || {{
            printf 'RESEARCH HOLD: invalid candidate SHA.\\n' >&2
            exit 2
          }}
          [[ "$selected_horizon" =~ ^(1|5|10)$ ]] || {{
            printf 'MODEL_PROMOTION_HOLD reason=invalid_selected_horizon\\n' >&2
            exit 16
          }}

          readonly STAGING_ROOT='/home/lightworld/webapps/irexpro-staging'
          readonly RESEARCH_ROOT='/home/lightworld/research/irexpro-six-pair'

          cd "$STAGING_ROOT"
          test "$(git rev-parse --show-toplevel)" = "$STAGING_ROOT"
          test "$(git rev-parse HEAD)" = "$candidate_sha"

          python_bin=''
          for candidate in \\
            "$STAGING_ROOT/services/ai-engine/.venv/bin/python" \\
            "$STAGING_ROOT/services/ai-engine/venv/bin/python"; do
            if [[ -x "$candidate" ]]; then
              python_bin="$candidate"
              break
            fi
          done
          [[ -n "$python_bin" ]] || {{
            printf 'RESEARCH HOLD: AI Python virtual environment was not found.\\n' >&2
            exit 15
          }}

          # Re-check immediately before any staging runtime mutation. Main may
          # have moved while final training and the untouched-test gate ran.
          git fetch --quiet --no-tags origin main
          current_main_sha="$(git rev-parse origin/main)"
          if [[ "$current_main_sha" != "$candidate_sha" ]]; then
            printf 'MODEL_PROMOTION_HOLD reason=candidate_superseded_before_activation candidate=%s current_main=%s\\n' \\
              "$candidate_sha" "$current_main_sha"
            exit 0
          fi

          readonly MODEL_ROOT="/home/lightworld/research/irexpro-models/$candidate_sha/h$selected_horizon"
          readonly MODEL_PATH="$MODEL_ROOT/model.json"
          readonly METADATA_PATH="$MODEL_ROOT/model.metadata.json"
          test -s "$MODEL_PATH"
          test -s "$METADATA_PATH"

          # Persist only the two non-secret model paths in the ignored staging .env
          # and atomically replace the file. deploy-staging.sh reloads these values
          # on every later restart, preventing silent heuristic regression.
          AI_ENV_PATH="$STAGING_ROOT/services/ai-engine/.env" \\
          PROMOTED_MODEL_PATH="$MODEL_PATH" \\
          PROMOTED_METADATA_PATH="$METADATA_PATH" \\
          "$python_bin" - <<'PY'
          import os
          from pathlib import Path

          path = Path(os.environ["AI_ENV_PATH"])
          if not path.is_file():
              raise SystemExit("MODEL PROMOTION HOLD: staging AI .env is missing")
          updates = {{
              "XGBOOST_MODEL_PATH": os.environ["PROMOTED_MODEL_PATH"],
              "XGBOOST_MODEL_METADATA_PATH": os.environ["PROMOTED_METADATA_PATH"],
          }}
          lines = path.read_text(encoding="utf-8").splitlines()
          seen = set()
          output = []
          for line in lines:
              replaced = False
              for key, value in updates.items():
                  if line.startswith(f"{{key}}="):
                      output.append(f"{{key}}={{value}}")
                      seen.add(key)
                      replaced = True
                      break
              if not replaced:
                  output.append(line)
          for key, value in updates.items():
              if key not in seen:
                  output.append(f"{{key}}={{value}}")
          temp = path.with_name(f"{{path.name}}.model-promotion.tmp")
          temp.write_text("\\n".join(output) + "\\n", encoding="utf-8")
          temp.chmod(path.stat().st_mode & 0o777)
          os.replace(temp, path)
          PY

          export XGBOOST_MODEL_PATH="$MODEL_PATH"
          export XGBOOST_MODEL_METADATA_PATH="$METADATA_PATH"
          pm2 restart irexpro-ai-staging --update-env >/dev/null

          runtime_ready=false
          for attempt in {{1..30}}; do
            if ai_health="$(curl --fail --silent --show-error --max-time 10 \\
              http://127.0.0.1:8011/api/v1/health 2>/dev/null)"; then
              if AI_HEALTH="$ai_health" node -e '
                const p = JSON.parse(process.env.AI_HEALTH);
                const paper = [p.signal_mode, p.execution_mode, p.mode, p.paper_mode, p.paperMode]
                  .some((v) => v === true || ["paper", "paper-only"].includes(String(v).toLowerCase()));
                if (!paper || p.scheduler_enabled !== true) process.exit(1);
              '; then
                runtime_ready=true
                break
              fi
            fi
            sleep 2
          done
          [[ "$runtime_ready" == true ]] || {{
            printf 'MODEL PROMOTION FAILED: AI runtime did not recover in paper mode.\\n' >&2
            exit 18
          }}

          model_version="$(METADATA_PATH="$METADATA_PATH" node -e '
            const fs = require("fs");
            const m = JSON.parse(fs.readFileSync(process.env.METADATA_PATH, "utf8"));
            process.stdout.write(String(m.model_version || "unknown"));
          ')"

          active_model="$(curl --fail --silent --show-error --max-time 10 \\
            http://127.0.0.1:8011/api/v1/models/active)"
          ACTIVE_MODEL="$active_model" EXPECTED_MODEL_VERSION="$model_version" node -e '
            const model = JSON.parse(process.env.ACTIVE_MODEL);
            const expected = process.env.EXPECTED_MODEL_VERSION;
            if (
              model.version !== expected ||
              model.mode !== "trained_xgboost_mtf" ||
              model.loaded !== true ||
              model.approved_for_paper !== true ||
              model.approved_for_live !== false
            ) {{
              console.error("MODEL PROMOTION FAILED: restarted runtime did not activate verified trained model");
              process.exit(1);
            }}
          '

          # The full staged study (collection, evaluation, untouched test, and
          # paper activation) completed for this exact candidate: persist the
          # evaluated-SHA lineage marker atomically.
          install -d -m 700 "$RESEARCH_ROOT"
          marker_temp="$RESEARCH_ROOT/last-research-sha.tmp"
          printf '%s\\n' "$candidate_sha" > "$marker_temp"
          chmod 600 "$marker_temp"
          mv -f "$marker_temp" "$RESEARCH_ROOT/last-research-sha"

          printf 'MODEL_PROMOTED_PAPER_UAT version=%s horizon=%sm approved_for_live=false\\n' \\
            "$model_version" "$selected_horizon"
          REMOTE

{SSH_REMOVE}"""


CLEANUP_JOB = """  cleanup:
    name: Remove ephemeral runner material
    needs: [paper-promotion]
    if: ${{ always() }}
    runs-on: ubuntu-24.04
    timeout-minutes: 5

    steps:
      - name: Remove ephemeral SSH material
        if: ${{ always() }}
        shell: bash
        run: |
          rm -f "$HOME/.ssh/irexpro_staging" "$HOME/.ssh/known_hosts"
"""


def main() -> None:
    header = """# Six Pair Research Run — Research Resilience V2 (bounded, resumable stages).
#
# GitHub-hosted jobs have a hard six-hour execution ceiling. The previous
# single-job design required one runner to stay alive through six-pair
# collection, MTF construction, three horizon evaluations, horizon selection,
# untouched-test final training, and paper promotion. This workflow splits
# that work into bounded, independently resumable stages:
#
#   validate -> pair EURUSD -> ... -> pair USDCHF
#            -> horizon 1m -> horizon 5m -> horizon 10m
#            -> summarize/select -> final model -> paper promotion -> cleanup
#
# Each expensive stage consumes persisted verified state (the frozen study
# cutoff, per-pair checkpoints, daily materialized M1 chunks, per-horizon and
# per-fold checkpoints) and can be cancelled and re-run without corrupting
# completed stages. A failed or cancelled stage never deletes verified
# previous stage outputs; the next dispatch resumes exactly where it stopped.
#
# No single job depends on surviving more than the six-hour ceiling, and no
# job uses a timeout above 360 minutes.
name: Six Pair Research Run

on:
  workflow_run:
    workflows: ['Staging Deploy']
    types: [completed]
  workflow_dispatch:

permissions:
  contents: read

env:
  CANDIDATE_SHA: ${{ github.event_name == 'workflow_dispatch' && github.sha || github.event.workflow_run.head_sha }}
  STAGING_SSH_HOST: vps.lightworldtech.com
  STAGING_SSH_PORT: ${{ vars.STAGING_SSH_PORT || '22' }}
  STAGING_SSH_USER: ${{ vars.STAGING_SSH_USER }}
  SSH_PRIVATE_KEY: ${{ secrets.STAGING_SSH_PRIVATE_KEY }}
  SSH_KNOWN_HOSTS: ${{ secrets.STAGING_SSH_KNOWN_HOSTS }}

jobs:
"""

    parts = [header, VALIDATE_JOB, "\n"]
    previous_job: str | None = None
    for pair in PAIRS:
        parts.append(pair_job(pair, previous_job))
        parts.append("\n")
        previous_job = f"pair-{pair.lower()}"
    if previous_job is None:
        raise ValueError("At least one pair stage is required")
    for horizon in HORIZONS:
        parts.append(horizon_job(horizon, previous_job))
        parts.append("\n")
        previous_job = f"horizon-{horizon}m"
    parts.append(SELECT_JOB)
    parts.append("\n")
    parts.append(FINAL_JOB)
    parts.append("\n")
    parts.append(PROMOTION_JOB)
    parts.append("\n")
    parts.append(CLEANUP_JOB)

    content = "".join(parts)
    with open(
        ".github/workflows/six-pair-research-run.yml", "w", encoding="utf-8"
    ) as handle:
        handle.write(content)
    print(f"wrote {len(content.splitlines())} lines")


if __name__ == "__main__":
    main()
