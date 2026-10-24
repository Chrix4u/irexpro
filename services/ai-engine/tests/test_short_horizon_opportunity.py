from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.domain.training.short_horizon_opportunity import (
    SHORT_HORIZON_CHALLENGER_EXPERIMENT,
    SHORT_HORIZON_MIN_PERIODS_PER_DAY,
    SHORT_HORIZON_MINUTES,
    short_horizon_experiments,
    summarize_horizon_report,
)


def _fold(start: datetime, *, hours: int, periods: int) -> dict:
    return {
        "validation_start": start.isoformat(),
        "validation_end": (start + timedelta(hours=hours)).isoformat(),
        "aggregate": {"trading": {"trade_or_period_count": periods}},
    }


def _report(*, research_passed: bool, periods: int, hours: int = 24) -> dict:
    start = datetime(2026, 10, 19, tzinfo=UTC)
    return {
        "experiments": {
            SHORT_HORIZON_CHALLENGER_EXPERIMENT: {
                "research_gate": {"research_gate_passed": research_passed},
                "folds": [_fold(start, hours=hours, periods=periods)],
                "overall": {
                    "trading": {
                        "profit_factor": 1.4,
                        "sharpe_ratio": 1.2,
                        "max_drawdown": 0.04,
                    },
                    "classification": {"balanced_accuracy": 0.54},
                },
            }
        }
    }


def test_short_horizon_contract_is_exact_and_baseline_first() -> None:
    assert SHORT_HORIZON_MINUTES == (5, 20, 60)
    assert SHORT_HORIZON_MIN_PERIODS_PER_DAY == {5: 6.0, 20: 4.0, 60: 2.0}

    experiments = short_horizon_experiments()
    assert [experiment.name for experiment in experiments] == [
        "baseline",
        SHORT_HORIZON_CHALLENGER_EXPERIMENT,
    ]
    assert experiments[0].mode == "directional"
    assert experiments[1].mode == "event_hybrid_dual_direction_payoff_risk"
    assert experiments[1].tune_decision_threshold is False
    assert len(experiments[1].variants) == 1


def test_summary_requires_economics_and_frequency() -> None:
    passed = summarize_horizon_report(_report(research_passed=True, periods=6), horizon_minutes=5)
    assert passed["opportunities_per_validation_day"] == 6.0
    assert passed["participation_target"] == 6.0
    assert passed["research_gate_passed"] is True
    assert passed["participation_gate_passed"] is True
    assert passed["short_horizon_research_passed"] is True
    assert passed["approved_for_paper"] is False
    assert passed["approved_for_live"] is False

    too_quiet = summarize_horizon_report(
        _report(research_passed=True, periods=5), horizon_minutes=5
    )
    assert too_quiet["research_gate_passed"] is True
    assert too_quiet["participation_gate_passed"] is False
    assert too_quiet["short_horizon_research_passed"] is False

    bad_economics = summarize_horizon_report(
        _report(research_passed=False, periods=12), horizon_minutes=5
    )
    assert bad_economics["participation_gate_passed"] is True
    assert bad_economics["research_gate_passed"] is False
    assert bad_economics["short_horizon_research_passed"] is False


def test_summary_uses_outer_validation_duration_and_rejects_unknown_horizon() -> None:
    report = _report(research_passed=True, periods=3, hours=12)
    summary = summarize_horizon_report(report, horizon_minutes=5)
    assert summary["validation_days"] == 0.5
    assert summary["opportunities_per_validation_day"] == 6.0

    try:
        summarize_horizon_report(report, horizon_minutes=15)
    except ValueError as exc:
        assert "unsupported short horizon" in str(exc).lower()
    else:
        raise AssertionError("unsupported horizon must fail closed")
