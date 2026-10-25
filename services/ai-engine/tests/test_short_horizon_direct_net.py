from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.domain.models.multitimeframe_features import INITIAL_FOREX_UNIVERSE
from app.domain.training import short_horizon_direct_net as direct_net
from app.domain.training.short_horizon_direct_net import (
    DIRECT_NET_HORIZONS,
    MAX_CALIBRATION_DENSITY,
    MIN_CALIBRATION_DENSITY,
    DirectNetCalibration,
    evaluate_direct_net_corpora,
    route_pair_direct_net_predictions,
    select_density_budgeted_threshold,
)
from app.domain.training.train_multitimeframe import (
    LONG_NET_RETURN_COLUMN,
    SHORT_NET_RETURN_COLUMN,
)


def _two_sided_predictions(rows: int) -> tuple[np.ndarray, np.ndarray]:
    predicted_best = np.linspace(-0.2, 1.8, rows, dtype=float)
    predicted_long = np.arange(rows) % 2 == 0
    return predicted_best, predicted_long


def _passed_calibration(threshold: float = 1.0) -> DirectNetCalibration:
    return DirectNetCalibration(
        passed=True,
        threshold_bps=threshold,
        reason="CALIBRATED",
        rows=250,
        density=0.10,
        mean_realized_bps=0.4,
        profit_factor=1.4,
        long_fraction=0.5,
        short_fraction=0.5,
        candidate_count=20,
    )


class _ConstantModel:
    def __init__(self, value: float) -> None:
        self.value = value

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        return np.full(len(frame), self.value, dtype=float)


def test_direct_net_horizons_are_locked() -> None:
    assert DIRECT_NET_HORIZONS == (5, 20, 60)


def test_selects_train_only_threshold_inside_density_budget() -> None:
    rows = 1000
    predicted_best, predicted_long = _two_sided_predictions(rows)
    realized = np.where(predicted_best >= 1.2, 1.8, -0.7).astype(float)

    decision = select_density_budgeted_threshold(
        predicted_best,
        predicted_long,
        realized,
    )

    assert decision.passed is True
    assert decision.threshold_bps is not None
    assert MIN_CALIBRATION_DENSITY <= decision.density <= MAX_CALIBRATION_DENSITY
    assert decision.rows >= 200
    assert decision.mean_realized_bps > 0
    assert decision.profit_factor is not None
    assert decision.profit_factor >= 1.10
    assert decision.long_fraction > 0
    assert decision.short_fraction > 0


def test_rejects_high_density_threshold_when_economics_are_negative() -> None:
    rows = 1000
    predicted_best, predicted_long = _two_sided_predictions(rows)
    realized = np.full(rows, -0.5, dtype=float)

    decision = select_density_budgeted_threshold(
        predicted_best,
        predicted_long,
        realized,
    )

    assert decision.passed is False
    assert decision.threshold_bps is None
    assert decision.reason == "NO_ECONOMIC_THRESHOLD"


def test_rejects_profitable_but_one_sided_calibration() -> None:
    rows = 1000
    predicted_best = np.linspace(0.0, 2.0, rows, dtype=float)
    predicted_long = np.ones(rows, dtype=bool)
    realized = np.where(predicted_best >= 1.2, 1.5, -0.2).astype(float)

    decision = select_density_budgeted_threshold(
        predicted_best,
        predicted_long,
        realized,
    )

    assert decision.passed is False
    assert decision.threshold_bps is None
    assert decision.reason == "NO_ECONOMIC_THRESHOLD"


def test_rejects_insufficient_calibration_rows() -> None:
    predicted_best, predicted_long = _two_sided_predictions(120)
    realized = np.full(120, 1.0, dtype=float)

    decision = select_density_budgeted_threshold(
        predicted_best,
        predicted_long,
        realized,
    )

    assert decision.passed is False
    assert decision.threshold_bps is None
    assert decision.reason == "INSUFFICIENT_CALIBRATION_ROWS"


def test_rejects_non_finite_inputs() -> None:
    predicted_best, predicted_long = _two_sided_predictions(1000)
    realized = np.ones(1000, dtype=float)
    predicted_best[5] = np.nan

    decision = select_density_budgeted_threshold(
        predicted_best,
        predicted_long,
        realized,
    )

    assert decision.passed is False
    assert decision.reason == "NON_FINITE_CALIBRATION_INPUT"


