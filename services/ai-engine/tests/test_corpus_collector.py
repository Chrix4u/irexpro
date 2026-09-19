"""Tests for broker-authoritative historical training corpus collection."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.domain.market_data.schemas import OHLCVCandle
from app.domain.training.corpus_collector import (
    collect_broker_corpus,
    is_closed_candle,
    persist_corpus,
)


class FakeHistoricalProvider:
    def __init__(self, candles: list[OHLCVCandle]) -> None:
        self.candles = candles
        self.calls: list[datetime | None] = []

    async def get_historical_ohlcv(
        self,
        instrument: str,
        timeframe: str,
        limit: int = 500,
        user_id: str | None = None,
        broker_connection_id: str | None = None,
        before: datetime | None = None,
    ) -> list[OHLCVCandle]:
        self.calls.append(before)
        eligible = [
            candle
            for candle in self.candles
            if before is None or candle.timestamp <= before
        ]
        # Broker-like latest-first page; collector must normalize ordering.
        return list(reversed(eligible[-limit:]))


def _candles(count: int, start: datetime) -> list[OHLCVCandle]:
    return [
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


def test_closed_candle_requires_full_timeframe_elapsed():
    candle = _candles(1, datetime(2026, 9, 19, 12, 0, tzinfo=UTC))[0]
    assert (
        is_closed_candle(
            candle,
            timeframe="H1",
            as_of=datetime(2026, 9, 19, 12, 59, tzinfo=UTC),
        )
        is False
    )
    assert (
        is_closed_candle(
            candle,
            timeframe="H1",
            as_of=datetime(2026, 9, 19, 13, 0, tzinfo=UTC),
        )
        is True
    )


@pytest.mark.asyncio
async def test_collects_multiple_pages_deduplicated_and_time_ordered():
    start = datetime(2026, 1, 1, tzinfo=UTC)
    provider = FakeHistoricalProvider(_candles(360, start))
    as_of = start + timedelta(hours=400)

    result = await collect_broker_corpus(
        provider,
        user_id="user-1",
        broker_connection_id="conn-1",
        instrument="EURUSD",
        timeframe="H1",
        target_candles=300,
        page_size=100,
        as_of=as_of,
    )

    assert len(result) == 300
    assert result == sorted(result, key=lambda candle: candle.timestamp)
    assert len({candle.timestamp for candle in result}) == 300
    assert result[-1].timestamp == start + timedelta(hours=359)
    assert len(provider.calls) >= 3

    cursors = [cursor for cursor in provider.calls if cursor is not None]
    assert all(later < earlier for earlier, later in zip(cursors, cursors[1:]))


@pytest.mark.asyncio
async def test_excludes_incomplete_latest_candle():
    start = datetime(2026, 1, 1, tzinfo=UTC)
    candles = _candles(301, start)
    provider = FakeHistoricalProvider(candles)
    # Candle 300 opened exactly at as_of, so it is incomplete for H1.
    as_of = candles[-1].timestamp

    result = await collect_broker_corpus(
        provider,
        user_id="user-1",
        broker_connection_id="conn-1",
        instrument="EURUSD",
        timeframe="H1",
        target_candles=300,
        page_size=100,
        as_of=as_of,
    )

    assert len(result) == 300
    assert candles[-1].timestamp not in {candle.timestamp for candle in result}


@pytest.mark.asyncio
async def test_fails_closed_when_broker_history_is_too_short():
    start = datetime(2026, 1, 1, tzinfo=UTC)
    provider = FakeHistoricalProvider(_candles(260, start))

    with pytest.raises(Exception, match="did not provide enough closed historical candles"):
        await collect_broker_corpus(
            provider,
            user_id="user-1",
            broker_connection_id="conn-1",
            instrument="EURUSD",
            timeframe="H1",
            target_candles=300,
            page_size=100,
            as_of=start + timedelta(hours=400),
        )


def test_persists_corpus_with_integrity_metadata(tmp_path: Path):
    start = datetime(2026, 1, 1, tzinfo=UTC)
    candles = _candles(300, start)
    output = tmp_path / "EURUSD_H1.csv"

    result = persist_corpus(
        candles,
        output_path=output,
        instrument="EURUSD",
        timeframe="H1",
        collected_at=datetime(2026, 9, 19, tzinfo=UTC),
    )

    metadata = Path(str(result["metadata_path"]))
    assert output.is_file()
    assert metadata.is_file()
    assert result["candle_count"] == 300
    assert result["closed_candles_only"] is True
    assert result["timestamps_unique"] is True
    assert result["csv_sha256"]
