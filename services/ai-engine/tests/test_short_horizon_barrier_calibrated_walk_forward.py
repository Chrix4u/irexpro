from __future__ import annotations

from collections.abc import Callable

import numpy as np
import pandas as pd

from app.domain.training.short_horizon_barrier_calibrated import (
    BarrierPairCalibration,
    BarrierPairExperts,
    _split_barrier_train_calibration,
    collapse_non_overlapping_barrier_signals,
    evaluate_barrier_calibrated_frame,
)

PAIRS = ("EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF")


def _calibration() -> BarrierPairCalibration:
    return BarrierPairCalibration(
        passed=True,
        reason="CALIBRATED",
        min_probability=0.60,
        min_margin=0.10,
        active_rows=240,
        density=0.20,
        mean_realized_bps=0.5,
        profit_factor=1.5,
        profit_throughput_bps=0.1,
        long_fraction=0.5,
        short_fraction=0.5,
    )


def _frame(periods: int, *, losing: bool = False) -> pd.DataFrame:
    times = pd.date_range("2026-01-05T00:00:00Z", periods=periods, freq="min")
    rows: list[dict[str, object]] = []
    for offset, decision_time in enumerate(times):
        for pair_index, instrument in enumerate(PAIRS):
            true_long = (offset + pair_index) % 2 == 0
            selected = -0.00010 if losing else (0.00020 if offset % 4 else -0.00010)
            rows.append(
                {
                    "decision_time": decision_time,
                    "instrument": instrument,
                    "target": int(true_long),
                    "event_actionable_target": 1,
                    "event_direction_target": int(true_long),
                    "event_long_net_return": selected if true_long else -0.00015,
                    "event_short_net_return": -0.00015 if true_long else selected,
                    "feature": float(offset % 7),
                }
            )
    return pd.DataFrame.from_records(rows)


def test_inner_calibration_tail_is_horizon_purged_from_model_fit() -> None:
    frame = _frame(400)

    fit, calibration = _split_barrier_train_calibration(frame, horizon_bars=20)

    fit_end = pd.Timestamp(fit["decision_time"].max())
    calibration_start = pd.Timestamp(calibration["decision_time"].min())
    assert calibration_start - fit_end > pd.Timedelta(minutes=20)
    assert set(fit["instrument"].unique()) == set(PAIRS)
    assert set(calibration["instrument"].unique()) == set(PAIRS)


def test_non_overlap_collapses_simultaneous_pairs_and_holding_windows() -> None:
    signals = pd.DataFrame(
        {
            "decision_time": pd.to_datetime(
                [
                    "2026-01-05T10:00:00Z",
                    "2026-01-05T10:00:00Z",
                    "2026-01-05T10:03:00Z",
                    "2026-01-05T10:05:00Z",
                ],
                utc=True,
            ),
            "active_trade": [True, True, True, True],
            "selected_net_return": [0.0010, 0.0030, 0.0100, -0.0010],
        }
    )

    periods = collapse_non_overlapping_barrier_signals(signals, horizon_bars=5)

    assert periods["decision_time"].tolist() == [
        pd.Timestamp("2026-01-05T10:00:00Z"),
        pd.Timestamp("2026-01-05T10:05:00Z"),
    ]
    assert periods["signal_count"].tolist() == [2, 1]
    assert periods["portfolio_net_return"].tolist() == [0.0020, -0.0010]


def _fake_fitter(calls: list[dict[str, object]]) -> Callable[..., BarrierPairExperts]:
    def fit(
        training_frame: pd.DataFrame,
        calibration_frame: pd.DataFrame,
        *,
        instrument: str,
        horizon_bars: int,
        **_: object,
    ) -> BarrierPairExperts:
        calls.append(
            {
                "instrument": instrument,
                "horizon_bars": horizon_bars,
                "train_max": pd.Timestamp(training_frame["decision_time"].max()),
                "calibration_max": pd.Timestamp(calibration_frame["decision_time"].max()),
            }
        )
        return BarrierPairExperts(
            instrument=instrument,
            long_model=object(),
            short_model=object(),
            feature_columns=("feature",),
            calibration=_calibration(),
        )

    return fit


def _perfect_router(
    validation: pd.DataFrame,
    _: dict[str, BarrierPairExperts],
) -> pd.DataFrame:
    result = validation.copy()
    result["predicted_long"] = result["event_direction_target"].astype(bool)
    result["active_trade"] = True
    result["action"] = np.where(result["predicted_long"], "BUY", "SELL")
    result["route_reason"] = "CALIBRATED_PAIR_SIGNAL"
    return result


def test_walk_forward_fits_all_six_pairs_without_validation_leakage() -> None:
    frame = _frame(1100)
    calls: list[dict[str, object]] = []

    report = evaluate_barrier_calibrated_frame(
        frame,
        horizon_bars=5,
        min_train_periods=300,
        validation_periods=720,
        max_splits=1,
        expert_fitter=_fake_fitter(calls),
        router=_perfect_router,
    )

    assert {call["instrument"] for call in calls} == set(PAIRS)
    assert len(calls) == 6
    validation_start = pd.Timestamp(report["folds"][0]["validation_start"])
    assert all(pd.Timestamp(call["calibration_max"]) < validation_start for call in calls)
    assert report["protocol"]["purge_periods"] == 5
    assert report["protocol"]["embargo_periods"] == 5
    assert report["approved_for_paper"] is False
    assert report["approved_for_demo"] is False
    assert report["approved_for_live"] is False


def test_high_activity_cannot_pass_when_economics_are_losing() -> None:
    frame = _frame(1100, losing=True)
    calls: list[dict[str, object]] = []

    report = evaluate_barrier_calibrated_frame(
        frame,
        horizon_bars=5,
        min_train_periods=300,
        validation_periods=720,
        max_splits=1,
        expert_fitter=_fake_fitter(calls),
        router=_perfect_router,
    )

    assert report["participation"]["opportunities_per_validation_day"] >= 24.0
    assert report["trading"]["annualization_factor"] == (
        report["participation"]["opportunities_per_validation_day"] * 260.0
    )
    assert report["gates"]["participation"] is True
    assert report["gates"]["profit_factor"] is False
    assert report["gates"]["sharpe"] is False
    assert report["research_gate_passed"] is False