def test_routes_each_row_to_its_exact_pair_long_and_short_experts() -> None:
    frame = pd.DataFrame(
        {
            "instrument": ["EURUSD", "USDJPY"],
            "feature_x": [1.0, 2.0],
        }
    )
    models = {
        "EURUSD::long": _ConstantModel(2.0),
        "EURUSD::short": _ConstantModel(0.2),
        "USDJPY::long": _ConstantModel(0.1),
        "USDJPY::short": _ConstantModel(3.0),
    }
    calibrations = {
        "EURUSD": _passed_calibration(1.0),
        "USDJPY": _passed_calibration(1.0),
    }

    result = route_pair_direct_net_predictions(
        frame,
        models=models,
        calibrations=calibrations,
        feature_columns=["feature_x"],
    )

    assert result["predicted_long_net_bps"].tolist() == [2.0, 0.1]
    assert result["predicted_short_net_bps"].tolist() == [0.2, 3.0]
    assert result["action"].tolist() == ["BUY", "SELL"]
    assert result["active_trade"].tolist() == [True, True]


def test_missing_pair_expert_fails_closed_without_cross_pair_fallback() -> None:
    frame = pd.DataFrame({"instrument": ["USDJPY"], "feature_x": [2.0]})
    models = {
        "EURUSD::long": _ConstantModel(2.0),
        "EURUSD::short": _ConstantModel(0.2),
        "USDJPY::long": _ConstantModel(0.1),
    }

    with pytest.raises(ValueError, match=r"missing direct-net expert USDJPY::short"):
        route_pair_direct_net_predictions(
            frame,
            models=models,
            calibrations={"USDJPY": _passed_calibration(1.0)},
            feature_columns=["feature_x"],
        )


def test_failed_pair_calibration_abstains_instead_of_borrowing_threshold() -> None:
    frame = pd.DataFrame({"instrument": ["EURUSD", "USDJPY"], "feature_x": [1.0, 2.0]})
    models = {
        "EURUSD::long": _ConstantModel(2.0),
        "EURUSD::short": _ConstantModel(0.2),
        "USDJPY::long": _ConstantModel(0.1),
        "USDJPY::short": _ConstantModel(3.0),
    }
    failed = DirectNetCalibration(
        passed=False,
        threshold_bps=None,
        reason="NO_ECONOMIC_THRESHOLD",
        rows=0,
        density=0.0,
        mean_realized_bps=0.0,
        profit_factor=None,
        long_fraction=0.0,
        short_fraction=0.0,
        candidate_count=0,
    )

    result = route_pair_direct_net_predictions(
        frame,
        models=models,
        calibrations={"EURUSD": _passed_calibration(1.0), "USDJPY": failed},
        feature_columns=["feature_x"],
    )

    assert result["action"].tolist() == ["BUY", "ABSTAIN"]
    assert result["active_trade"].tolist() == [True, False]


def _runner_frame(*, positive: bool = True) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    times = pd.date_range("2026-01-05T00:00:00Z", periods=30, freq="min")
    long_pairs = set(INITIAL_FOREX_UNIVERSE[:3])
    for step, decision_time in enumerate(times):
        for instrument in INITIAL_FOREX_UNIVERSE:
            chosen_return = 0.001 if positive else -0.001
            other_return = -0.0004 if positive else -0.0012
            is_long = instrument in long_pairs
            rows.append(
                {
                    "decision_time": decision_time,
                    "instrument": instrument,
                    "feature_x": float(step),
                    LONG_NET_RETURN_COLUMN: chosen_return if is_long else other_return,
                    SHORT_NET_RETURN_COLUMN: other_return if is_long else chosen_return,
                }
            )
    return pd.DataFrame(rows)


