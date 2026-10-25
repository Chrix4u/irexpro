from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.domain.training.short_horizon_conditional_payoff import (
    _conditional_severity_targets,
    score_conditional_payoff,
)


def _event_frame() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "decision_time": pd.date_range("2026-01-01", periods=4, freq="min", tz="UTC"),
            "instrument": ["EURUSD"] * 4,
            "event_actionable_target": [1, 1, 0, 1],
            "event_direction_target": [1, 0, 1, 1],
            "event_barrier_return": [0.0002] * 4,
            "event_long_net_return": [0.0004, -0.0003, 0.0001, 0.0002],
            "event_short_net_return": [-0.0002, 0.0005, -0.0001, -0.0004],
        }
    )


def test_conditional_severity_targets_use_only_matching_event_rows() -> None:
    targets = _conditional_severity_targets(_event_frame())

    assert targets["long_favorable"].row_index.tolist() == [0, 3]
    assert targets["long_adverse"].row_index.tolist() == [1]
    assert targets["short_favorable"].row_index.tolist() == [1]
    assert targets["short_adverse"].row_index.tolist() == [0, 3]
    assert targets["long_favorable"].values.tolist() == pytest.approx([2.0, 1.0])
    assert targets["long_adverse"].values.tolist() == pytest.approx([1.5])
    assert targets["short_favorable"].values.tolist() == pytest.approx([2.5])
    assert targets["short_adverse"].values.tolist() == pytest.approx([1.0, 2.0])


def test_payoff_score_chooses_higher_expected_net_not_higher_probability() -> None:
    score = score_conditional_payoff(
        long_probability=np.array([0.40]),
        short_probability=np.array([0.60]),
        long_favorable_severity=np.array([3.0]),
        long_adverse_severity=np.array([0.5]),
        short_favorable_severity=np.array([0.8]),
        short_adverse_severity=np.array([2.0]),
    )

    assert score.long_expected_net.tolist() == pytest.approx([0.90])
    assert score.short_expected_net.tolist() == pytest.approx([-0.32])
    assert score.predicted_long.tolist() == [True]
    assert score.selected_expected_net.tolist() == pytest.approx([0.90])
    assert score.selected_payoff_ratio.tolist() == pytest.approx([4.0])


def test_payoff_score_rejects_non_finite_or_negative_severity() -> None:
    with pytest.raises(ValueError, match="finite non-negative"):
        score_conditional_payoff(
            long_probability=np.array([0.5]),
            short_probability=np.array([0.5]),
            long_favorable_severity=np.array([np.nan]),
            long_adverse_severity=np.array([0.5]),
            short_favorable_severity=np.array([0.5]),
            short_adverse_severity=np.array([0.5]),
        )

    with pytest.raises(ValueError, match="finite non-negative"):
        score_conditional_payoff(
            long_probability=np.array([0.5]),
            short_probability=np.array([0.5]),
            long_favorable_severity=np.array([-0.1]),
            long_adverse_severity=np.array([0.5]),
            short_favorable_severity=np.array([0.5]),
            short_adverse_severity=np.array([0.5]),
        )


class _RecordingClassifier:
    def __init__(self, side: str, calls: list[tuple[str, int]]) -> None:
        self.side = side
        self.calls = calls

    def fit(self, features: pd.DataFrame, labels: pd.Series, **_: object) -> _RecordingClassifier:
        self.calls.append((f"classifier:{self.side}", len(features)))
        assert set(features.columns) == {"feature"}
        assert float(features["feature"].max()) < 10_000
        assert labels.nunique() == 2
        return self

    def predict_proba(self, features: pd.DataFrame) -> np.ndarray:
        positive = np.full(len(features), 0.6, dtype=float)
        return np.column_stack([1.0 - positive, positive])


class _RecordingRegressor:
    def __init__(self, name: str, calls: list[tuple[str, int]]) -> None:
        self.name = name
        self.calls = calls

    def fit(self, features: pd.DataFrame, target: np.ndarray, **_: object) -> _RecordingRegressor:
        self.calls.append((f"regressor:{self.name}", len(features)))
        assert set(features.columns) == {"feature"}
        assert float(features["feature"].max()) < 10_000
        assert len(features) == len(target)
        return self

    def predict(self, features: pd.DataFrame) -> np.ndarray:
        return np.ones(len(features), dtype=float)


