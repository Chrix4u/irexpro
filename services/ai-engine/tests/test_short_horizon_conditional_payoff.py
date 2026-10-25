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
