from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.domain.training.short_horizon_opportunity import (
    SHORT_HORIZON_CHALLENGER_EXPERIMENT,
    SHORT_HORIZON_MIN_PERIODS_PER_DAY,
    SHORT_HORIZON_MINUTES,
    SHORT_HORIZON_V1_EXPERIMENT,
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
    assert SHORT_HORIZON_MIN_PERIODS_PER_DAY == {5: 24.0, 20: 12.0, 60: 6.0}

    experiments = short_horizon_experiments()
    assert [experiment.name for experiment in experiments] == [
        "baseline",
        SHORT_HORIZON_V1_EXPERIMENT,
        SHORT_HORIZON_CHALLENGER_EXPERIMENT,
    ]
    assert experiments[0].mode == "directional"
    assert experiments[1].mode == "event_hybrid_dual_direction_payoff_risk"
    assert experiments[2].mode == "two_stage_event_pair_experts"
    assert experiments[2].tune_decision_threshold is False
    assert len(experiments[2].variants) == 1


def test_summary_requires_economics_and_frequency() -> None:
    passed = summarize_horizon_report(_report(research_passed=True, periods=24), horizon_minutes=5)
    assert passed["opportunities_per_validation_day"] == 24.0
    assert passed["participation_target"] == 24.0
    assert passed["research_gate_passed"] is True
    assert passed["participation_gate_passed"] is True
    assert passed["short_horizon_research_passed"] is True
    assert passed["approved_for_paper"] is False
    assert passed["approved_for_live"] is False

    too_quiet = summarize_horizon_report(
        _report(research_passed=True, periods=23), horizon_minutes=5
    )
    assert too_quiet["research_gate_passed"] is True
    assert too_quiet["participation_gate_passed"] is False
    assert too_quiet["short_horizon_research_passed"] is False

    bad_economics = summarize_horizon_report(
        _report(research_passed=False, periods=48), horizon_minutes=5
    )
    assert bad_economics["participation_gate_passed"] is True
    assert bad_economics["research_gate_passed"] is False
    assert bad_economics["short_horizon_research_passed"] is False


def test_summary_uses_outer_validation_duration_and_rejects_unknown_horizon() -> None:
    report = _report(research_passed=True, periods=12, hours=12)
    summary = summarize_horizon_report(report, horizon_minutes=5)
    assert summary["validation_days"] == 0.5
    assert summary["opportunities_per_validation_day"] == 24.0

    try:
        summarize_horizon_report(report, horizon_minutes=15)
    except ValueError as exc:
        assert "unsupported short horizon" in str(exc).lower()
    else:
        raise AssertionError("unsupported horizon must fail closed")


def test_three_horizon_runner_is_shadow_only_and_uses_fixed_matrix(tmp_path, monkeypatch) -> None:
    import pandas as pd

    import app.domain.training.short_horizon_opportunity as module

    load_calls: list[dict] = []
    run_calls: list[dict] = []

    def fake_load(datasets, *, horizon_bars, decision_time_before):
        load_calls.append(
            {
                "datasets": datasets,
                "horizon_bars": horizon_bars,
                "decision_time_before": decision_time_before,
            }
        )
        return pd.DataFrame({"target": [0, 1]}), {"EURUSD": f"sha-{horizon_bars}"}

    def fake_run(
        dataset,
        *,
        horizon_bars,
        confidence_floor,
        max_splits,
        experiments,
        checkpoint_dir,
        checkpoint_fingerprint,
    ):
        run_calls.append(
            {
                "horizon_bars": horizon_bars,
                "confidence_floor": confidence_floor,
                "max_splits": max_splits,
                "experiments": experiments,
                "checkpoint_dir": checkpoint_dir,
                "checkpoint_fingerprint": checkpoint_fingerprint,
            }
        )
        target = SHORT_HORIZON_MIN_PERIODS_PER_DAY[horizon_bars]
        return _report(
            research_passed=True,
            periods=int(target),
            hours=24,
        )

    monkeypatch.setattr(module, "load_and_prepare_corpora", fake_load)
    monkeypatch.setattr(module, "run_nested_qualification_experiments", fake_run)
    monkeypatch.setattr(
        module,
        "_qualification_checkpoint_fingerprint",
        lambda **kwargs: f"fingerprint-{kwargs['horizon_bars']}",
    )

    datasets = {
        pair: f"/tmp/{pair}_MTF.csv"
        for pair in ("EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF")
    }
    output = tmp_path / "short-horizon.json"
    result = module.evaluate_short_horizon_corpora(
        datasets,
        decision_time_before="2026-10-01T00:00:00Z",
        report_path=output,
        max_splits=3,
    )

    assert [call["horizon_bars"] for call in load_calls] == [5, 20, 60]
    assert [call["horizon_bars"] for call in run_calls] == [5, 20, 60]
    assert all(call["confidence_floor"] == 0.60 for call in run_calls)
    assert all(call["max_splits"] == 3 for call in run_calls)
    assert all(
        [experiment.name for experiment in call["experiments"]]
        == ["baseline", SHORT_HORIZON_V1_EXPERIMENT, SHORT_HORIZON_CHALLENGER_EXPERIMENT]
        for call in run_calls
    )
    assert all(
        call["experiments"][2].mode == "two_stage_event_pair_experts"
        for call in run_calls
    )
    assert result["short_horizon_research_passed"] is True
    assert set(result["horizons"]) == {"5m", "20m", "60m"}
    assert result["governance"] == {
        "shadow_only": True,
        "approved_for_paper": False,
        "approved_for_demo": False,
        "approved_for_live": False,
        "forced_trade_quota": False,
    }
    assert output.is_file()
    assert output.with_suffix(".json.tmp").exists() is False


def test_three_horizon_runner_rejects_partial_universe(tmp_path) -> None:
    import app.domain.training.short_horizon_opportunity as module

    with pytest.raises(ValueError, match="complete six-pair universe"):
        module.evaluate_short_horizon_corpora(
            {"EURUSD": "/tmp/EURUSD_MTF.csv"},
            decision_time_before="2026-10-01T00:00:00Z",
            report_path=tmp_path / "partial.json",
        )


def test_summary_excludes_fx_weekend_closure_from_active_market_days() -> None:
    start = datetime(2026, 10, 23, 20, 0, tzinfo=UTC)  # Friday
    fold = {
        "validation_start": start.isoformat(),
        "validation_end": datetime(2026, 10, 26, 1, 0, tzinfo=UTC).isoformat(),
        "aggregate": {"trading": {"trade_or_period_count": 5}},
    }
    report = {
        "experiments": {
            SHORT_HORIZON_CHALLENGER_EXPERIMENT: {
                "research_gate": {"research_gate_passed": True},
                "folds": [fold],
                "overall": {"classification": {}, "trading": {}},
            }
        }
    }

    summary = summarize_horizon_report(report, horizon_minutes=5)
    # Active FX time is Friday 20:00-21:00 plus Sunday 21:00-Monday 01:00 = 5h.
    assert summary["validation_days"] == pytest.approx(5 / 24)
    assert summary["opportunities_per_validation_day"] == pytest.approx(24.0)
    assert summary["participation_gate_passed"] is True
