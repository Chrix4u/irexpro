"""Tests for the canonical multi-timeframe runtime feature contract."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.domain.market_data.schemas import OHLCVCandle
from app.domain.models.multitimeframe_features import (
    MULTITIMEFRAME_FEATURE_COLUMNS,
    RUNTIME_TIMEFRAMES,
    TIMEFRAME_MINUTES,
    build_multitimeframe_runtime_features,
)


def _candles(
    timeframe: str,
    *,
    end_open: datetime,
    count: int = 30,
    base: float = 1.10,
) -> list[OHLCVCandle]:
    step = timedelta(minutes=TIMEFRAME_MINUTES[timeframe])
    result: list[OHLCVCandle] = []
    first = end_open - step * (count - 1)
    for index in range(count):
        ts = first + step * index
        close = base + index * 0.00001
        result.append(
            OHLCVCandle(
                timestamp=ts,
                open=close - 0.00002,
                high=close + 0.00005,
                low=close - 0.00005,
                close=close,
                volume=100 + index,
                tick_volume=100 + index,
                spread_points=2.0,
                price_digits=5,
                instrument="EURUSD",
                timeframe=timeframe,
                source="broker",
            )
        )
    return result


def _bundle_input() -> dict[str, list[OHLCVCandle]]:
    return {
        "M1": _candles(
            "M1",
            end_open=datetime(2026, 9, 18, 12, 33, tzinfo=UTC),
        ),
        "M5": _candles(
            "M5",
            end_open=datetime(2026, 9, 18, 12, 25, tzinfo=UTC),
        ),
        "M15": _candles(
            "M15",
            end_open=datetime(2026, 9, 18, 12, 15, tzinfo=UTC),
        ),
        "H1": _candles(
            "H1",
            end_open=datetime(2026, 9, 18, 11, 0, tzinfo=UTC),
        ),
        "H4": _candles(
            "H4",
            end_open=datetime(2026, 9, 18, 8, 0, tzinfo=UTC),
        ),
    }


def test_runtime_mtf_features_match_canonical_schema_and_anchor_to_m1_close():
    bundle = build_multitimeframe_runtime_features(
        _bundle_input(),
        instrument="EURUSD",
        now=datetime(2026, 9, 18, 12, 34, 30, tzinfo=UTC),
    )

    assert list(bundle.features) == MULTITIMEFRAME_FEATURE_COLUMNS
    assert bundle.decision_time == datetime(2026, 9, 18, 12, 34, tzinfo=UTC)
    assert bundle.latest_m1.timestamp == datetime(
        2026, 9, 18, 12, 33, tzinfo=UTC
    )
    assert bundle.features["instrument_EURUSD"] == 1.0
    assert bundle.features["instrument_GBPUSD"] == 0.0
    assert bundle.features["m1_spread_bps"] > 0


def test_runtime_mtf_features_ignore_forming_higher_timeframe_bar():
    source = _bundle_input()
    baseline = build_multitimeframe_runtime_features(
        source,
        instrument="EURUSD",
        now=datetime(2026, 9, 18, 12, 34, 30, tzinfo=UTC),
    )

    source["H1"].append(
        OHLCVCandle(
            timestamp=datetime(2026, 9, 18, 12, 0, tzinfo=UTC),
            open=9.0,
            high=10.0,
            low=8.0,
            close=9.5,
            volume=999999,
            tick_volume=999999,
            spread_points=99,
            price_digits=5,
            instrument="EURUSD",
            timeframe="H1",
            source="broker",
        )
    )
    with_forming = build_multitimeframe_runtime_features(
        source,
        instrument="EURUSD",
        now=datetime(2026, 9, 18, 12, 34, 30, tzinfo=UTC),
    )

    assert with_forming.latest_by_timeframe["H1"].timestamp == datetime(
        2026, 9, 18, 11, 0, tzinfo=UTC
    )
    for column in MULTITIMEFRAME_FEATURE_COLUMNS:
        assert with_forming.features[column] == pytest.approx(
            baseline.features[column]
        )


def test_runtime_mtf_features_fail_closed_without_real_spread_metadata():
    source = _bundle_input()
    source["M1"][-1] = source["M1"][-1].model_copy(
        update={"spread_points": None}
    )

    with pytest.raises(ValueError, match="spread_points/price_digits"):
        build_multitimeframe_runtime_features(
            source,
            instrument="EURUSD",
            now=datetime(2026, 9, 18, 12, 34, 30, tzinfo=UTC),
        )


def test_runtime_mtf_requires_all_five_timeframes():
    source = _bundle_input()
    source.pop("H4")

    with pytest.raises(ValueError, match="Missing runtime timeframes"):
        build_multitimeframe_runtime_features(
            source,
            instrument="EURUSD",
            now=datetime(2026, 9, 18, 12, 34, 30, tzinfo=UTC),
        )

    assert RUNTIME_TIMEFRAMES == ("M1", "M5", "M15", "H1", "H4")
