from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.domain.training.import_histdata_ticks import (
    aggregate_histdata_ticks,
    parse_histdata_timestamp,
)


def test_histdata_fixed_est_timestamp_converts_to_utc() -> None:
    assert parse_histdata_timestamp("20260501 000000168") == datetime(
        2026, 5, 1, 5, 0, 0, 168000, tzinfo=UTC
    )


def test_histdata_ticks_aggregate_midpoint_spread_and_tick_volume() -> None:
    ticks = iter(
        [
            (
                datetime(2026, 5, 1, 5, 0, 0, 168000, tzinfo=UTC),
                157.184,
                157.192,
            ),
            (
                datetime(2026, 5, 1, 5, 0, 1, 0, tzinfo=UTC),
                157.185,
                157.193,
            ),
            (
                datetime(2026, 5, 1, 5, 1, 0, 0, tzinfo=UTC),
                157.190,
                157.196,
            ),
        ]
    )
    rows = list(aggregate_histdata_ticks(ticks, price_digits=3))
    assert len(rows) == 2
    first = rows[0]
    assert first["timestamp"] == "2026-05-01T05:00:00+00:00"
    assert first["tick_volume"] == 2.0
    assert first["volume"] == 2.0
    assert first["spread_points"] == 8.0
    assert first["open"] == pytest.approx((157.184 + 157.192) / 2.0)
    assert first["close"] == pytest.approx((157.185 + 157.193) / 2.0)


def test_histdata_tick_order_must_be_chronological() -> None:
    ticks = iter(
        [
            (datetime(2026, 5, 1, 5, 1, tzinfo=UTC), 157.1, 157.2),
            (datetime(2026, 5, 1, 5, 0, tzinfo=UTC), 157.1, 157.2),
        ]
    )
    with pytest.raises(ValueError, match="not chronological"):
        list(aggregate_histdata_ticks(ticks, price_digits=3))
