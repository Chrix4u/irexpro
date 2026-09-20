"""Tests for the native Dukascopy bid/ask research collector."""
from __future__ import annotations

import lzma
import struct
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pandas as pd
import pytest

from app.domain.training.collect_dukascopy import (
    _fetch_hour,
    _hour_url,
    _is_forex_market_closed_hour,
    _raw_cache_path,
    aggregate_ticks_to_m1,
    collect_dukascopy_m1_corpus,
    decode_dukascopy_ticks,
)

_RECORD = struct.Struct(">IIIff")


def _bi5_payload(
    records: list[tuple[int, int, int, float, float]],
) -> bytes:
    raw = b"".join(_RECORD.pack(*record) for record in records)
    return lzma.compress(raw, format=lzma.FORMAT_ALONE)


def test_hour_url_uses_dukascopy_zero_based_month():
    hour = datetime(2026, 9, 20, 14, tzinfo=UTC)

    assert _hour_url("eurusd", hour).endswith(
        "/EURUSD/2026/08/20/14h_ticks.bi5"
    )


def test_decode_dukascopy_ticks_preserves_bid_ask_spread_and_volume():
    hour = datetime(2026, 1, 2, 10, tzinfo=UTC)
    payload = _bi5_payload(
        [
            (1_000, 110_005, 110_003, 1.25, 2.50),
            (61_500, 110_010, 110_006, 3.00, 4.00),
        ]
    )

    ticks = decode_dukascopy_ticks(
        payload,
        hour_start=hour,
        price_digits=5,
    )

    assert len(ticks) == 2
    first = ticks[0]
    assert first[0] == hour + timedelta(seconds=1)
    assert first[1] == pytest.approx(1.10005)
    assert first[2] == pytest.approx(1.10003)
    assert first[3] == pytest.approx(1.25)
    assert first[4] == pytest.approx(2.50)
    assert first[5] == 2

    second = ticks[1]
    assert second[0] == hour + timedelta(seconds=61.5)
    assert second[5] == 4


def test_decode_rejects_future_or_nonchronological_tick_offsets():
    hour = datetime(2026, 1, 2, 10, tzinfo=UTC)

    with pytest.raises(ValueError, match="outside hour"):
        decode_dukascopy_ticks(
            _bi5_payload([(3_600_000, 110_005, 110_003, 1.0, 1.0)]),
            hour_start=hour,
            price_digits=5,
        )

    with pytest.raises(ValueError, match="not chronological"):
        decode_dukascopy_ticks(
            _bi5_payload(
                [
                    (2_000, 110_005, 110_003, 1.0, 1.0),
                    (1_000, 110_006, 110_004, 1.0, 1.0),
                ]
            ),
            hour_start=hour,
            price_digits=5,
        )


def test_aggregate_ticks_builds_midpoint_ohlc_and_last_quote_spread():
    hour = datetime(2026, 1, 2, 10, tzinfo=UTC)
    ticks = [
        (hour + timedelta(seconds=1), 1.10005, 1.10003, 1.0, 2.0, 2),
        (hour + timedelta(seconds=20), 1.10009, 1.10005, 3.0, 4.0, 4),
        (hour + timedelta(minutes=1, seconds=1), 1.10008, 1.10006, 5.0, 6.0, 2),
    ]

    rows = aggregate_ticks_to_m1(ticks, price_digits=5)

    assert len(rows) == 2
    first = rows[0]
    assert first["open"] == pytest.approx(1.10004)
    assert first["high"] == pytest.approx(1.10007)
    assert first["low"] == pytest.approx(1.10004)
    assert first["close"] == pytest.approx(1.10007)
    assert first["spread_points"] == 4.0
    assert first["tick_volume"] == 2.0
    assert first["volume"] == 2.0
    assert first["quote_volume"] == pytest.approx(10.0)
    assert first["price_digits"] == 5