def _training_frame(periods: int = 360) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    for pair_index, instrument in enumerate(("EURUSD", "GBPUSD")):
        for offset, decision_time in enumerate(
            pd.date_range("2026-01-01", periods=periods, freq="min", tz="UTC")
        ):
            long_event = (offset + pair_index) % 2 == 0
            rows.append(
                {
                    "decision_time": decision_time,
                    "instrument": instrument,
                    "target": int(long_event),
                    "event_actionable_target": 1,
                    "event_direction_target": int(long_event),
                    "event_barrier_return": 0.0001,
                    "event_long_net_return": 0.0002 if long_event else -0.0001,
                    "event_short_net_return": -0.0001 if long_event else 0.0002,
                    "feature": float(offset + pair_index * 10_000),
                }
            )
    return pd.DataFrame(rows)


def test_pair_expert_fits_only_requested_pair_and_four_severity_models() -> None:
    from app.domain.training.short_horizon_conditional_payoff import (
        fit_pair_conditional_payoff_expert,
    )

    calls: list[tuple[str, int]] = []
    expert = fit_pair_conditional_payoff_expert(
        _training_frame(),
        instrument="EURUSD",
        horizon_bars=1,
        feature_columns=("feature",),
        classifier_factory=lambda side: _RecordingClassifier(side, calls),
        regressor_factory=lambda name: _RecordingRegressor(name, calls),
        min_conditional_fit_rows=50,
        min_conditional_early_rows=10,
    )

    assert expert.instrument == "EURUSD"
    assert expert.feature_columns == ("feature",)
    names = [name for name, _ in calls]
    assert names.count("classifier:long") == 1
    assert names.count("classifier:short") == 1
    assert {
        name for name in names if name.startswith("regressor:")
    } == {
        "regressor:long_favorable",
        "regressor:long_adverse",
        "regressor:short_favorable",
        "regressor:short_adverse",
    }
    assert all(count < 360 for _, count in calls)


def test_pair_expert_rejects_insufficient_conditional_side_evidence() -> None:
    from app.domain.training.short_horizon_conditional_payoff import (
        fit_pair_conditional_payoff_expert,
    )

    frame = _training_frame()
    eur = frame["instrument"] == "EURUSD"
    eur_rows = frame.loc[eur].sort_values("decision_time").index
    frame.loc[eur_rows, "event_direction_target"] = 1
    frame.loc[eur_rows[::40], "event_direction_target"] = 0
    frame.loc[eur_rows, "target"] = frame.loc[eur_rows, "event_direction_target"]

    calls: list[tuple[str, int]] = []
    with pytest.raises(ValueError, match="conditional .* evidence too small"):
        fit_pair_conditional_payoff_expert(
            frame,
            instrument="EURUSD",
            horizon_bars=1,
            feature_columns=("feature",),
            classifier_factory=lambda side: _RecordingClassifier(side, calls),
            regressor_factory=lambda name: _RecordingRegressor(name, calls),
            min_conditional_fit_rows=20,
            min_conditional_early_rows=5,
        )


def test_pair_expert_rejects_one_class_barrier_classifier_evidence() -> None:
    from app.domain.training.short_horizon_conditional_payoff import (
        fit_pair_conditional_payoff_expert,
    )

    frame = _training_frame()
    eur = frame["instrument"] == "EURUSD"
    frame.loc[eur, "event_actionable_target"] = 1
    frame.loc[eur, "event_direction_target"] = 1

    calls: list[tuple[str, int]] = []
    with pytest.raises(ValueError, match="(barrier expert|event classifier) requires both classes"):
        fit_pair_conditional_payoff_expert(
            frame,
            instrument="EURUSD",
            horizon_bars=1,
            feature_columns=("feature",),
            classifier_factory=lambda side: _RecordingClassifier(side, calls),
            regressor_factory=lambda name: _RecordingRegressor(name, calls),
            min_conditional_fit_rows=20,
            min_conditional_early_rows=5,
        )


