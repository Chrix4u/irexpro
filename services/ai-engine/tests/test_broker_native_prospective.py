from __future__ import annotations

import numpy as np
import pandas as pd

from app.domain.training.broker_native_prospective import (
    PAIRS,
    build_prospective_pair_frame,
    build_prospective_report,
    calculate_performance,
    chronological_fit_calibration_split,
    chronological_time_fit_calibration_split,
    contiguous_context_mask,
    fit_fixed_base_predictions,
    select_fixed_trades,
)


def _raw_frame(start: str, periods: int, *, pair: str = "EURUSD") -> pd.DataFrame:
    times = pd.date_range(start, periods=periods, freq="min")
    base = 1.10000 + np.arange(periods, dtype=float) * 0.000001
    return pd.DataFrame(
        {
            "timestamp": times,
            "open": base,
            "high": base + 0.00003,
            "low": base - 0.00003,
            "close": base + 0.00001,
            "tickVolume": np.full(periods, 50.0),
            "spreadPoints": np.full(periods, 10.0),
            "priceDigits": np.full(periods, 5),
            "instrument": pair,
            "source": "broker",
        }
    )


def test_contiguous_context_mask_requires_past_and_future_minutes() -> None:
    times = list(pd.date_range("2026-10-03T00:00:00Z", periods=14, freq="min"))
    del times[7]
    mask = contiguous_context_mask(pd.Series(times), lookback_bars=3, horizon_bars=2)

    kept = pd.Series(times)[mask].tolist()
    assert pd.Timestamp("2026-10-03T00:03:00Z") in kept
    assert pd.Timestamp("2026-10-03T00:04:00Z") in kept
    assert pd.Timestamp("2026-10-03T00:05:00Z") not in kept
    assert pd.Timestamp("2026-10-03T00:08:00Z") not in kept
    assert pd.Timestamp("2026-10-03T00:10:00Z") not in kept
    assert pd.Timestamp("2026-10-03T00:11:00Z") in kept


def test_prospective_pair_frame_never_uses_holdout_to_build_development() -> None:
    development = _raw_frame("2026-10-02T16:00:00Z", 300)
    cutoff = pd.Timestamp("2026-10-02T20:59:00Z")
    holdout = _raw_frame("2026-10-02T21:00:00Z", 180)
    holdout.loc[80:, "source"] = "metaapi-rpc-sampled"

    prepared = build_prospective_pair_frame(
        development,
        holdout,
        pair="EURUSD",
        cutoff=cutoff,
        horizon_bars=5,
        lookback_bars=60,
    )

    dev = prepared["development"]
    future = prepared["holdout"]
    assert not dev.empty
    assert not future.empty
    assert pd.Timestamp(dev["timestamp"].max()) <= cutoff
    assert pd.Timestamp(future["timestamp"].min()) > cutoff
    assert set(future["source"].astype(str)) <= {"broker", "metaapi-rpc-sampled"}
    assert "event_long_5" in future
    assert "event_short_5" in future


def test_prospective_pair_frame_drops_rows_that_cross_holdout_gaps() -> None:
    development = _raw_frame("2026-10-02T16:00:00Z", 300)
    cutoff = pd.Timestamp("2026-10-02T20:59:00Z")
    holdout = _raw_frame("2026-10-02T21:00:00Z", 180)
    holdout = holdout.drop(index=90).reset_index(drop=True)

    prepared = build_prospective_pair_frame(
        development,
        holdout,
        pair="EURUSD",
        cutoff=cutoff,
        horizon_bars=5,
        lookback_bars=60,
    )
    future_times = set(pd.to_datetime(prepared["holdout"]["timestamp"], utc=True))

    gap = pd.Timestamp("2026-10-02T22:30:00Z")
    for minute in range(-5, 61):
        assert gap + pd.Timedelta(minutes=minute) not in future_times


