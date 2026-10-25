from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training.short_horizon_barrier_calibrated import (
    BarrierPairCalibration,
    BarrierPairExperts,
    route_pair_barrier_predictions,
    select_barrier_pair_calibration,
)


def _balanced_side_probabilities(
    winning_probability: float,
    losing_probability: float,
    rows: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    choose_long = np.arange(rows) % 2 == 0
    long_probability = np.where(choose_long, winning_probability, losing_probability).astype(float)
    short_probability = np.where(choose_long, losing_probability, winning_probability).astype(float)
    return long_probability, short_probability, choose_long


def test_selects_profit_throughput_after_economic_floors_pass() -> None:
    rows = 1000
    long_probability = np.full(rows, 0.51, dtype=float)
    short_probability = np.full(rows, 0.49, dtype=float)
    realized_long = np.full(rows, -0.2, dtype=float)
    realized_short = np.full(rows, -0.2, dtype=float)

    high_long, high_short, high_side = _balanced_side_probabilities(0.82, 0.18, 200)
    medium_long, medium_short, medium_side = _balanced_side_probabilities(0.66, 0.24, 200)
    long_probability[:200] = high_long
    short_probability[:200] = high_short
    long_probability[200:400] = medium_long
    short_probability[200:400] = medium_short

    high_values = np.array([2.0] * 160 + [-1.0] * 40, dtype=float)
    medium_values = np.array([1.0] * 140 + [-1.0] * 60, dtype=float)
    for offset, (side_mask, values) in enumerate(
        ((high_side, high_values), (medium_side, medium_values))
    ):
        start = offset * 200
        stop = start + 200
        realized_long[start:stop] = np.where(side_mask, values, -0.5)
        realized_short[start:stop] = np.where(side_mask, -0.5, values)

    decision = select_barrier_pair_calibration(
        long_probability,
        short_probability,
        realized_long,
        realized_short,
        probability_thresholds=(0.60, 0.75),
        margin_thresholds=(0.20,),
        max_density=0.50,
    )

    assert isinstance(decision, BarrierPairCalibration)
    assert decision.passed is True
    assert decision.min_probability == 0.60
    assert decision.min_margin == 0.20
    assert decision.active_rows == 400
    assert decision.density == 0.40
    assert decision.mean_realized_bps > 0
    assert decision.profit_factor is not None
    assert decision.profit_factor >= 1.10
    assert decision.profit_throughput_bps > 0
    assert 0.05 <= decision.long_fraction <= 0.95
    assert 0.05 <= decision.short_fraction <= 0.95


def test_rejects_high_density_when_realized_economics_are_negative() -> None:
    rows = 1200
    long_probability, short_probability, _ = _balanced_side_probabilities(0.75, 0.20, rows)
    realized_long = np.full(rows, -0.5, dtype=float)
    realized_short = np.full(rows, -0.5, dtype=float)

    decision = select_barrier_pair_calibration(
        long_probability,
        short_probability,
        realized_long,
        realized_short,
    )

    assert decision.passed is False
    assert decision.reason == "NO_ECONOMIC_THRESHOLD"
    assert decision.min_probability is None
    assert decision.min_margin is None


def test_rejects_calibration_when_evidence_rows_are_insufficient() -> None:
    rows = 120
    long_probability, short_probability, _ = _balanced_side_probabilities(0.75, 0.20, rows)
    realized_long = np.full(rows, 1.0, dtype=float)
    realized_short = np.full(rows, 1.0, dtype=float)

    decision = select_barrier_pair_calibration(
        long_probability,
        short_probability,
        realized_long,
        realized_short,
    )

    assert decision.passed is False
    assert decision.reason == "INSUFFICIENT_CALIBRATION_ROWS"


def test_rejects_profitable_but_one_sided_activation() -> None:
    rows = 1200
    long_probability = np.full(rows, 0.78, dtype=float)
    short_probability = np.full(rows, 0.18, dtype=float)
    realized_long = np.full(rows, 1.2, dtype=float)
    realized_short = np.full(rows, -0.5, dtype=float)

    decision = select_barrier_pair_calibration(
        long_probability,
        short_probability,
        realized_long,
        realized_short,
    )

    assert decision.passed is False
    assert decision.reason == "NO_ECONOMIC_THRESHOLD"


def test_rejects_non_finite_probability_or_realized_input() -> None:
    rows = 1200
    long_probability, short_probability, _ = _balanced_side_probabilities(0.75, 0.20, rows)
    realized_long = np.ones(rows, dtype=float)
    realized_short = np.ones(rows, dtype=float)
    long_probability[10] = np.nan

    decision = select_barrier_pair_calibration(
        long_probability,
        short_probability,
        realized_long,
        realized_short,
    )

    assert decision.passed is False
    assert decision.reason == "NON_FINITE_CALIBRATION_INPUT"


class _FixedProbabilityModel:
    def __init__(self, probability: float) -> None:
        self.probability = probability

    def predict_proba(self, features: pd.DataFrame) -> np.ndarray:
        positive = np.full(len(features), self.probability, dtype=float)
        return np.column_stack([1.0 - positive, positive])


def _passed_calibration(
    *,
    min_probability: float = 0.60,
    min_margin: float = 0.15,
) -> BarrierPairCalibration:
    return BarrierPairCalibration(
        passed=True,
        reason="CALIBRATED",
        min_probability=min_probability,
        min_margin=min_margin,
        active_rows=250,
        density=0.20,
        mean_realized_bps=0.4,
        profit_factor=1.4,
        profit_throughput_bps=0.08,
        long_fraction=0.5,
        short_fraction=0.5,
    )


def test_routes_each_pair_through_its_exact_calibrated_experts() -> None:
    experts = {
        "EURUSD": BarrierPairExperts(
            instrument="EURUSD",
            long_model=_FixedProbabilityModel(0.76),
            short_model=_FixedProbabilityModel(0.42),
            feature_columns=("feature",),
            calibration=_passed_calibration(),
        ),
        "GBPUSD": BarrierPairExperts(
            instrument="GBPUSD",
            long_model=_FixedProbabilityModel(0.34),
            short_model=_FixedProbabilityModel(0.79),
            feature_columns=("feature",),
            calibration=_passed_calibration(),
        ),
    }
    frame = pd.DataFrame(
        {
            "instrument": ["EURUSD", "GBPUSD"],
            "feature": [1.0, 2.0],
        }
    )

    routed = route_pair_barrier_predictions(frame, experts)

    assert routed["action"].tolist() == ["BUY", "SELL"]
    assert routed["active_trade"].tolist() == [True, True]
    assert routed["route_reason"].tolist() == ["CALIBRATED_PAIR_SIGNAL", "CALIBRATED_PAIR_SIGNAL"]


def test_probability_and_margin_must_both_clear_pair_calibration() -> None:
    expert = BarrierPairExperts(
        instrument="EURUSD",
        long_model=_FixedProbabilityModel(0.72),
        short_model=_FixedProbabilityModel(0.60),
        feature_columns=("feature",),
        calibration=_passed_calibration(min_probability=0.65, min_margin=0.15),
    )
    frame = pd.DataFrame({"instrument": ["EURUSD"], "feature": [1.0]})

    routed = route_pair_barrier_predictions(frame, {"EURUSD": expert})

    assert routed.loc[0, "winning_probability"] == 0.72
    assert routed.loc[0, "probability_margin"] == 0.12
    assert routed.loc[0, "action"] == "ABSTAIN"
    assert routed.loc[0, "route_reason"] == "CALIBRATED_MARGIN_NOT_MET"


def test_missing_pair_expert_fails_closed_without_cross_pair_fallback() -> None:
    eurusd = BarrierPairExperts(
        instrument="EURUSD",
        long_model=_FixedProbabilityModel(0.80),
        short_model=_FixedProbabilityModel(0.20),
        feature_columns=("feature",),
        calibration=_passed_calibration(),
    )
    frame = pd.DataFrame(
        {
            "instrument": ["EURUSD", "USDJPY"],
            "feature": [1.0, 1.0],
        }
    )

    routed = route_pair_barrier_predictions(frame, {"EURUSD": eurusd})

    assert routed.loc[0, "action"] == "BUY"
    assert routed.loc[1, "action"] == "ABSTAIN"
    assert routed.loc[1, "route_reason"] == "MISSING_PAIR_EXPERT"
    assert np.isnan(routed.loc[1, "long_probability"])
    assert np.isnan(routed.loc[1, "short_probability"])


def test_failed_pair_calibration_abstains_even_with_strong_probabilities() -> None:
    failed = BarrierPairCalibration(
        passed=False,
        reason="NO_ECONOMIC_THRESHOLD",
        min_probability=None,
        min_margin=None,
        active_rows=0,
        density=0.0,
        mean_realized_bps=0.0,
        profit_factor=None,
        profit_throughput_bps=0.0,
        long_fraction=0.0,
        short_fraction=0.0,
    )
    expert = BarrierPairExperts(
        instrument="EURUSD",
        long_model=_FixedProbabilityModel(0.90),
        short_model=_FixedProbabilityModel(0.10),
        feature_columns=("feature",),
        calibration=failed,
    )
    frame = pd.DataFrame({"instrument": ["EURUSD"], "feature": [1.0]})

    routed = route_pair_barrier_predictions(frame, {"EURUSD": expert})

    assert routed.loc[0, "action"] == "ABSTAIN"
    assert routed.loc[0, "route_reason"] == "PAIR_CALIBRATION_FAILED"


class _ColumnProbabilityModel:
    def __init__(self, side: str) -> None:
        self.side = side
        self.fit_rows = 0

    def fit(self, features: pd.DataFrame, labels: pd.Series, **_: object) -> _ColumnProbabilityModel:
        assert len(features) == len(labels)
        self.fit_rows = len(features)
        return self

    def predict_proba(self, features: pd.DataFrame) -> np.ndarray:
        positive = features[f"{self.side}_p"].to_numpy(dtype=float)
        return np.column_stack([1.0 - positive, positive])


def test_fits_exact_pair_experts_and_calibrates_on_pair_only() -> None:
    from app.domain.training.short_horizon_barrier_calibrated import fit_pair_barrier_experts

    train_rows = 420
    training = pd.DataFrame(
        {
            "decision_time": pd.date_range("2026-01-01", periods=train_rows, freq="min", tz="UTC"),
            "instrument": ["EURUSD"] * train_rows,
            "target": np.arange(train_rows) % 2,
            "event_actionable_target": np.ones(train_rows, dtype=int),
            "event_direction_target": np.arange(train_rows) % 2,
            "long_p": np.where(np.arange(train_rows) % 2 == 1, 0.75, 0.25),
            "short_p": np.where(np.arange(train_rows) % 2 == 0, 0.75, 0.25),
        }
    )

    calibration_rows = 1000
    choose_long = np.arange(calibration_rows) % 2 == 0
    long_p = np.full(calibration_rows, 0.51, dtype=float)
    short_p = np.full(calibration_rows, 0.49, dtype=float)
    long_p[:200] = np.where(choose_long[:200], 0.80, 0.20)
    short_p[:200] = np.where(choose_long[:200], 0.20, 0.80)
    selected_bps = np.array([2.0] * 160 + [-1.0] * 40, dtype=float)
    realized_long = np.full(calibration_rows, -0.5, dtype=float)
    realized_short = np.full(calibration_rows, -0.5, dtype=float)
    realized_long[:200] = np.where(choose_long[:200], selected_bps, -0.5)
    realized_short[:200] = np.where(choose_long[:200], -0.5, selected_bps)
    calibration = pd.DataFrame(
        {
            "instrument": ["EURUSD"] * calibration_rows,
            "long_p": long_p,
            "short_p": short_p,
            "event_long_net_return": realized_long / 10_000.0,
            "event_short_net_return": realized_short / 10_000.0,
        }
    )

    experts = fit_pair_barrier_experts(
        training,
        calibration,
        instrument="EURUSD",
        horizon_bars=5,
        feature_columns=("long_p", "short_p"),
        model_factory=_ColumnProbabilityModel,
    )

    assert experts.instrument == "EURUSD"
    assert experts.long_model.fit_rows > 0
    assert experts.short_model.fit_rows > 0
    assert experts.calibration.passed is True
    assert experts.calibration.active_rows == 200
    assert experts.calibration.density == 0.20
    assert experts.calibration.long_fraction == 0.50
    assert experts.calibration.short_fraction == 0.50