def test_pair_expert_rejects_missing_exact_pair() -> None:
    from app.domain.training.short_horizon_conditional_payoff import (
        fit_pair_conditional_payoff_expert,
    )

    calls: list[tuple[str, int]] = []
    with pytest.raises(ValueError, match="missing exact-pair training rows for USDJPY"):
        fit_pair_conditional_payoff_expert(
            _training_frame(),
            instrument="USDJPY",
            horizon_bars=1,
            feature_columns=("feature",),
            classifier_factory=lambda side: _RecordingClassifier(side, calls),
            regressor_factory=lambda name: _RecordingRegressor(name, calls),
            min_conditional_fit_rows=20,
            min_conditional_early_rows=5,
        )


def _payoff_score_fixture(
    selected_expected_net: np.ndarray,
    predicted_long: np.ndarray,
):
    from app.domain.training.short_horizon_conditional_payoff import ConditionalPayoffScore

    selected_expected_net = np.asarray(selected_expected_net, dtype=float)
    predicted_long = np.asarray(predicted_long, dtype=bool)
    zeros = np.zeros(len(selected_expected_net), dtype=float)
    ones = np.ones(len(selected_expected_net), dtype=float)
    return ConditionalPayoffScore(
        long_expected_favorable=zeros.copy(),
        long_expected_adverse=zeros.copy(),
        short_expected_favorable=zeros.copy(),
        short_expected_adverse=zeros.copy(),
        long_expected_net=np.where(predicted_long, selected_expected_net, -selected_expected_net),
        short_expected_net=np.where(predicted_long, -selected_expected_net, selected_expected_net),
        predicted_long=predicted_long,
        selected_expected_favorable=ones,
        selected_expected_adverse=np.full(len(selected_expected_net), 0.5),
        selected_expected_net=selected_expected_net,
        selected_payoff_ratio=np.full(len(selected_expected_net), 2.0),
    )


