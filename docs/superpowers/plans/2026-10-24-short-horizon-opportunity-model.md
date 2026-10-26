# Short-Horizon Opportunity Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate a leakage-safe 5/20/60-minute BUY/SELL/ABSTAIN opportunity challenger that must satisfy both profitability/risk and minimum participation evidence.

**Architecture:** Reuse the six-pair causal MTF corpus and nested qualification engine. Preserve the locked baseline, pooled hybrid payoff-risk v1, and pair-expert v2 as controls. The active v3 challenger keeps opportunity detection pooled for breadth while training independent LONG/SHORT classifiers and expected upside/downside regressors per instrument. Aggregate economics, risk, breadth, and opportunity frequency into a research-only report.

**Tech Stack:** Python 3.11+, pandas, NumPy, XGBoost, scikit-learn, pytest.

**Spec:** `docs/superpowers/designs/2026-10-24-short-horizon-opportunity-model.md`

## Global Constraints
- Horizons are exactly 5, 20, and 60 M1 bars.
- Confidence floor remains >= 0.60.
- Payoff/risk floor remains 1.15.
- Purge and embargo remain horizon-sized.
- Existing research economics/risk gates remain unchanged.
- Challenger is shadow/research only; no PAPER/DEMO/LIVE authority.
- Participation targets are qualification metrics, not forced-trade quotas.
- Pair routing is exact and fail-closed; no cross-pair fallback.

## Review Focus
- Reject unsupported horizons.
- Do not mark a horizon passed when economics pass but participation fails.
- Do not mark a horizon passed when participation passes but the locked research gate fails.
- Compute frequency from outer-validation time only, not training periods.
- Preserve baseline-first experiment ordering required by qualification.
- Verify pair-specific direction and payoff models receive only their own instrument rows.
- Keep future prices strictly in label/evaluation paths.

---

### Task 1: Horizon research contract
**Files:**
- Create: `services/ai-engine/app/domain/training/short_horizon_opportunity.py`
- Create: `services/ai-engine/tests/test_short_horizon_opportunity.py`

**Interfaces:**
- Produces `SHORT_HORIZON_MINUTES`, `SHORT_HORIZON_MIN_PERIODS_PER_DAY`, `short_horizon_experiments()`, and `summarize_horizon_report()`.

- [x] Write failing tests for 5/20/60 horizon definitions, experiment ordering, participation-rate calculation, and fail-closed qualification composition.
- [x] Run focused pytest and confirm RED during the original contract implementation.
- [x] Implement the pure contract and summary functions.
- [x] Run focused pytest and confirm GREEN.
- [x] Commit.

### Task 2: Three-horizon research runner
**Files:**
- Modify: `services/ai-engine/app/domain/training/short_horizon_opportunity.py`
- Test: `services/ai-engine/tests/test_short_horizon_opportunity.py`

**Interfaces:**
- Produces `evaluate_short_horizon_corpora(...) -> dict[str, Any]` and CLI entrypoint.

- [x] Write orchestration tests requiring all three horizons, fixed confidence 0.60, horizon-specific qualification, active-FX-day participation accounting, and research-only governance.
- [x] Implement corpus loading + nested qualification per horizon with atomic JSON output.
- [x] Run focused tests, formatting/lint and compile checks.
- [x] Commit.

### Task 3: Reject static gateway relaxation as the primary solution
- [x] Preserve evidence from the 4,032-combination gateway grid: no static combination met participation plus PF >= 1.15 and positive average R.
- [x] Preserve Friday pulse-scout replay evidence: four rescued candidates, 1W/3L, -2.11R.
- [x] Preserve local-impulse replay evidence: approximately PF 1.009 at 5m, 0.409 at 20m, 1.075 at 60m.
- [x] Keep those lanes selective rather than broadening them into forced frequency.

### Task 4: Replace redundant v2 with pair-specific payoff-risk v3
**Files:**
- Modify: `services/ai-engine/app/domain/training/model_qualification.py`
- Modify: `services/ai-engine/app/domain/training/short_horizon_opportunity.py`
- Test: `services/ai-engine/tests/test_short_horizon_opportunity.py`

- [x] Demonstrate retained v2 is structurally the same `two_stage_event_pair_experts` family that previously concentrated 58/62 5m trades in one fold.
- [x] Define v3 contract as pooled opportunity + pair-specific LONG/SHORT + pair-specific upside/downside payoff models.
- [x] Create RED contract head `080369b18e2bdffcf0cf3bf46060cb032d9a9cd6` and verify AI Engine CI fails for the intended missing v3 symbol.
- [x] Implement exact-instrument pair routing and fail closed when an expert is missing.
- [x] Add routing regression test.
- [x] Run focused tests: 7/7 passed.
- [x] Run exact-head AI Engine CI on implementation head `b47a2cb9ca6572141055aee5952a004be9fd0214`: passed.
- [x] Run exact-head Release Security: passed.
- [x] Run exact-head Required CI Gate: passed.

### Task 5: Fail-fast 5-minute evidence screen
**Evidence inputs:**
- sealed causal feature cache: 474,700 rows x 130 columns,
- immutable six-pair corpora rooted at research set `341e107b0066f26b3b373e29a2329f007bda35b4`,
- protected cutoff: `2026-09-02T19:59:00+00:00`.

- [x] Rebuild 5m forward labels from only `decision_time`, `m1_close`, `m1_spread_bps`, and `m1_atr_pct_14` while keeping the full outcome horizon before the cutoff.
- [x] Merge labels with sealed causal features; resulting screen dataset is 467,701 rows ending at 2026-09-02 19:53 UTC.
- [x] Run one-fold baseline checkpoint; baseline produced zero active trades in the fold and BA 0.5017.
- [ ] Complete pooled v1, retained v2, and pair-specific v3 checkpoints.
- [ ] Record v3 BA, PF, Sharpe, drawdown, active periods/day, fold result, and instrument breadth.
- [ ] Reject v3 immediately if economics or participation are not materially credible.

### Task 6: Multi-fold evidence only after screen survival
- [ ] If v3 survives Task 5, run multi-fold 5m qualification first.
- [ ] Require the existing BA >= 0.52, PF >= 1.15, Sharpe >= 1.0, Max DD <= 12%, positive-fold >= 60%, positive-instrument >= 67%, plus >=24 non-overlapping opportunities per active FX validation day.
- [ ] Only after 5m survives, extend the same architecture to 20m and 60m with targets 12/day and 6/day respectively.
- [ ] Record cost-stress and pair/fold breadth before considering any authority change.

### Task 7: Authority remains separate
- [ ] Keep this PR draft and shadow-only regardless of an early screen result.
- [ ] Do not merge research success directly into PAPER execution authority.
- [ ] If qualification succeeds, create a separate reviewed PAPER-shadow/limited-authority change with explicit candidate/cohort provenance.
- [ ] DEMO/LIVE authority remains false until separate forward evidence and review.
