from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

import app.domain.training.short_horizon_direct_net as direct_net_module
from app.domain.training.short_horizon_direct_net import (
    DIRECT_NET_INSTRUMENTS,
    PARTICIPATION_TARGETS_PER_DAY,
    DirectNetCalibration,
    evaluate_direct_net_frame,
)
from app.domain.training.train_multitimeframe import (
    LONG_NET_RETURN_COLUMN,
    SHORT_NET_RETURN_COLUMN,
    TARGET_COLUMN,
)


def _six_pair_frame(periods: int = 360) -> pd.DataFrame:
    times = pd.date_range("2026-01-01T00:00:00Z", periods=periods, freq="min")
    rows: list[dict[str, object]] = []
    for index, decision_time in enumerate(times):
        for pair_index, instrument in enumerate(DIRECT_NET_INSTRUMENTS):
            direction_long = (index + pair_index) % 2 == 0
            long_return = 0.0003 if direction_long else -0.0001
            short_return = -0.0001 if direction_long else 0.0003
            rows.append(
                {
                    "decision_time": decision_time,
                    "instrument": instrument,
                    "feature_x": float(pair_index) + index / periods,
                    TARGET_COLUMN: int(direction_long),
                    LONG_NET_RETURN_COLUMN: long_return,
                    SHORT_NET_RETURN_COLUMN: short_return,
                }
            )
    return pd.DataFrame(rows)


def _passed_calibration() -> DirectNetCalibration:
    return DirectNetCalibration(
        passed=True,
        threshold_bps=0.5,
        reason="CALIBRATED",
        rows=250,
        density=0.10,
        mean_realized_bps=0.8,
        profit_factor=1.4,
        long_fraction=0.5,
        short_fraction=0.5,
        candidate_count=12,
    )


def test_walk_forward_requires_complete_six_pair_universe() -> None:
    incomplete = _six_pair_frame().loc[lambda frame: frame["instrument"] != "USDCHF"]

    with pytest.raises(ValueError, match="complete six-pair universe"):
        evaluate_direct_net_frame(
            incomplete,
            horizon_bars=5,
            feature_columns=["feature_x"],
            min_train_periods=180,
            validation_periods=50,
            max_splits=2,
        )


def test_walk_forward_uses_horizon_purge_and_reports_density_without_authority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed_boundaries: list[tuple[pd.Timestamp, pd.Timestamp]] = []

    def fit_experts(
        training_window: pd.DataFrame,
        *,
        horizon_bars: int,
        feature_columns: list[str],
    ):
        del feature_columns
        assert horizon_bars == 5
        models = {
            f"{instrument}::{side}": object()
            for instrument in DIRECT_NET_INSTRUMENTS
            for side in ("long", "short")
        }
        calibrations = {
            instrument: _passed_calibration() for instrument in DIRECT_NET_INSTRUMENTS
        }
        return models, calibrations, {"pair_count": 6, "fit_rows": len(training_window)}

    def route_predictions(
        frame: pd.DataFrame,
        *,
        models,
        calibrations,
        feature_columns: list[str],
    ) -> pd.DataFrame:
        del models, calibrations, feature_columns
        result = frame.copy()
        true_long = result[TARGET_COLUMN].to_numpy(dtype=int) == 1
        ordinal = pd.factorize(pd.to_datetime(result["decision_time"], utc=True))[0]
        # Every fifth timestamp participates; every 25th timestamp deliberately
        # picks the wrong side so PF/Sharpe are finite rather than perfect-toy values.
        predicted_long = np.where(ordinal % 25 == 0, ~true_long, true_long)
        result["predicted_long_net_bps"] = np.where(predicted_long, 3.0, -1.0)
        result["predicted_short_net_bps"] = np.where(predicted_long, -1.0, 3.0)
        result["predicted_best_net_bps"] = 3.0
        result["activation_threshold_bps"] = 0.5
        active = ordinal % 5 == 0
        result["active_trade"] = active
        result["action"] = np.where(
            active,
            np.where(predicted_long, "BUY", "SELL"),
            "ABSTAIN",
        )
        return result

    monkeypatch.setattr(direct_net_module, "fit_pair_direct_net_experts", fit_experts)
    monkeypatch.setattr(
        direct_net_module,
        "route_pair_direct_net_predictions",
        route_predictions,
    )
    original_router = direct_net_module.route_pair_direct_net_predictions

    def recording_router(frame: pd.DataFrame, **kwargs):
        result = original_router(frame, **kwargs)
        observed_boundaries.append(
            (
                pd.Timestamp(frame.attrs["outer_train_last"]),
                pd.Timestamp(frame["decision_time"].min()),
            )
        )
        return result

    monkeypatch.setattr(
        direct_net_module,
        "route_pair_direct_net_predictions",
        recording_router,
    )

    report = evaluate_direct_net_frame(
        _six_pair_frame(),
        horizon_bars=5,
        feature_columns=["feature_x"],
        min_train_periods=180,
        validation_periods=50,
        max_splits=2,
    )

    assert report["horizon_bars"] == 5
    assert report["fold_count"] == 2
    assert report["participation_target_per_day"] == PARTICIPATION_TARGETS_PER_DAY[5]
    assert report["overall"]["opportunities_per_validation_day"] > 0
    assert report["overall"]["median_minutes_between_entries"] is not None
    assert report["overall"]["trading"]["profit_factor"] is not None
    assert report["overall"]["trading"]["sharpe_ratio"] is not None
    assert set(report["by_instrument"]) == set(DIRECT_NET_INSTRUMENTS)
    assert 0.0 <= report["positive_fold_fraction"] <= 1.0
    assert 0.0 <= report["positive_instrument_fraction"] <= 1.0
    assert report["governance"] == {
        "approved_for_paper": False,
        "approved_for_demo": False,
        "approved_for_live": False,
        "research_only": True,
    }
    assert report["research_gate"]["locked_thresholds"]["profit_factor"] == 1.15
    assert report["research_gate"]["locked_thresholds"]["sharpe_ratio"] == 1.0
    assert observed_boundaries
    for train_last, validation_first in observed_boundaries:
        assert validation_first - train_last >= pd.Timedelta(minutes=6)


def test_walk_forward_rejects_unsupported_horizon() -> None:
    with pytest.raises(ValueError, match="unsupported direct-net horizon"):
        evaluate_direct_net_frame(
            _six_pair_frame(),
            horizon_bars=15,
            feature_columns=["feature_x"],
        )