def test_fit_calibration_split_is_purged_and_development_only() -> None:
    frame = pd.DataFrame(
        {
            "timestamp": pd.date_range("2026-09-01T00:00:00Z", periods=1000, freq="min"),
            "feature": np.arange(1000, dtype=float),
        }
    )
    fit, calibration = chronological_fit_calibration_split(
        frame,
        horizon_bars=5,
        calibration_fraction=0.20,
        min_calibration_rows=100,
    )

    assert len(fit) > 0
    assert len(calibration) >= 100
    assert pd.Timestamp(fit["timestamp"].max()) + pd.Timedelta(minutes=5) < pd.Timestamp(
        calibration["timestamp"].min()
    )
    assert set(fit.index).isdisjoint(set(calibration.index))


def test_select_fixed_trades_uses_locked_floors_and_non_overlap() -> None:
    frame = pd.DataFrame(
        {
            "timestamp": pd.to_datetime(
                [
                    "2026-10-03T00:00:00Z",
                    "2026-10-03T00:01:00Z",
                    "2026-10-03T00:02:00Z",
                    "2026-10-03T00:04:00Z",
                ],
                utc=True,
            ),
            "pair": ["EURUSD"] * 4,
            "actionable_5": [1, 1, 1, 1],
            "direction_long_5": [1, 1, 0, 0],
            "event_long_5": [0.001, 0.001, -0.001, -0.001],
            "event_short_5": [-0.001, -0.001, 0.001, 0.001],
            "event_step_5": [2, 1, 2, 1],
        }
    )
    trades = select_fixed_trades(
        frame,
        action_probability=np.array([0.55, 0.80, 0.80, 0.80]),
        direction_long_probability=np.array([0.90, 0.54, 0.10, 0.10]),
        horizon_bars=5,
    )

    assert trades["timestamp"].tolist() == [
        pd.Timestamp("2026-10-03T00:00:00Z"),
        pd.Timestamp("2026-10-03T00:02:00Z"),
        pd.Timestamp("2026-10-03T00:04:00Z"),
    ]
    assert trades["predicted_long"].tolist() == [True, False, False]
    assert trades["net_return"].tolist() == [0.001, 0.001, 0.001]


def test_prospective_report_is_never_promotion_eligible_even_if_metrics_pass() -> None:
    metrics = {
        "n": 150,
        "profit_factor": 1.50,
        "sharpe": 2.0,
        "max_drawdown": 0.01,
        "balanced_accuracy": 0.55,
        "positive_instrument_fraction": 0.83,
        "median_gap_minutes": 5.0,
        "mean_confidence": 0.70,
        "net_return": 0.02,
        "win_rate": 0.60,
    }
    report = build_prospective_report(
        metrics=metrics,
        positive_fold_fraction=1.0,
        holdout_rows=40_000,
        development_cutoff="2026-10-02T21:00:00Z",
        holdout_manifest_sha256="abc123",
    )

    assert report["economic_screen_passed"] is True
    assert report["promotion_eligible"] is False
    assert report["approved_for_paper"] is False
    assert report["approved_for_demo"] is False
    assert report["approved_for_live"] is False
    assert report["mode"] == "FALSIFICATION_ONLY_UNTOUCHED_POST_CUTOFF"


def test_pooled_time_split_keeps_whole_timestamps_and_purges_horizon() -> None:
    times = pd.date_range("2026-09-01T00:00:00Z", periods=500, freq="min")
    frame = pd.DataFrame(
        [
            {"timestamp": timestamp, "pair": pair, "feature": float(index)}
            for index, timestamp in enumerate(times)
            for pair in ("EURUSD", "GBPUSD")
        ]
    )
    fit, calibration = chronological_time_fit_calibration_split(
        frame,
        horizon_bars=5,
        calibration_fraction=0.20,
        min_calibration_timestamps=50,
    )

    fit_times = set(pd.to_datetime(fit["timestamp"], utc=True))
    calibration_times = set(pd.to_datetime(calibration["timestamp"], utc=True))
    assert fit_times.isdisjoint(calibration_times)
    assert pd.Timestamp(fit["timestamp"].max()) + pd.Timedelta(minutes=5) < pd.Timestamp(
        calibration["timestamp"].min()
    )
    assert set(fit.groupby("timestamp")["pair"].nunique()) == {2}
    assert set(calibration.groupby("timestamp")["pair"].nunique()) == {2}


