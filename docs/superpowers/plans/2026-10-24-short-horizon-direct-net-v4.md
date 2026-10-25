# Short-Horizon Direct Net-Return v4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a leakage-safe 5/20/60-minute six-pair direct expected-net-return challenger that increases opportunity density without weakening production risk controls.

**Architecture:** Fit pair-specific LONG and SHORT net-return regressors for each horizon. Choose the economically stronger side and calibrate a bounded activation threshold only from the inner training tail; outer validation measures profitability, risk and opportunity frequency without influencing threshold selection.

**Tech Stack:** Python 3.11+, pandas, NumPy, XGBoost, scikit-learn, pytest.

**Spec:** `docs/superpowers/designs/2026-10-24-short-horizon-direct-net-v4.md`

## Global Constraints
- Horizons are exactly 5, 20 and 60 M1 bars.
- Complete six-pair universe is mandatory.
- Future prices are label/evaluation data only.
- Purge and embargo remain horizon-sized.
- Threshold selection is inner-training-only and pair-specific.
- Existing research economics/risk gates remain unchanged.
- v4 is shadow/research only; PAPER/DEMO/LIVE authority remains false.
- Participation objectives are qualification metrics, never forced-trade quotas.

## Review Focus
- Missing pair expert/threshold must fail closed rather than fall back cross-pair.
- A threshold with high density but non-positive economics must be rejected.
- A profitable threshold below the minimum evidence/density floor must be rejected.
- Outer-validation data must never select the threshold.
- LONG and SHORT representation must both remain non-zero in calibration and outer evidence.

---

### Task 1: Pure density-budget calibration policy
**Files:**
- Create: `services/ai-engine/app/domain/training/short_horizon_direct_net.py`
- Create: `services/ai-engine/tests/test_short_horizon_direct_net.py`

**Interfaces:**
- Produces `DIRECT_NET_HORIZONS`, `DirectNetCalibration`, and `select_density_budgeted_threshold(predicted_best_bps, predicted_long, realized_selected_bps) -> DirectNetCalibration`.

- [ ] Write failing tests proving bounded density, minimum evidence, PF >= 1.10, positive mean return, two-sided representation and fail-closed behavior.
- [ ] Run focused pytest and confirm RED.
- [ ] Implement the minimal train-only calibration selector.
- [ ] Run focused pytest and confirm GREEN.
- [ ] Commit.

### Task 2: Pair-specific LONG/SHORT regressors and routing
**Files:**
- Modify: `services/ai-engine/app/domain/training/short_horizon_direct_net.py`
- Test: `services/ai-engine/tests/test_short_horizon_direct_net.py`

**Interfaces:**
- Produces fit/predict functions keyed by exact `instrument::long` and `instrument::short`, plus a prediction frame containing predicted side, predicted best net bps, activation threshold and active-trade flag.

- [ ] Write failing routing tests showing EURUSD cannot use USDJPY experts and missing pair experts fail closed.
- [ ] Fit pair-specific XGB regressors from causal training windows with inner early-stop tails.
- [ ] Calibrate each pair's activation threshold from its inner tail only.
- [ ] Emit BUY/SELL/ABSTAIN predictions on outer frames.
- [ ] Run focused pytest and confirm GREEN.
- [ ] Commit.

### Task 3: Purged walk-forward multi-horizon runner
**Files:**
- Modify: `services/ai-engine/app/domain/training/short_horizon_direct_net.py`
- Test: `services/ai-engine/tests/test_short_horizon_direct_net.py`

**Interfaces:**
- Produces `evaluate_direct_net_corpora(...) -> dict[str, Any]` and CLI output with 5m/20m/60m per-pair and aggregate reports.

- [ ] Write failing orchestration test requiring complete six-pair input, horizon-sized purge/embargo, outer-only qualification metrics and research-only governance.
- [ ] Implement runner and atomic JSON report output.
- [ ] Report PF, Sharpe, drawdown, positive fold/instrument fractions, count, opportunities/day and entry interval by pair/horizon.
- [ ] Run focused tests, Ruff and compile checks.
- [ ] Commit.

### Task 4: Evidence screen and promotion decision
**Files:**
- No production authority changes.

**Interfaces:**
- Consumes sealed six-pair causal corpora and produces research evidence only.

- [ ] Run a cheap 5m one-fold early-rejection screen first.
- [ ] Reject v4 immediately if economics are not credible even when density rises.
- [ ] Only if 5m economics and density are credible, run full multi-fold 5/20/60 qualification.
- [ ] Compare directly against retained v1/v2/v3 and baseline.
- [ ] Keep `approved_for_paper=false`, `approved_for_demo=false`, `approved_for_live=false` regardless of research result.
