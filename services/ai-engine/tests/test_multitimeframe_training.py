"""Tests for friction-aware pooled multi-timeframe XGBoost preparation/evaluation."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.domain.training.multitimeframe_corpus import build_multitimeframe_feature_corpus
from app.domain.training.train_multitimeframe import (
    MULTITIMEFRAME_FEATURE_COLUMNS,
    _non_overlapping_portfolio_periods,
    _trade_metrics,
    prepare_instrument_corpus,
    run_pooled_walk_forward,
)


def _m1_fixture(periods: int = 14 * 60, spread_points: float = 12.0) -> pd.DataFrame:
    index = np.arange(periods, dtype=float)
    close = 1.10 + 0.0015 * np.sin(index / 19.0) + 0.0006 * np.sin(index / 7.0)
    open_ = close + 0.00003 * np.sin(index / 5.0)
    return pd.DataFrame(
        {
            "timestamp": pd.date_range(
                "2026-01-01T00:00:00Z",
                periods=periods,
                freq="min",
            ),
            "open": open_,
            "high": np.maximum(open_, close) + 0.00008,
            "low": np.minimum(open_, close) - 0.00008,
            "close": close,
            "volume": 900.0 + (index % 53),
            "tick_volume": 900.0 + (index % 53),
            "trade_volume": 8.0 + (index % 9),
            "spread_points": spread_points + (index % 3),
            "price_digits": 5,
        }
    )


def test_prepare_instrument_corpus_uses_real_spread_and_tick_volume():
    corpus = build_multitimeframe_feature_corpus(_m1_fixture())
    prepared = prepare_instrument_corpus(
        corpus,
        instrument="EURUSD",
        horizon_bars=5,
    )

    assert not prepared.empty
    assert prepared[MULTITIMEFRAME_FEATURE_COLUMNS].notna().all().all()
    assert prepared["m1_spread_bps"].gt(0).all()
    assert prepared["m1_log_tick_volume"].gt(0).all()
    assert set(prepared["target"].unique()).issubset({0, 1})
    # Long + short returns should be negative around flat moves because both
    # directions pay real entry/exit spread.
    assert (
        prepared["long_net_return"] + prepared["short_net_return"]
    ).median() < 0


def test_prepare_instrument_corpus_keeps_both_direction_losing_periods():
    # Deliberately large spread makes many exact-horizon periods loss-making
    # in BOTH directions. Those rows still exist at runtime and therefore must
    # remain in training/evaluation rather than being removed by hindsight.
    corpus = build_multitimeframe_feature_corpus(
        _m1_fixture(spread_points=500.0)
    )
    prepared = prepare_instrument_corpus(
        corpus,
        instrument="EURUSD",
        horizon_bars=1,
    )

    both_lose = (
        (prepared["long_net_return"] < 0.0)
        & (prepared["short_net_return"] < 0.0)
    )
    assert both_lose.any()


def test_prepare_instrument_corpus_rejects_future_profitability_row_filter():
    corpus = build_multitimeframe_feature_corpus(_m1_fixture())

    with pytest.raises(ValueError, match="future.*profitability|future-profitability"):
        prepare_instrument_corpus(
            corpus,
            instrument="EURUSD",
            horizon_bars=5,
            min_net_return_bps=0.1,
        )


def test_trading_gate_equal_weights_same_time_and_skips_overlapping_horizons():
    start = pd.Timestamp("2026-01-05T10:00:00Z")
    predictions = pd.DataFrame(
        {
            "decision_time": [
                start,
                start,
                start + pd.Timedelta(minutes=1),
                start + pd.Timedelta(minutes=5),
            ],
            "active_trade": [True, True, True, True],
            "selected_net_return": [0.10, -0.02, 0.20, 0.01],
        }
    )

    periods = _non_overlapping_portfolio_periods(
        predictions,
        horizon_bars=5,
    )

    assert len(periods) == 2
    assert periods.iloc[0]["decision_time"] == start
    assert periods.iloc[0]["signal_count"] == 2
    assert periods.iloc[0]["portfolio_net_return"] == pytest.approx(0.04)
    assert periods.iloc[1]["decision_time"] == start + pd.Timedelta(minutes=5)
    assert periods.iloc[1]["portfolio_net_return"] == pytest.approx(0.01)

    metrics = _trade_metrics(predictions, horizon_bars=5)
    assert metrics["raw_active_signals"] == 4
    assert metrics["non_overlapping_periods"] == 2
    assert metrics["trade_or_period_count"] == 2
    assert metrics["total_return"] == pytest.approx((1.04 * 1.01) - 1.0)


def test_prepare_instrument_corpus_fails_closed_without_spread():
    corpus = build_multitimeframe_feature_corpus(_m1_fixture())
    corpus = corpus.drop(columns=["m1_spread_points", "m1_spread_bps"])

    with pytest.raises(ValueError, match="real-friction"):
        prepare_instrument_corpus(
            corpus,
            instrument="EURUSD",
            horizon_bars=5,
        )


def test_pooled_walk_forward_reports_pair_breakdown(monkeypatch):
    eurusd = prepare_instrument_corpus(
        build_multitimeframe_feature_corpus(_m1_fixture()),
        instrument="EURUSD",
        horizon_bars=5,
    )
    usdjpy_source = _m1_fixture().copy()
    usdjpy_source[["open", "high", "low", "close"]] *= 140.0 / 1.10
    usdjpy_source["price_digits"] = 3
    usdjpy_source["spread_points"] = 10.0 + (
        np.arange(len(usdjpy_source), dtype=float) % 3
    )
    usdjpy = prepare_instrument_corpus(
        build_multitimeframe_feature_corpus(usdjpy_source),
        instrument="USDJPY",
        horizon_bars=5,
    )
    pooled = pd.concat([eurusd, usdjpy], ignore_index=True).sort_values(
        ["decision_time", "instrument"]
    )

    class FakeModel:
        best_iteration = 3

        def fit(self, *_args, **_kwargs):
            return self

        def predict_proba(self, features):
            raw = np.asarray(features["m1_simple_return"], dtype=float)
            probability = np.where(raw >= 0, 0.67, 0.33)
            return np.column_stack([1.0 - probability, probability])

    monkeypatch.setattr(
        "app.domain.training.train_multitimeframe._build_model",
        lambda: FakeModel(),
    )

    report = run_pooled_walk_forward(
        pooled,
        horizon_bars=5,
        confidence_threshold=0.60,
        min_train_periods=180,
        validation_periods=60,
        purge_periods=5,
        embargo_periods=5,
        max_splits=2,
    )

    assert report["fold_count"] == 2
    assert report["evaluated_rows"] > 0
    assert set(report["by_instrument"]) == {"EURUSD", "USDJPY"}
    assert report["overall"]["active_trades"] > 0
    assert report["overall"]["average_spread_bps"] > 0



def test_prepare_instrument_corpus_rejects_labels_that_cross_missing_minutes():
    corpus = build_multitimeframe_feature_corpus(_m1_fixture())
    corpus = corpus.copy()
    corpus["m1_close"] = 1.0 + np.arange(len(corpus), dtype=float) * 0.001

    gap_time = pd.Timestamp("2026-01-01T08:00:00Z")
    corpus = corpus.loc[corpus["decision_time"] != gap_time].reset_index(drop=True)

    prepared = prepare_instrument_corpus(
        corpus,
        instrument="EURUSD",
        horizon_bars=5,
    )

    invalid_window = pd.date_range(
        gap_time - pd.Timedelta(minutes=5),
        gap_time - pd.Timedelta(minutes=1),
        freq="min",
    )

    assert not prepared["decision_time"].isin(invalid_window).any()
    assert pd.Timestamp("2026-01-01T07:54:00Z") in set(prepared["decision_time"])
    assert pd.Timestamp("2026-01-01T08:01:00Z") in set(prepared["decision_time"])
