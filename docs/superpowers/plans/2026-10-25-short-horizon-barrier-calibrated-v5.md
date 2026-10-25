# Short-Horizon Barrier-Calibrated v5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and evidence-test a pair-specific first-passage LONG/SHORT model that can produce materially more qualified 5/20/60-minute opportunities without lowering profitability/risk gates.

**Architecture:** Independent LONG/SHORT actionability classifiers are fitted per pair. Training-only, horizon-purged calibration learns each pair's minimum winning-side probability and side-separation margin from realised economics, optimizing profit-throughput only after economics and side-balance floors pass. Outer purged walk-forward measures conservative non-overlapping opportunity frequency and profitability.

**Tech Stack:** Python, pandas, numpy, scikit-learn metrics, XGBoost, pytest, GitHub Actions.

**Spec:** `docs/superpowers/designs/2026-10-25-short-horizon-barrier-calibrated-v5.md`

## Global Constraints

- RESEARCH / SHADOW ONLY; no PAPER, DEMO, or LIVE authority.
- Six-pair universe only: EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF.
- Horizons locked to 5/20/60 minutes.
- Future/barrier outcome columns are labels/evaluation only, never model features.
- Outer and inner splits are horizon-purged; outer folds also use horizon-sized embargo.
- Pair calibration never borrows another pair's thresholds or models.
- Frequency gates are additional to economics/risk gates, never substitutes.

## Review Focus

- Missing pair model/calibration must ABSTAIN/fail closed.
- High-frequency but negative-economics calibration must fail.
- Profitable but one-sided calibration must fail the side-balance floor.
- Validation rows must never participate in fit/calibration.
- Simultaneous/overlapping signals must not inflate opportunity counts.

---

### Task 1: Training-only probability/margin calibration

**Files:**
- Create: `services/ai-engine/app/domain/training/short_horizon_barrier_calibrated.py`
- Create: `services/ai-engine/tests/test_short_horizon_barrier_calibrated.py`

**Interfaces:**
- Produces: `BarrierPairCalibration` and `select_barrier_pair_calibration(...)`.

- [x] **Step 1: Write RED tests** for profitable calibration selection, losing high-density rejection, insufficient rows, one-sided rejection, and profit-throughput preference among candidates that already pass economics.
- [x] **Step 2: Run focused pytest and confirm RED** because the module/API does not yet exist.
- [x] **Step 3: Implement the minimal pure calibration policy.**
- [x] **Step 4: Run focused pytest and confirm GREEN.**
- [x] **Step 5: Commit.**

### Task 2: Pair-specific LONG/SHORT classifier fit and routing

**Files:**
- Modify: `services/ai-engine/app/domain/training/short_horizon_barrier_calibrated.py`
- Modify: `services/ai-engine/tests/test_short_horizon_barrier_calibrated.py`

**Interfaces:**
- Produces: `fit_pair_barrier_experts(...)` and `route_pair_barrier_predictions(...)`.
- Consumes existing causal event-barrier LONG/SHORT target columns and MTF feature policy.

- [x] **Step 1: Add RED tests** for exact-pair routing, calibrated probability+margin activation, missing expert failure, failed calibration ABSTAIN, and no cross-pair fallback.
- [x] **Step 2: Run focused pytest and confirm RED.**
- [x] **Step 3: Implement pair classifiers and routing, reusing established class-balance/early-stop patterns where appropriate.**
- [x] **Step 4: Run focused pytest and confirm GREEN.**
- [x] **Step 5: Commit.**

### Task 3: Purged walk-forward economics and participation evaluator

**Files:**
- Modify: `services/ai-engine/app/domain/training/short_horizon_barrier_calibrated.py`
- Create: `services/ai-engine/tests/test_short_horizon_barrier_calibrated_walk_forward.py`

**Interfaces:**
- Produces: `evaluate_barrier_calibrated_frame(...)` and six-pair corpus/report wrapper.

- [x] **Step 1: Add RED tests** proving horizon-sized purge/embargo, train-only calibration, conservative non-overlap counting, six-pair breadth, and that high activity cannot pass when PF/Sharpe/economics fail.
- [x] **Step 2: Run focused pytest and confirm RED.**
- [x] **Step 3: Implement expanding purged walk-forward evaluation and atomic JSON reporting.**
- [x] **Step 4: Run focused tests + AI Engine suite and confirm GREEN.**
- [x] **Step 5: Commit.**

### Task 4: Bounded 5m one-fold evidence screen

**Files:**
- Create: `.github/workflows/barrier-calibrated-v5-five-minute-screen.yml`

**Interfaces:**
- Consumes exact research SHA and existing complete six-pair MTF corpus cache.
- Produces a research JSON report and Actions-log evidence only; no deployment.

- [x] **Step 1: Add exact-SHA research workflow** using an isolated VPS research worktree and existing corpus cache.
- [x] **Step 2: Run only 5m / one purged fold.** Initial exact-SHA screen produced zero active signals/opportunities.
- [x] **Step 3: Record opportunities/day, BA, PF, Sharpe, DD, positive fold/instrument fractions, and governance=false.** The zero-signal screen left trade-only metrics undefined, correctly failing all economics/participation gates except drawdown.
- [x] **Step 4: Stop and diagnose; do not run 20m/60m.** Frozen-corpus probing found zero structurally eligible calibration cells for all six pairs because the absolute probability grid started above most pair score distributions.

### Task 5: Repair calibration score-scale coverage and rerun 5m

**Files:**
- Modify: `services/ai-engine/app/domain/training/short_horizon_barrier_calibrated.py`
- Modify: `services/ai-engine/tests/test_short_horizon_barrier_calibrated.py`
- Modify: `services/ai-engine/tests/test_short_horizon_barrier_calibrated_walk_forward.py`
- Modify: `docs/superpowers/designs/2026-10-25-short-horizon-barrier-calibrated-v5.md`

- [x] **Step 1: Preserve pair-level calibration decisions in fold evidence** so future screens expose calibration failures instead of only aggregate zero activity.
- [x] **Step 2: Add a RED regression** proving the default calibration can discover an economically valid 5–25% tail even when all useful model scores are below 0.55.
- [x] **Step 3: Replace the absolute default score grid with bounded training-only probability/margin quantiles; keep row-count, density, side-balance, mean-return, and PF floors unchanged.**
- [x] **Step 4: Run focused v5 tests, Ruff, and diff checks GREEN.**
- [x] **Step 5: Rerun the exact 5m / one-fold frozen-corpus screen with the adaptive grid.** Every pair now had 36–40 structurally eligible calibration choices, confirming the score-scale defect was repaired.
- [x] **Step 6: Reject v5 at 5m on economics and stop before 20m/60m.** All six pairs still had zero positive-mean / PF>=1.10 calibration candidates. Best structural means remained negative: EURUSD -0.231 bps (PF 0.693), GBPUSD -0.334 (0.662), USDJPY -0.096 (0.875), AUDUSD -1.076 (0.418), USDCAD -0.733 (0.432), USDCHF -0.862 (0.554). No pair was allowed to activate, so outer validation correctly remained at zero trades/opportunities.