def test_performance_breadth_uses_all_six_pairs_as_denominator() -> None:
    trades = pd.DataFrame(
        {
            "timestamp": pd.to_datetime(
                ["2026-10-03T00:00:00Z", "2026-10-03T00:05:00Z"], utc=True
            ),
            "pair": ["EURUSD", "EURUSD"],
            "net_return": [0.0010, 0.0010],
            "p_action": [0.70, 0.70],
            "predicted_long": [True, False],
            "direction_long_5": [1, 0],
        }
    )
    metrics = calculate_performance(trades, horizon_bars=5, expected_pairs=PAIRS)

    assert metrics["n"] == 2
    assert metrics["net_return"] == 0.002
    assert metrics["profit_factor"] is None
    assert metrics["balanced_accuracy"] == 1.0
    assert metrics["positive_instrument_fraction"] == 1 / 6
    assert metrics["median_gap_minutes"] == 5.0


class _NoFutureFitClassifier:
    def fit(self, features: pd.DataFrame, target: pd.Series) -> _NoFutureFitClassifier:
        assert float(features["ret1_bps"].max()) < 10_000.0
        self._positive_rate = float(pd.Series(target).mean())
        return self

    def predict_proba(self, features: pd.DataFrame) -> np.ndarray:
        probability = np.full(len(features), 0.60, dtype=float)
        return np.column_stack([1.0 - probability, probability])


def _prepared_model_frame(start: str, periods: int, *, future: bool) -> pd.DataFrame:
    times = pd.date_range(start, periods=periods, freq="min")
    values = np.arange(periods, dtype=float) + (20_000.0 if future else 0.0)
    rows: list[dict[str, object]] = []
    for index, timestamp in enumerate(times):
        pair = PAIRS[index % len(PAIRS)]
        row: dict[str, object] = {
            "timestamp": timestamp,
            "pair": pair,
            "instrument": pair,
            "actionable_5": index % 2,
            "direction_long_5": (index // 2) % 2,
            "event_long_5": 0.001,
            "event_short_5": -0.001,
            "event_step_5": 5,
        }
        for feature in (
            "ret1_bps",
            "ret2_bps",
            "ret5_bps",
            "ret10_bps",
            "range_bps",
            "body_bps",
            "close_location",
            "atr_pct_14",
            "vol10_bps",
            "vol20_bps",
            "vol60_bps",
            "ema5_20_bps",
            "ema10_40_bps",
            "rsi14",
            "hour_sin",
            "hour_cos",
            "dow_sin",
            "dow_cos",
        ):
            row[feature] = values[index]
        for candidate in PAIRS:
            row[f"pair_{candidate}"] = float(pair == candidate)
        rows.append(row)
    return pd.DataFrame.from_records(rows)


def test_fixed_model_fit_never_sees_prospective_feature_values() -> None:
    development = _prepared_model_frame("2026-09-01T00:00:00Z", 900, future=False)
    holdout = _prepared_model_frame("2026-10-03T00:00:00Z", 180, future=True)

    result = fit_fixed_base_predictions(
        development,
        holdout,
        horizon_bars=5,
        min_calibration_timestamps=100,
        classifier_factory=_NoFutureFitClassifier,
    )

    assert len(result["action_probability"]) == len(holdout)
    assert len(result["direction_long_probability"]) == len(holdout)
    assert pd.Timestamp(result["fit_end"]) < pd.Timestamp(result["calibration_start"])
    assert pd.Timestamp(result["calibration_end"]) < pd.Timestamp(holdout["timestamp"].min())