def test_collection_writes_valid_real_friction_manifest(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    def fake_fetch_hour(
        *,
        instrument: str,
        hour: datetime,
        price_digits: int,
        timeout_seconds: float,
        max_retries: int,
        cache_dir=None,
    ):
        del timeout_seconds, max_retries, cache_dir
        base = 1.10 if instrument != "USDJPY" else 140.0
        rows = []
        for minute in range(60):
            timestamp = hour + timedelta(minutes=minute)
            close = base + minute * (0.000001 if price_digits == 5 else 0.001)
            rows.append(
                {
                    "timestamp": timestamp.isoformat(),
                    "open": close,
                    "high": close + (0.00001 if price_digits == 5 else 0.001),
                    "low": close - (0.00001 if price_digits == 5 else 0.001),
                    "close": close,
                    "volume": 20.0,
                    "tick_volume": 20.0,
                    "spread_points": 2.0,
                    "price_digits": price_digits,
                    "quote_volume": 50.0,
                }
            )
        return hour, rows, 4096, False

    monkeypatch.setattr(
        "app.domain.training.collect_dukascopy._fetch_hour",
        fake_fetch_hour,
    )

    output = tmp_path / "EURUSD_M1.csv"
    result = collect_dukascopy_m1_corpus(
        instrument="EURUSD",
        target_rows=250,
        output_path=output,
        now=datetime(2026, 1, 5, 12, tzinfo=UTC),
        max_lookback_days=3,
        parallelism=2,
        batch_hours=6,
    )

    frame = pd.read_csv(output)
    assert len(frame) == 250
    assert frame["spread_points"].eq(2.0).all()
    assert frame["price_digits"].eq(5).all()
    assert frame["tick_volume"].gt(0).all()

    assert result["source"] == "dukascopy_public_datafeed_ticks"
    assert result["friction_data_complete"] is True
    assert result["row_count"] == 250
    assert result["dataset_sha256"]
    assert Path(result["manifest_path"]).is_file()



def test_collection_recovers_transient_hour_without_silent_gap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    attempts: dict[datetime, int] = {}

    def flaky_fetch_hour(
        *,
        instrument: str,
        hour: datetime,
        price_digits: int,
        timeout_seconds: float,
        max_retries: int,
        cache_dir=None,
    ):
        del instrument, timeout_seconds, max_retries
        attempts[hour] = attempts.get(hour, 0) + 1

        # Fail one hour during the parallel pass. The collector must retry it
        # serially and include its rows instead of silently leaving a gap.
        if hour.hour == 10 and attempts[hour] == 1:
            raise RuntimeError("synthetic transient 503")

        rows = []
        for minute in range(60):
            timestamp = hour + timedelta(minutes=minute)
            close = 1.10 + minute * 0.000001
            rows.append(
                {
                    "timestamp": timestamp.isoformat(),
                    "open": close,
                    "high": close + 0.00001,
                    "low": close - 0.00001,
                    "close": close,
                    "volume": 10.0,
                    "tick_volume": 10.0,
                    "spread_points": 2.0,
                    "price_digits": price_digits,
                    "quote_volume": 25.0,
                }
            )
        return hour, rows, 2048, False

    monkeypatch.setattr(
        "app.domain.training.collect_dukascopy._fetch_hour",
        flaky_fetch_hour,
    )

    output = tmp_path / "EURUSD_M1.csv"
    result = collect_dukascopy_m1_corpus(
        instrument="EURUSD",
        target_rows=250,
        output_path=output,
        now=datetime(2026, 1, 5, 12, tzinfo=UTC),
        max_lookback_days=3,
        parallelism=2,
        batch_hours=6,
    )

    assert result["recovered_hours"] == 1
    assert attempts[datetime(2026, 1, 5, 10, tzinfo=UTC)] == 2
    assert len(pd.read_csv(output)) == 250



def test_fetch_hour_reuses_verified_raw_cache_without_network(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    hour = datetime(2026, 1, 5, 10, tzinfo=UTC)
    cache_root = tmp_path / "cache"
    cache_path = _raw_cache_path(cache_root, "EURUSD", hour)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_bytes(
        _bi5_payload(
            [
                (1_000, 110_005, 110_003, 1.25, 2.50),
                (20_000, 110_009, 110_005, 1.50, 2.00),
            ]
        )
    )

    def forbid_network(*_args, **_kwargs):
        raise AssertionError("network must not be used for a verified cache hit")

    monkeypatch.setattr("app.domain.training.collect_dukascopy.httpx.Client", forbid_network)

    returned_hour, rows, network_bytes, missing = _fetch_hour(
        instrument="EURUSD",
        hour=hour,
        price_digits=5,
        timeout_seconds=1.0,
        max_retries=0,
        cache_dir=cache_root,
    )

    assert returned_hour == hour
    assert missing is False
    assert network_bytes == 0
    assert len(rows) == 1
    assert rows[0]["tick_volume"] == 2.0
    assert rows[0]["spread_points"] == 4.0


def test_forex_weekend_calendar_tracks_new_york_dst_boundaries():
    # Summer (EDT): weekly close/open is 21:00 UTC.
    assert _is_forex_market_closed_hour(
        datetime(2026, 9, 18, 21, tzinfo=UTC)
    ) is True
    assert _is_forex_market_closed_hour(
        datetime(2026, 9, 20, 20, tzinfo=UTC)
    ) is True
    assert _is_forex_market_closed_hour(
        datetime(2026, 9, 20, 21, tzinfo=UTC)
    ) is False

    # Winter (EST): weekly close/open is 22:00 UTC.
    assert _is_forex_market_closed_hour(
        datetime(2026, 1, 2, 22, tzinfo=UTC)
    ) is True
    assert _is_forex_market_closed_hour(
        datetime(2026, 1, 4, 21, tzinfo=UTC)
    ) is True
    assert _is_forex_market_closed_hour(
        datetime(2026, 1, 4, 22, tzinfo=UTC)
    ) is False


def test_collection_skips_closed_weekend_hours_without_network(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    requested: list[datetime] = []

    def fake_fetch_hour(
        *,
        instrument: str,
        hour: datetime,
        price_digits: int,
        timeout_seconds: float,
        max_retries: int,
        cache_dir=None,
    ):
        del instrument, timeout_seconds, max_retries, cache_dir
        assert _is_forex_market_closed_hour(hour) is False
        requested.append(hour)
        rows = []
        for minute in range(60):
            timestamp = hour + timedelta(minutes=minute)
            close = 1.10 + minute * 0.000001
            rows.append(
                {
                    "timestamp": timestamp.isoformat(),
                    "open": close,
                    "high": close + 0.00001,
                    "low": close - 0.00001,
                    "close": close,
                    "volume": 10.0,
                    "tick_volume": 10.0,
                    "spread_points": 2.0,
                    "price_digits": price_digits,
                    "quote_volume": 25.0,
                }
            )
        return hour, rows, 2048, False

    monkeypatch.setattr(
        "app.domain.training.collect_dukascopy._fetch_hour",
        fake_fetch_hour,
    )

    output = tmp_path / "EURUSD_M1.csv"
    result = collect_dukascopy_m1_corpus(
        instrument="EURUSD",
        target_rows=250,
        output_path=output,
        now=datetime(2026, 1, 4, 18, tzinfo=UTC),
        max_lookback_days=3,
        parallelism=2,
        batch_hours=24,
    )

    assert len(requested) >= 5
    assert result["market_closed_hours_skipped"] > 0
    assert len(pd.read_csv(output)) == 250
