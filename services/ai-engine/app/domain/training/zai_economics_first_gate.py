"""Economics-first model research gate.

This returns research eligibility only. It cannot authorize BROKER, DEMO, or
LIVE execution. Missing holdout / cost stress / trial ledger fails closed.
Classification metrics alone cannot qualify a challenger.
"""
from __future__ import annotations

from typing import Any
import math

VERSION = "zai-economics-first-v1"


def numeric(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def assess_economics_first_candidate(
    baseline: dict[str, Any],
    candidate: dict[str, Any],
) -> dict[str, Any]:
    """Require pre-registered OOS economics + DSR/PBO and DEMO A/B evidence.

    Evidence lives in candidate['economic_validation'] and must be independently
    produced; never infer it from a classification score or staging aggregate.
    """
    evidence = candidate.get("economic_validation") or {}
    baseline_trade = (baseline.get("overall") or {}).get("trading") or {}
    candidate_trade = (candidate.get("overall") or {}).get("trading") or {}
    candidate_observed = (candidate.get("research_gate") or {}).get("observed") or {}

    reasons: list[str] = []
    def minimum(name: str, value: Any, floor: float) -> None:
        v = numeric(value)
        if v is None or v < floor:
            reasons.append(name)
    def maximum(name: str, value: Any, cap: float) -> None:
        v = numeric(value)
        if v is None or v > cap:
            reasons.append(name)

    minimum("SIX_MONTHS_OF_DATA", evidence.get("months_data"), 6)
    minimum("SIX_PURGED_WALK_FORWARD_FOLDS", evidence.get("fold_count"), 6)
    minimum("ONE_DAY_PURGE_AND_EMBARGO", evidence.get("purge_and_embargo_days"), 1)
    if evidence.get("holdout_untouched_until_selection") is not True:
        reasons.append("UNTOUCHED_HOLDOUT")
    if evidence.get("holdout_evaluations") != 1:
        reasons.append("HOLDOUT_EVALUATED_ONCE")
    minimum("TRIAL_LEDGER", evidence.get("trial_ledger_count"), 1)
    dsr = numeric(evidence.get("deflated_sharpe_ratio"))
    if dsr is None or dsr <= 0:
        reasons.append("DEF_SHARPE_NOT_POSITIVE")
    maximum("PBO_TOO_HIGH", evidence.get("probability_of_backtest_overfit"), 0.5)

    cand_expectancy = numeric(evidence.get("holdout_net_expectancy_r"))
    baseline_expectancy = numeric(evidence.get("baseline_holdout_net_expectancy_r"))
    if baseline_expectancy is None:
        reasons.append("BASELINE_HOLDOUT_EXPECTANCY_UNAVAILABLE")
    if cand_expectancy is None or cand_expectancy <= 0:
        reasons.append("CANDIDATE_EXPECTANCY_NOT_POSITIVE")
    if cand_expectancy is not None and baseline_expectancy is not None:
        if cand_expectancy < baseline_expectancy + 0.05 * abs(baseline_expectancy):
            reasons.append("NO_ECONOMIC_IMPROVEMENT")

    minimum("PROFIT_FACTOR_BELOW_115", candidate_trade.get("profit_factor"), 1.15)
    maximum("DRAWDOWN_ABOVE_12_PERCENT", candidate_trade.get("max_drawdown"), 0.12)
    minimum("POSITIVE_FOLD_FRACTION_BELOW_60_PERCENT",
            candidate_observed.get("positive_fold_fraction"), 0.60)
    minimum("COST_STRESS_1_5X_NOT_POSITIVE",
            evidence.get("stress_1_5x_p90_net_expectancy_r"), 0.0000001)
    minimum("FOUR_WEEKS_DEMO_OBSERVATION", evidence.get("demo_observation_weeks"), 4)
    minimum("DEMO_AB_WEEKS_BELOW_EIGHT", evidence.get("demo_ab_weeks"), 8)
    minimum("DEMO_AB_BASELINE_TRADES_BELOW_100", evidence.get("demo_ab_baseline_trades"), 100)
    minimum("DEMO_AB_CANDIDATE_TRADES_BELOW_100", evidence.get("demo_ab_candidate_trades"), 100)
    minimum("TWO_INDEPENDENT_DEMO_WINDOWS", evidence.get("successful_demo_windows"), 2)

    return {
        "version": VERSION,
        "research_economics_gate_passed": not reasons,
        "blockers": reasons,
        "approved_for_live": False,
        "modifies_execution": False,
        "note": (
            "Additional research qualification only; no DEMO or LIVE execution "
            "authority granted. Missing independent evidence fails closed."
        ),
    }
