"""z.ai economics-first gate must never promote on classification alone."""
from app.domain.training.zai_economics_first_gate import assess_economics_first_candidate


def base():
    return {
        "overall": {"trading": {"profit_factor": 1.0, "max_drawdown": 0.10}},
        "research_gate": {"observed": {"positive_fold_fraction": 0.6}},
    }


def candidate():
    return {
        "overall": {"trading": {"profit_factor": 1.2, "max_drawdown": 0.09}},
        "research_gate": {"observed": {"positive_fold_fraction": 0.7}},
        "economic_validation": {
            "months_data": 6,
            "fold_count": 6,
            "purge_and_embargo_days": 1,
            "holdout_untouched_until_selection": True,
            "holdout_evaluations": 1,
            "trial_ledger_count": 10,
            "deflated_sharpe_ratio": 0.5,
            "probability_of_backtest_overfit": 0.3,
            "holdout_net_expectancy_r": 0.15,
            "baseline_holdout_net_expectancy_r": 0.10,
            "stress_1_5x_p90_net_expectancy_r": 0.05,
            "demo_observation_weeks": 4,
            "demo_ab_weeks": 8,
            "demo_ab_baseline_trades": 100,
            "demo_ab_candidate_trades": 120,
            "successful_demo_windows": 2,
        },
    }


def test_missing_economic_evidence_fails_closed():
    result = assess_economics_first_candidate(base(), base())
    assert not result["research_economics_gate_passed"]
    assert not result["approved_for_live"]
    assert "DEF_SHARPE_NOT_POSITIVE" in result["blockers"]


def test_prospectively_complete_economic_bundle_qualifies_research_not_execution():
    result = assess_economics_first_candidate(base(), candidate())
    assert result["research_economics_gate_passed"]
    assert not result["approved_for_live"]
    assert not result["modifies_execution"]


def test_weak_cost_stress_and_probability_of_overfit_fail():
    challenger = candidate()
    challenger["economic_validation"]["stress_1_5x_p90_net_expectancy_r"] = -0.01
    challenger["economic_validation"]["probability_of_backtest_overfit"] = 0.55
    result = assess_economics_first_candidate(base(), challenger)
    assert not result["research_economics_gate_passed"]
    assert "COST_STRESS_1_5X_NOT_POSITIVE" in result["blockers"]
    assert "PBO_TOO_HIGH" in result["blockers"]


def test_one_demo_window_not_sufficient_even_with_strong_holdout():
    challenger = candidate()
    challenger["economic_validation"]["successful_demo_windows"] = 1
    result = assess_economics_first_candidate(base(), challenger)
    assert "TWO_INDEPENDENT_DEMO_WINDOWS" in result["blockers"]


def test_negative_expectancy_cannot_pass_on_better_accuracy():
    challenger = candidate()
    challenger["overall"]["classification"] = {"balanced_accuracy": 0.99}
    challenger["economic_validation"]["holdout_net_expectancy_r"] = -0.02
    result = assess_economics_first_candidate(base(), challenger)
    assert "CANDIDATE_EXPECTANCY_NOT_POSITIVE" in result["blockers"]
