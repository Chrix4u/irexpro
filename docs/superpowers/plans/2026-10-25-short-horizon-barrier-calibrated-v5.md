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

- [ ] **Step 1: Write RED tests** for profitable calibration selection, losing high-density rejection, insufficient rows, one-sided rejection, and profit-throughput preference among candidates that already pass economics.
- [ ] **Step 2: Run focused pytest and confirm RED** because the module/API does not yet exist.
- [ ] **Step 3: Implement the minimal pure calibration policy.**
- [ ] **Step 4: Run focused pytest and confirm GREEN.**
- [ ] **Step 5: Commit.**

### Task 2: Pair-specific LONG/SHORT classifier fit and routing

**Files:**
- Modify: `services/ai-engine/app/domain/training/short_horizon_barrier_calibrated.py`
- Modify: `services/ai-engine/tests/test_short_horizon_barrier_calibrated.py`

**Interfaces:**
- Produces: `fit_pair_barrier_experts(...)` and `route_pair_barrier_predictions(...)`.
- Consumes existing causal event-barrier LONG/SHORT target columns and MTF feature policy.

- [ ] **Step 1: Add RED tests** for exact-pair routing, calibrated probability+margin activation, missing expert failure, failed calibration ABSTAIN, and no cross-pair fallback.
- [ ] **Step 2: Run focused pytest and confirm RED.**
- [ ] **Step 3: Implement pair classifiers and routing, reusing established class-balance/early-stop patterns where appropriate.**
- [ ] **Step 4: Run focused pytest and confirm GREEN.**
- [ ] **Step 5: Commit.**

### Task 3: Purged walk-forward economics and participation evaluator

**Files:**
- Modify: `services/ai-engine/app/domain/training/short_horizon_barrier_calibrated.py`
- Create: `services/ai-engine/tests/test_short_horizon_barrier_calibrated_walk_forward.py`

**Interfaces:**
- Produces: `evaluate_barrier_calibrated_frame(...)` and six-pair corpus/report wrapper.

- [ ] **Step 1: Add RED tests** proving horizon-sized purge/embargo, train-only calibration, conservative non-overlap counting, six-pair breadth, and that high activity cannot pass when PF/Sharpe/economics fail.
- [ ] **Step 2: Run focused pytest and confirm RED.**
- [ ] **Step 3: Implement expanding purged walk-forward evaluation and atomic JSON reporting.**
- [ ] **Step 4: Run focused tests + AI Engine suite and confirm GREEN.**
- [ ] **Step 5: Commit.**

### Task 4: Bounded 5m one-fold evidence screen

**Files:**
- Create: `.github/workflows/barrier-calibrated-v5-five-minute-screen.yml`

**Interfaces:**
- Consumes exact research SHA and existing complete six-pair MTF corpus cache.
- Produces a research JSON report and Actions-log evidence only; no deployment.

- [ ] **Step 1: Add exact-SHA research workflow** using an isolated VPS research worktree and existing corpus cache.
- [ ] **Step 2: Run only 5m / one purged fold.**
- [ ] **Step 3: Record opportunities/day, mean interval, BA, PF, Sharpe, DD, positive fold/instrument fractions, LONG/SHORT balance, and governance=false.**
- [ ] **Step 4: If either economics or participation fails, stop and diagnose; do not run 20m/60m. If both pass, proceed to full multi-fold 5m before any wider study.**
