"""Tests for broker-authoritative historical corpus collection."""
from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta

import pytest

from app.domain.market_data.schemas import OHLCVCandle
from app.domain.training.collect_broker_history import (
    collect_instrument_history,
    write_corpus,
)


class HistoricalProviderStub:
    def __init__(self, candles: list[OHLCVCandle]) -> None:
        self._candles = candles
        self.calls: list[datetime] = []

    async def get_historical_ohlcv(
        self,
        instrument: str,
        timeframe: str,
        *,
        end_time: datetime,
        limit: int,
        user_id: str,
        broker_connection_id: str,
    ) -> list[OHLCVCandle]:
        del instrument, timeframe, user_id, broker_connection_id
        self.calls.append(end_time)
        eligible = [candle for candle in self._candles if candle.timestamp <= end_time]
        page = eligible[-limit:]
        if page:
            # Repeat the oldest item once to prove overlap/deduplication safety.
            return [page[0], *page]
        return []


def _candles(now: datetime, count: int = 700) -> list[OHLCVCandle]:
    start = now - timedelta(hours=count)
    rows = [
        OHLCVCandle(
            timestamp=start + timedelta(hours=index),
            open=1.10 + index * 0.00001,
            high=1.101 + index * 0.00001,
            low=1.099 + index * 0.00001,
            close=1.1005 + index * 0.00001,
            volume=1000 + index,
            instrument="EURUSD",
            timeframe="H1",
            source="broker",
        )
        for index in range(count)
    ]
    rows.append(
        OHLCVCandle(
            timestamp=now - timedelta(minutes=30),
            open=1.2,
            high=1.201,
            low=1.199,
            close=1.2005,
            volume=2000,
            instrument="EURUSD",
            timeframe="H1",
            source="broker",
        )
    )
    return rows


@pytest.mark.asyncio
async def test_collects_closed_deduplicated_pages_backwards():
    now = datetime(2026, 1, 10, 12, 0, tzinfo=UTC)
    provider = HistoricalProviderStub(_candles(now))

    candles = await collect_instrument_history(
        provider,
        user_id="user-1",
        broker_connection_id="connection-1",
        instrument="EURUSD",
        timeframe="H1",
        target_rows=600,
        page_size=250,
        request_delay_seconds=0,
        now=now,
    )

    assert len(candles) == 600
    assert len({candle.timestamp for candle in candles}) == 600
    assert candles == sorted(candles, key=lambda candle: candle.timestamp)
    assert all(candle.timestamp + timedelta(hours=1) <= now for candle in candles)
    assert len(provider.calls) >= 3
    assert provider.calls == sorted(provider.calls, reverse=True)


def test_writes_dataset_and_matching_integrity_manifest(tmp_path):
    now = datetime(2026, 1, 10, 12, 0, tzinfo=UTC)
    rows = _candles(now, count=300)[:250]

    report = write_corpus(
        rows,
        output_dir=tmp_path,
        instrument="EURUSD",
        timeframe="H1",
        broker_connection_id="connection-1",
    )

    dataset_path = tmp_path / "EURUSD_H1.csv"
    manifest_path = tmp_path / "EURUSD_H1.manifest.json"

    assert dataset_path.is_file()
    assert manifest_path.is_file()
    assert report["row_count"] == 250
    assert report["closed_candles_only"] is True

    digest = hashlib.sha256(dataset_path.read_bytes()).hexdigest()
    assert report["dataset_sha256"] == digest