def _realized_sides(
    selected_realized_bps: np.ndarray,
    predicted_long: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    selected = np.asarray(selected_realized_bps, dtype=float)
    predicted_long = np.asarray(predicted_long, dtype=bool)
    return (
        np.where(predicted_long, selected, -np.abs(selected)),
        np.where(predicted_long, -np.abs(selected), selected),
    )


def test_payoff_calibration_discovers_profitable_top_score_tail() -> None:
    from app.domain.training.short_horizon_conditional_payoff import (
        select_conditional_payoff_calibration,
    )

    n = 1000
    selected_expected_net = np.linspace(0.01, 1.0, n)
    predicted_long = np.arange(n) % 2 == 0
    selected_realized = np.full(n, -0.30, dtype=float)
    top = np.arange(n) >= 800
    selected_realized[top] = 1.0
    selected_realized[np.arange(n) >= 800] = np.where(
        np.arange(n)[top] % 10 == 0,
        -0.20,
        selected_realized[top],
    )
    long_bps, short_bps = _realized_sides(selected_realized, predicted_long)

    calibration = select_conditional_payoff_calibration(
        _payoff_score_fixture(selected_expected_net, predicted_long),
        long_bps,
        short_bps,
        min_rows=100,
    )

    assert calibration.passed is True
    assert calibration.reason == "CALIBRATED"
    assert calibration.min_expected_net is not None
    assert 0.05 <= calibration.density <= 0.25
    assert calibration.mean_realized_bps > 0.0
    assert calibration.profit_factor is not None
    assert calibration.profit_factor >= 1.10
    assert calibration.long_fraction >= 0.05
    assert calibration.short_fraction >= 0.05


def test_payoff_calibration_rejects_high_score_tail_with_negative_economics() -> None:
    from app.domain.training.short_horizon_conditional_payoff import (
        select_conditional_payoff_calibration,
    )

    n = 1000
    selected_expected_net = np.linspace(0.01, 1.0, n)
    predicted_long = np.arange(n) % 2 == 0
    long_bps, short_bps = _realized_sides(
        np.full(n, -0.25, dtype=float), predicted_long
    )

    calibration = select_conditional_payoff_calibration(
        _payoff_score_fixture(selected_expected_net, predicted_long),
        long_bps,
        short_bps,
        min_rows=100,
    )

    assert calibration.passed is False
    assert calibration.reason == "NO_ECONOMIC_SCORE_TAIL"


def test_payoff_calibration_rejects_one_sided_activation() -> None:
    from app.domain.training.short_horizon_conditional_payoff import (
        select_conditional_payoff_calibration,
    )

    n = 1000
    selected_expected_net = np.linspace(0.01, 1.0, n)
    predicted_long = np.ones(n, dtype=bool)
    long_bps = np.full(n, 1.0, dtype=float)
    short_bps = np.full(n, -0.5, dtype=float)

    calibration = select_conditional_payoff_calibration(
        _payoff_score_fixture(selected_expected_net, predicted_long),
        long_bps,
        short_bps,
        min_rows=100,
    )

    assert calibration.passed is False
    assert calibration.reason == "NO_ECONOMIC_SCORE_TAIL"


class _ConstantClassifier:
    def __init__(self, positive: float) -> None:
        self.positive = positive

    def predict_proba(self, features: pd.DataFrame) -> np.ndarray:
        positive = np.full(len(features), self.positive, dtype=float)
        return np.column_stack([1.0 - positive, positive])


class _ConstantRegressor:
    def __init__(self, value: float) -> None:
        self.value = value

    def predict(self, features: pd.DataFrame) -> np.ndarray:
        return np.full(len(features), self.value, dtype=float)


def _routing_expert(*, passed: bool = True):
    from app.domain.training.short_horizon_conditional_payoff import (
        ConditionalPayoffCalibration,
        ConditionalPayoffPairExpert,
        ConditionalSeverityModels,
    )

    calibration = ConditionalPayoffCalibration(
        passed=passed,
        reason="CALIBRATED" if passed else "NO_ECONOMIC_SCORE_TAIL",
        min_expected_net=0.50 if passed else None,
        active_rows=200 if passed else 0,
        density=0.20 if passed else 0.0,
        mean_realized_bps=0.8 if passed else 0.0,
        profit_factor=1.5 if passed else None,
        profit_throughput_bps=0.16 if passed else 0.0,
        long_fraction=0.5 if passed else 0.0,
        short_fraction=0.5 if passed else 0.0,
    )
    return ConditionalPayoffPairExpert(
        instrument="EURUSD",
        long_model=_ConstantClassifier(0.40),
        short_model=_ConstantClassifier(0.60),
        severity_models=ConditionalSeverityModels(
            long_favorable=_ConstantRegressor(3.0),
            long_adverse=_ConstantRegressor(0.5),
            short_favorable=_ConstantRegressor(0.8),
            short_adverse=_ConstantRegressor(2.0),
        ),
        feature_columns=("feature",),
        calibration=calibration,
    )


def test_payoff_router_uses_expected_net_side_and_pair_calibration() -> None:
    from app.domain.training.short_horizon_conditional_payoff import (
        route_conditional_payoff_predictions,
    )

    frame = pd.DataFrame({"instrument": ["EURUSD"], "feature": [1.0]})
    routed = route_conditional_payoff_predictions(frame, {"EURUSD": _routing_expert()})

    assert routed["long_probability"].tolist() == pytest.approx([0.40])
    assert routed["short_probability"].tolist() == pytest.approx([0.60])
    assert routed["predicted_long"].tolist() == [True]
    assert routed["selected_expected_net"].tolist() == pytest.approx([0.90])
    assert routed["active_trade"].tolist() == [True]
    assert routed["action"].tolist() == ["BUY"]
    assert routed["route_reason"].tolist() == ["CONDITIONAL_PAYOFF_SIGNAL"]


def test_payoff_router_fails_closed_for_missing_or_failed_pair_calibration() -> None:
    from app.domain.training.short_horizon_conditional_payoff import (
        route_conditional_payoff_predictions,
    )

    frame = pd.DataFrame({"instrument": ["EURUSD"], "feature": [1.0]})
    missing = route_conditional_payoff_predictions(frame, {})
    failed = route_conditional_payoff_predictions(
        frame, {"EURUSD": _routing_expert(passed=False)}
    )

    assert missing["active_trade"].tolist() == [False]
    assert missing["action"].tolist() == ["ABSTAIN"]
    assert missing["route_reason"].tolist() == ["MISSING_PAIR_EXPERT"]
    assert failed["active_trade"].tolist() == [False]
    assert failed["action"].tolist() == ["ABSTAIN"]
    assert failed["route_reason"].tolist() == ["PAIR_CALIBRATION_FAILED"]
