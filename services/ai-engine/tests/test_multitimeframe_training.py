"""Tests for friction-aware pooled multi-timeframe XGBoost preparation/evaluation."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.domain.training.multitimeframe_corpus import build_multitimeframe_feature_corpus
from app.domain.training.train_multitimeframe import (
    MULTITIMEFRAME_FEATURE_COLUMNS,
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