def _install_runner_fakes(monkeypatch: pytest.MonkeyPatch, *, positive: bool = True) -> list[tuple[int, int]]:
    split_calls: list[tuple[int, int]] = []

    def fake_load(*args: object, **kwargs: object) -> tuple[pd.DataFrame, dict[str, str]]:
        del args, kwargs
        return _runner_frame(positive=positive), {
            instrument: f"sha-{instrument}" for instrument in INITIAL_FOREX_UNIVERSE
        }

    def fake_splits(
        frame: pd.DataFrame,
        *,
        time_column: str,
        min_train_periods: int,
        validation_periods: int,
        purge_periods: int,
        embargo_periods: int,
        max_splits: int,
    ):
        del min_train_periods, validation_periods, max_splits
        split_calls.append((purge_periods, embargo_periods))
        times = pd.Index(frame[time_column].drop_duplicates().sort_values())
        train = frame.loc[frame[time_column] <= times[17]].copy()
        validation = frame.loc[(frame[time_column] >= times[23]) & (frame[time_column] <= times[28])].copy()
        assert train[time_column].max() < validation[time_column].min()
        yield train, validation

    fitted_train_ends: list[pd.Timestamp] = []

    def fake_fit(
        training_window: pd.DataFrame,
        *,
        horizon_bars: int,
        feature_columns: list[str],
    ) -> tuple[dict[str, object], dict[str, DirectNetCalibration], dict[str, object]]:
        assert horizon_bars in DIRECT_NET_HORIZONS
        assert feature_columns == ["feature_x"]
        fitted_train_ends.append(training_window["decision_time"].max())
        return {}, {}, {"fit_rows": len(training_window)}

    def fake_route(
        frame: pd.DataFrame,
        *,
        models: dict[str, object],
        calibrations: dict[str, DirectNetCalibration],
        feature_columns: list[str],
    ) -> pd.DataFrame:
        del models, calibrations
        assert feature_columns == ["feature_x"]
        result = frame.copy()
        long_pairs = set(INITIAL_FOREX_UNIVERSE[:3])
        result["action"] = result["instrument"].map(
            lambda instrument: "BUY" if instrument in long_pairs else "SELL"
        )
        result["active_trade"] = True
        result["predicted_long_net_bps"] = 1.0
        result["predicted_short_net_bps"] = 0.5
        result["predicted_best_net_bps"] = 1.0
        result["activation_threshold_bps"] = 0.5
        return result

    monkeypatch.setattr(direct_net, "load_and_prepare_corpora", fake_load)
    monkeypatch.setattr(direct_net, "iter_purged_walk_forward_time_splits", fake_splits)
    monkeypatch.setattr(direct_net, "fit_pair_direct_net_experts", fake_fit)
    monkeypatch.setattr(direct_net, "route_pair_direct_net_predictions", fake_route)
    return split_calls


def test_direct_net_runner_requires_complete_six_pair_universe(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="complete six-pair universe"):
        evaluate_direct_net_corpora(
            {"EURUSD": "eurusd.csv"},
            decision_time_before="2026-09-02T20:00:00Z",
            report_path=tmp_path / "report.json",
            feature_columns=["feature_x"],
            max_splits=1,
        )


def test_direct_net_runner_uses_horizon_purge_embargo_and_outer_only_evidence(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    split_calls = _install_runner_fakes(monkeypatch, positive=True)
    report_path = tmp_path / "direct-net.json"
    datasets = {instrument: f"{instrument}.csv" for instrument in INITIAL_FOREX_UNIVERSE}

    report = evaluate_direct_net_corpora(
        datasets,
        decision_time_before="2026-09-02T20:00:00Z",
        report_path=report_path,
        feature_columns=["feature_x"],
        max_splits=1,
    )

    assert split_calls == [(5, 5), (20, 20), (60, 60)]
    assert set(report["horizons"]) == {"5m", "20m", "60m"}
    assert report["governance"] == {
        "shadow_only": True,
        "approved_for_paper": False,
        "approved_for_demo": False,
        "approved_for_live": False,
        "forced_trade_quota": False,
    }
    assert report["horizons"]["5m"]["summary"]["opportunity_count"] > 0
    assert report["horizons"]["5m"]["summary"]["opportunities_per_validation_day"] > 0
    assert report["horizons"]["5m"]["summary"]["mean_minutes_between_entries"] is not None
    assert report["horizons"]["5m"]["summary"]["positive_instrument_fraction"] == 1.0
    assert report["horizons"]["5m"]["summary"]["positive_fold_fraction"] == 1.0
    assert report_path.is_file()
    persisted = json.loads(report_path.read_text(encoding="utf-8"))
    assert persisted["governance"]["approved_for_paper"] is False


def test_direct_net_runner_does_not_pass_frequency_when_economics_lose(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _install_runner_fakes(monkeypatch, positive=False)
    datasets = {instrument: f"{instrument}.csv" for instrument in INITIAL_FOREX_UNIVERSE}

    report = evaluate_direct_net_corpora(
        datasets,
        decision_time_before="2026-09-02T20:00:00Z",
        report_path=tmp_path / "losing.json",
        feature_columns=["feature_x"],
        max_splits=1,
    )

    five = report["horizons"]["5m"]["summary"]
    assert five["opportunities_per_validation_day"] >= five["participation_target"]
    assert five["research_gate_passed"] is False
    assert five["short_horizon_research_passed"] is False
    assert report["short_horizon_research_passed"] is False
