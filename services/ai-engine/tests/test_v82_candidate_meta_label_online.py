from __future__ import annotations

from datetime import timedelta

import numpy as np
import pandas as pd

from app.domain.training.v82_candidate_meta_label_online import (
    DelayedMetaModel,
    Event,
    FEATURES,
    OnlineLogistic,
    Prediction,
    _balanced_accuracy,
    _performance,
    choose_threshold,
)


def event(
    *,
    scan: str,
    exit_minutes: int,
    r: float,
    symbol: str = "EURUSD",
    direction: str = "BUY",
    feature_index: int | None = None,
) -> Event:
    scan_time = pd.Timestamp(scan)
    if scan_time.tzinfo is None:
        scan_time = scan_time.tz_localize("UTC")
    x = np.zeros(len(FEATURES), dtype=float)
    x[0] = 1.0
    if feature_index is not None:
        x[feature_index] = 1.0
    return Event(
        symbol=symbol,
        direction=direction,
        scan_time=scan_time,
        exit_time=scan_time + timedelta(minutes=exit_minutes),
        r_multiple=r,
        features=x,
    )


def test_delayed_label_does_not_update_before_exit_time():
    model = DelayedMetaModel()
    first = event(scan="2026-01-01T00:00:00Z", exit_minutes=30, r=1.0)

    before = model.score(first)
    model.observe(first)

    second = event(scan="2026-01-01T00:05:00Z", exit_minutes=10, r=-1.0)
    still_before = model.score(second)

    assert before == 0.5
    assert still_before == 0.5
    assert model.global_model.positive_updates == 0
    assert model.global_model.negative_updates == 0


def test_label_updates_only_after_exit_and_changes_future_probability():
    model = DelayedMetaModel()
    first = event(scan="2026-01-01T00:00:00Z", exit_minutes=5, r=1.0)
    model.observe(first)

    later = event(scan="2026-01-01T00:10:00Z", exit_minutes=5, r=-1.0)
    probability = model.score(later)

    assert model.global_model.positive_updates == 1
    assert probability > 0.5


def test_pair_model_is_not_blended_before_minimum_resolved_support():
    model = DelayedMetaModel()
    x = event(scan="2026-01-01T00:00:00Z", exit_minutes=1, r=1.0)

    model.global_model.weights[0] = 2.0
    model.pair_models["EURUSD"].weights[0] = -2.0
    model.pair_resolved["EURUSD"] = 59
    global_only = model.score(x)

    model.pair_resolved["EURUSD"] = 60
    blended = model.score(x)

    assert global_only > 0.8
    assert blended < global_only
    assert blended > 0.5


def test_balanced_accuracy_uses_meta_label_not_direction():
    rows = [
        Prediction("EURUSD", "BUY", pd.Timestamp("2026-01-01T00:00:00Z"), pd.Timestamp("2026-01-01T00:05:00Z"), 1.0, 0.8),
        Prediction("EURUSD", "SELL", pd.Timestamp("2026-01-01T00:05:00Z"), pd.Timestamp("2026-01-01T00:10:00Z"), 1.0, 0.4),
        Prediction("EURUSD", "BUY", pd.Timestamp("2026-01-01T00:10:00Z"), pd.Timestamp("2026-01-01T00:15:00Z"), -1.0, 0.3),
        Prediction("EURUSD", "SELL", pd.Timestamp("2026-01-01T00:15:00Z"), pd.Timestamp("2026-01-01T00:20:00Z"), -1.0, 0.7),
    ]
    assert _balanced_accuracy(rows, 0.5) == 0.5


def test_performance_preserves_pair_level_evidence():
    rows = []
    start = pd.Timestamp("2026-01-01T00:00:00Z")
    for index, (symbol, r) in enumerate([
        ("EURUSD", 1.5),
        ("EURUSD", -1.0),
        ("USDJPY", 1.5),
        ("USDJPY", 1.5),
    ]):
        scan = start + timedelta(minutes=5 * index)
        rows.append(
            Prediction(
                symbol,
                "BUY",
                scan,
                scan + timedelta(minutes=5),
                r,
                0.7,
            )
        )

    metrics = _performance(rows, 0.6)

    assert metrics["trades"] == 4
    assert metrics["profit_factor"] == 4.5
    assert metrics["by_instrument"]["EURUSD"]["net_r"] == 0.5
    assert metrics["by_instrument"]["USDJPY"]["net_r"] == 3.0


def test_threshold_selection_never_marks_negative_calibration_as_eligible():
    start = pd.Timestamp("2026-01-01T00:00:00Z")
    rows = []
    for index in range(80):
        scan = start + timedelta(minutes=index)
        rows.append(
            Prediction(
                "EURUSD",
                "BUY",
                scan,
                scan + timedelta(minutes=5),
                -1.0 if index % 3 else 1.5,
                0.65,
            )
        )

    _threshold, passed, candidates = choose_threshold(rows)

    assert passed is False
    assert not any(candidate["eligible"] for candidate in candidates)
