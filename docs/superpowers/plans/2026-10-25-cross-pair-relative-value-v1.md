# Cross-Pair Relative-Value v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine cheaply and leak-free whether synchronized USD-factor residuals across the six majors contain a spread-aware horizon-1 trading edge before training another model.

**Architecture:** Reuse the frozen six-pair MTF loader and its spread-aware labels, reshape synchronized decision times into a six-pair cross section, derive leave-one-out USD residuals, calibrate only a bounded residual-tail rule on outer-training data, then score one untouched outer validation fold. No ML is allowed in v1.

**Tech Stack:** Python 3.11, pandas, NumPy, existing iRexPro validation/backtest utilities, pytest, Ruff.

**Spec:** `docs/superpowers/specs/2026-10-25-cross-pair-relative-value-v1-design.md`

## Global Constraints

- Exact six frozen corpus SHA-256 values from v6 must match before evaluation.
- Horizon 1 only for the first screen.
- Cross-pair inputs are current/past causal MTF values; future labels are evaluation only.
- Inner calibration is train-only and horizon-purged; outer validation cannot select rules.
- The Oct 2–13 broker-native prospective holdout is consumed and excluded.
- Governance stays false for PAPER, DEMO, and LIVE regardless of result.

## Review Focus

- Missing one of six synchronized pairs must drop the decision period rather than impute a peer.
- USD orientation must invert EURUSD/GBPUSD/AUDUSD and preserve USDJPY/USDCAD/USDCHF.
- The leave-one-out factor must never include the scored pair itself.
- Rolling residual normalization must not use future rows.
- Pair breadth and simultaneous-signal counting must not inflate participation or positive-instrument fraction.

---

### Task 1: Cross-pair causal feature frame

**Files:**
- Create: `services/ai-engine/app/domain/training/cross_pair_relative_value.py`
- Create: `services/ai-engine/tests/test_cross_pair_relative_value.py`

**Interfaces:**
- Consumes: prepared pooled frame returned by `load_and_prepare_corpora(...)`.
- Produces: `build_cross_pair_residual_frame(frame: pd.DataFrame, *, rolling_window: int = 60) -> pd.DataFrame`.

- [x] **Step 1: Write failing tests** for exact six-pair synchronization, USD orientation, leave-one-out median residual, and past-only rolling z-score behavior.
- [x] **Step 2: Run focused tests and confirm RED for the missing module/API.**
- [x] **Step 3: Implement the minimal cross-pair residual builder.**
- [x] **Step 4: Run focused tests and Ruff GREEN.**
- [x] **Step 5: Commit.**

### Task 2: Train-only residual-tail calibration and routing

**Files:**
- Modify: `services/ai-engine/app/domain/training/cross_pair_relative_value.py`
- Modify: `services/ai-engine/tests/test_cross_pair_relative_value.py`

**Interfaces:**
- Consumes: residual frame from Task 1 with existing long/short net-return labels.
- Produces: `calibrate_relative_value_policy(...)` and `route_relative_value_signals(...)` with predeclared mean-reversion/continuation hypotheses and bounded quantile floors.

- [x] **Step 1: Add failing tests** proving calibration never sees validation rows, both sides are required, losing high-activity tails fail, and missing calibration abstains.
- [x] **Step 2: Confirm RED.**
- [x] **Step 3: Implement the minimal bounded calibration/router.**
- [x] **Step 4: Run focused tests and Ruff GREEN.**
- [x] **Step 5: Commit.**

### Task 3: One-fold early-rejection evaluator

**Files:**
- Modify: `services/ai-engine/app/domain/training/cross_pair_relative_value.py`
- Modify: `services/ai-engine/tests/test_cross_pair_relative_value.py`
- Create: `scripts/research/run_cross_pair_relative_value_v1.py`

**Interfaces:**
- Consumes: exact six corpus paths, cutoff `2026-09-22T18:23:05.100429+00:00`, horizon 1.
- Produces: atomic JSON report with calibration evidence, economics, non-overlapping participation, pair breadth, corpus hashes, and all governance flags false.

- [x] **Step 1: Add failing evaluator tests** for purge boundaries, conservative simultaneous counting, six-pair breadth denominator, hashes, and governance.
- [x] **Step 2: Confirm RED.**
- [x] **Step 3: Implement the evaluator/runner using existing validation/backtest utilities where possible.**
- [x] **Step 4: Run focused tests, Ruff, and `git diff --check` GREEN.**
- [x] **Step 5: Commit and push the exact evaluator SHA before opening validation evidence.**

### Task 4: Frozen horizon-1 screen

**Files:**
- Create: `services/ai-engine/reports/cross-pair-relative-value-v1-h1-one-fold-<sha>.json`
- Update: this plan and the design spec with the final evidence.

**Interfaces:**
- Consumes: exact-SHA evaluator from Task 3 and exact frozen corpora.
- Produces: accept/reject research decision only.

- [x] **Step 1: Run exactly one low-priority frozen horizon-1 fold.**
- [x] **Step 2: Record PF, Sharpe, DD, BA where meaningful, opportunities/day, side balance, pair breadth, and calibration policy.**
- [x] **Step 3: If economics/participation/breadth is not credible, reject immediately; do not train ML or widen horizons.**
- [x] **Step 4: If credible, preserve evidence and design a separate learned cross-pair v2 without touching PAPER/DEMO/LIVE.**

## Final Evidence — 2026-10-25

- Evaluator SHA: `34f78eac810d9656330a4224fd5486b4640e5994` (pushed before evidence was opened).
- Frozen report: `services/ai-engine/reports/cross-pair-relative-value-v1-h1-one-fold-34f78eac810d9656330a4224fd5486b4640e5994.json`.
- Report SHA-256: `3cc5ad7bdff221ce9b0b3e05dffd0759263174680ce3fc34f8cf6ada29d7850d`.
- Exact six corpus hashes matched the v6 frozen manifest.
- Train-only calibration selected the bounded mean-reversion hypothesis at quantile `0.95` / `|z| >= 2.055381`, with 4,207 active calibration rows and balanced side mix (LONG 50.72%, SHORT 49.28%).
- The calibrated tail was economically invalid: mean net return `-0.0001006548`, profit factor `0.125790`, profit throughput `-0.00000503286`, reason `NO_ECONOMIC_RESIDUAL_TAIL`.
- The policy therefore failed closed before outer validation: 0 active validation signals, 0 non-overlapping opportunities, 0.0 opportunities/day over 7 validation days. PF, Sharpe, and BA are not meaningful because no validation trades were admitted.
- Research gate: **REJECTED**. `approved_for_paper=false`, `approved_for_demo=false`, `approved_for_live=false`.
- Early-rejection rule applies: do not train a learned cross-pair v2 and do not widen this residual hypothesis to horizon 5.
