# Short-Horizon Opportunity Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate a leakage-safe 5/20/60-minute BUY/SELL/ABSTAIN opportunity challenger that must satisfy both profitability/risk and minimum participation evidence.

**Architecture:** Reuse the current six-pair causal MTF corpus and nested qualification engine. Run the locked baseline and a fixed event-barrier hybrid payoff-risk challenger independently at each horizon, then aggregate economics, risk, and opportunity frequency into one research-only report.

**Tech Stack:** Python 3.11+, pandas, NumPy, XGBoost, scikit-learn, pytest.

**Spec:** `docs/superpowers/designs/2026-10-24-short-horizon-opportunity-model.md`

## Global Constraints
- Horizons are exactly 5, 20, and 60 M1 bars.
- Confidence floor remains >= 0.60.
- Purge and embargo remain horizon-sized.
- Existing research economics/risk gates remain unchanged.
- Challenger is shadow/research only; no PAPER/DEMO/LIVE authority.
- Participation targets are qualification metrics, not forced-trade quotas.

## Review Focus
- Reject unsupported horizons.
- Do not mark a horizon passed when economics pass but participation fails.
- Do not mark a horizon passed when participation passes but the locked research gate fails.
- Compute frequency from outer-validation time only, not training periods.
- Preserve baseline-first experiment ordering required by qualification.

---

### Task 1: Horizon research contract
**Files:**
- Create: `services/ai-engine/app/domain/training/short_horizon_opportunity.py`
- Create: `services/ai-engine/tests/test_short_horizon_opportunity.py`

**Interfaces:**
- Produces `SHORT_HORIZON_MINUTES`, `SHORT_HORIZON_MIN_PERIODS_PER_DAY`, `short_horizon_experiments()`, and `summarize_horizon_report()`.

- [ ] Write failing tests for 5/20/60 horizon definitions, baseline+hybrid experiment ordering, participation-rate calculation, and fail-closed qualification composition.
- [ ] Run focused pytest and confirm RED.
- [ ] Implement the minimal pure contract and summary functions.
- [ ] Run focused pytest and confirm GREEN.
- [ ] Commit.

### Task 2: Three-horizon research runner
**Files:**
- Modify: `services/ai-engine/app/domain/training/short_horizon_opportunity.py`
- Test: `services/ai-engine/tests/test_short_horizon_opportunity.py`

**Interfaces:**
- Produces `evaluate_short_horizon_corpora(...) -> dict[str, Any]` and CLI entrypoint.

- [ ] Write failing orchestration test with qualification functions mocked; require all three horizons, fixed confidence 0.60, horizon-specific purge semantics through existing evaluator, and research-only governance.
- [ ] Implement corpus loading + nested qualification per horizon with atomic JSON output.
- [ ] Run focused tests, AI-engine formatting/lint and compile checks.
- [ ] Commit.

### Task 3: Evidence run
**Files:**
- No production authority changes.

- [ ] Run the challenger against the retained six-pair 100k-row corpora (or regenerate through the secured existing workflow if local corpora are unavailable).
- [ ] Record 5/20/60 economics, drawdown, positive fold/instrument fractions, active opportunity frequency, and qualification result.
- [ ] Keep challenger shadow-only regardless of result; PAPER authority requires a separate reviewed change.
