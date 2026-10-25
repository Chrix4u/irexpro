# Six-Pair Conditional Payoff v6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and evidence-test a six-pair horizon-1 candidate that chooses LONG/SHORT from probability-weighted conditional net payoff rather than raw side probability.

**Architecture:** Pair-specific barrier classifiers estimate LONG/SHORT event probabilities. Four pair-specific conditional severity regressors estimate favorable/adverse payoff in causal barrier units; their probability-weighted net payoffs choose the side, and a horizon-purged train-only calibration tail selects an economically valid 5–25% activation tail. Outer purged walk-forward remains fail-closed and research-only.

**Tech Stack:** Python, pandas, numpy, scikit-learn metrics, XGBoost, pytest.

**Spec:** `docs/superpowers/specs/2026-10-25-six-pair-conditional-payoff-v6-design.md`

## Global Constraints

- RESEARCH / SHADOW ONLY; no PAPER, DEMO, or LIVE authority.
- Exact six-pair universe: EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF.
- First screen horizon locked to 1 minute.
- Future/barrier outcome columns are labels/evaluation only, never features.
- Pair models/calibration never borrow another pair's model or threshold.
- Inner and outer boundaries are horizon-purged; outer folds also use horizon-sized embargo.
- Inner calibration retains rows >=200, activation density 5–25%, side fraction >=5%, mean realized bps >0, PF >=1.10.
- Outer gates: BA >=0.52, Sharpe >=1.0, PF >=1.15, max DD <=12%, positive folds >=60%, positive instruments >=67%, participation >=24 non-overlapping opportunities/day.
- Frequency never substitutes for economics.

## Review Focus

- A pair with insufficient LONG or SHORT conditional-event evidence must ABSTAIN/fail closed rather than reuse another pair.
- Side selection must use predicted expected net payoff, not raw LONG/SHORT probability ordering.
- Calibration must never consume outer validation rows.
- A high-density but negative-PF score tail must fail.
- Simultaneous/overlapping six-pair signals must not inflate opportunity frequency or Sharpe.

---

### Task 1: Conditional payoff scoring primitives

**Files:**
- Create: `services/ai-engine/app/domain/training/short_horizon_conditional_payoff.py`
- Create: `services/ai-engine/tests/test_short_horizon_conditional_payoff.py`

**Interfaces:**
- Produces: `ConditionalSeverityModels`, `ConditionalPayoffScore`, `_barrier_units(...)`, `score_conditional_payoff(...)`.
- Consumes: existing causal event label/return columns and pair barrier probability helpers.

- [ ] **Step 1: Write RED tests** proving favorable/adverse barrier-unit targets use only the proper event side, score outputs are finite, and the side with larger expected net payoff is selected even when its raw event probability is lower.
- [ ] **Step 2: Run the focused tests and confirm RED.**
- [ ] **Step 3: Implement the minimal pure target/scoring primitives.**
- [ ] **Step 4: Run focused tests and confirm GREEN.**
- [ ] **Step 5: Commit.**

### Task 2: Exact-pair probability + severity fitting

**Files:**
- Modify: `services/ai-engine/app/domain/training/short_horizon_conditional_payoff.py`
- Modify: `services/ai-engine/tests/test_short_horizon_conditional_payoff.py`

**Interfaces:**
- Produces: `ConditionalPayoffPairExpert`, `fit_pair_conditional_payoff_expert(...)`.
- Consumes: v5 pair LONG/SHORT probability model fitting behavior, `_split_internal_early_stopping_tail(...)`, causal MTF feature policy.

- [ ] **Step 1: Add RED tests** for exact-pair filtering, both-class classifier evidence, minimum LONG/SHORT conditional rows, and no cross-pair fallback.
- [ ] **Step 2: Confirm RED.**
- [ ] **Step 3: Fit pair LONG/SHORT event classifiers and four severity regressors using only the pair's purged fit/early-stop data.**
- [ ] **Step 4: Confirm focused tests GREEN.**
- [ ] **Step 5: Commit.**

### Task 3: Train-only economic tail calibration and routing

**Files:**
- Modify: `services/ai-engine/app/domain/training/short_horizon_conditional_payoff.py`
- Modify: `services/ai-engine/tests/test_short_horizon_conditional_payoff.py`

**Interfaces:**
- Produces: `ConditionalPayoffCalibration`, `select_conditional_payoff_calibration(...)`, `route_conditional_payoff_predictions(...)`.

- [ ] **Step 1: Add RED tests** showing calibration can discover a profitable top score tail, rejects negative economics, rejects one-sided activation, and routes failed/missing pair experts to ABSTAIN.
- [ ] **Step 2: Confirm RED.**
- [ ] **Step 3: Implement pair-specific train-only score-tail calibration with unchanged economics/side/density floors.**
- [ ] **Step 4: Confirm focused tests GREEN.**
- [ ] **Step 5: Commit.**

### Task 4: Purged six-pair walk-forward evaluator

**Files:**
- Modify: `services/ai-engine/app/domain/training/short_horizon_conditional_payoff.py`
- Create: `services/ai-engine/tests/test_short_horizon_conditional_payoff_walk_forward.py`

**Interfaces:**
- Produces: `evaluate_conditional_payoff_frame(...)`, `evaluate_conditional_payoff_corpora(...)` and atomic JSON evidence report.

- [ ] **Step 1: Add RED tests** for horizon purge/embargo, train-only calibration, six-pair breadth, pair-level calibration evidence, conservative non-overlap aggregation, and all governance flags false.
- [ ] **Step 2: Confirm RED.**
- [ ] **Step 3: Implement the evaluator and report using existing validation/backtest utilities.**
- [ ] **Step 4: Run focused suite, Ruff, and diff checks GREEN.**
- [ ] **Step 5: Commit.**

### Task 5: Bounded horizon-1 frozen-corpus screen

**Files:**
- Create: `.github/workflows/conditional-payoff-v6-one-minute-screen.yml` only if/when the local screen is promising enough to preserve as repeatable CI evidence.
- Update: `docs/superpowers/plans/2026-10-25-six-pair-conditional-payoff-v6.md`

- [ ] **Step 1: Run one local frozen-corpus outer fold using the established six-pair dataset/cutoff and historical spread-aware labels.**
- [ ] **Step 2: Record pair calibrations, opportunities/day, BA, PF, Sharpe, DD, side balance, positive-instrument fraction, and governance=false.**
- [ ] **Step 3: If economics or participation fails, stop and diagnose; do not run multi-fold or wider horizons.**
- [ ] **Step 4: If the early screen is credible, add exact-SHA CI evidence and then run multi-fold horizon 1 before any wider horizon or PAPER discussion.**
