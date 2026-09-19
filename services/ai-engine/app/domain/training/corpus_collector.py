"""Broker-authoritative historical OHLCV corpus collection for model training."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Protocol

import pandas as pd

from app.core.errors import MarketDataError
from app.domain.market_data.providers.broker_provider import BrokerMarketDataProvider
from app.domain.market_data.schemas import OHLCVCandle

TIMEFRAME_DURATIONS: dict[str, timedelta] = {
    "M1": timedelta(minutes=1),
    "M5": timedelta(minutes=5),
    "M15": timedelta(minutes=15),
    "M30": timedelta(minutes=30),
    "H1": timedelta(hours=1),
    "H4": timedelta(hours=4),
    "D1": timedelta(days=1),
}


class HistoricalBrokerProvider(Protocol):
    async def get_historical_ohlcv(
        self,
        instrument: str,
        timeframe: str,
        limit: int = 500,
        user_id: str | None = None,
        broker_connection_id: str | None = None,
        before: datetime | None = None,
    ) -> list[OHLCVCandle]: ...


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _timeframe_duration(timeframe: str) -> timedelta:
    normalized = timeframe.upper()
    if normalized not in TIMEFRAME_DURATIONS:
        raise ValueError(f"Unsupported corpus timeframe: {timeframe}")
    return TIMEFRAME_DURATIONS[normalized]


def is_closed_candle(
    candle: OHLCVCandle,
    *,
    timeframe: str,
    as_of: datetime,
) -> bool:
    """Return True only when the entire candle interval has elapsed."""
    candle_open = _as_utc(candle.timestamp)
    return candle_open + _timeframe_duration(timeframe) <= _as_utc(as_of)


async def collect_broker_corpus(
    provider: HistoricalBrokerProvider,
    *,
    user_id: str,
    broker_connection_id: str,
    instrument: str,
    timeframe: str,
    target_candles: int = 20_000,
    page_size: int = 500,
    before: datetime | None = None,
    as_of: datetime | None = None,
) -> list[OHLCVCandle]:
    """
    Page backward through broker-authoritative historical candles.

    The collector excludes incomplete candles, deduplicates timestamps and
    requires the requested target count. It never substitutes mock/synthetic
    data when the broker cannot provide enough history.
    """
    if target_candles < 250:
        raise ValueError("target_candles must be at least 250")
    if page_size < 10 or page_size > 500:
        raise ValueError("page_size must be between 10 and 500")

    normalized_instrument = instrument.upper()
    normalized_timeframe = timeframe.upper()
    _timeframe_duration(normalized_timeframe)

    collection_time = _as_utc(as_of or datetime.now(UTC))
    cursor = _as_utc(before or collection_time)
    by_timestamp: dict[datetime, OHLCVCandle] = {}

    # Allow a few extra pages for provider-boundary duplicates and a current
    # incomplete candle without allowing an unbounded request loop.
    max_pages = math.ceil(target_candles / page_size) + 8

    for _ in range(max_pages):
        if len(by_timestamp) >= target_candles:
            break

        page = await provider.get_historical_ohlcv(
            instrument=normalized_instrument,
            timeframe=normalized_timeframe,
            limit=page_size,
            user_id=user_id,
            broker_connection_id=broker_connection_id,
            before=cursor,
        )
        if not page:
            break

        page_timestamps: list[datetime] = []
        for candle in page:
            timestamp = _as_utc(candle.timestamp)
            page_timestamps.append(timestamp)

            if candle.instrument.upper() != normalized_instrument:
                raise MarketDataError("Broker corpus returned a mismatched instrument")
            if candle.timeframe.upper() != normalized_timeframe:
                raise MarketDataError("Broker corpus returned a mismatched timeframe")
            if not is_closed_candle(
                candle,
                timeframe=normalized_timeframe,
                as_of=collection_time,
            ):
                continue

            by_timestamp[timestamp] = candle.model_copy(update={"timestamp": timestamp})

        if not page_timestamps:
            break

        earliest = min(page_timestamps)
        next_cursor = earliest - timedelta(microseconds=1)
        if next_cursor >= cursor:
            raise MarketDataError("Historical market-data cursor did not move backward")
        cursor = next_cursor

    candles = sorted(by_timestamp.values(), key=lambda candle: candle.timestamp)
    if len(candles) < target_candles:
        raise MarketDataError(
            "Broker did not provide enough closed historical candles: "
            f"{len(candles)} collected, {target_candles} required"
        )

    # Return the most recent requested closed history, preserving ascending time.
    return candles[-target_candles:]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def persist_corpus(
    candles: list[OHLCVCandle],
    *,
    output_path: str | Path,
    instrument: str,
    timeframe: str,
    collected_at: datetime | None = None,
) -> dict[str, object]:
    """Persist a deterministic training CSV plus provenance metadata sidecar."""
    if not candles:
        raise ValueError("Cannot persist an empty historical corpus")

    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    ordered = sorted(candles, key=lambda candle: _as_utc(candle.timestamp))
    timestamps = [_as_utc(candle.timestamp) for candle in ordered]
    if len(timestamps) != len(set(timestamps)):
        raise ValueError("Historical corpus contains duplicate timestamps")

    frame = pd.DataFrame(
        [
            {
                "timestamp": _as_utc(candle.timestamp).isoformat(),
                "open": candle.open,
                "high": candle.high,
                "low": candle.low,
                "close": candle.close,
                "volume": candle.volume,
            }
            for candle in ordered
        ]
    )
    frame.to_csv(path, index=False, lineterminator="\n")

    metadata_path = path.with_suffix(".metadata.json")
    metadata: dict[str, object] = {
        "metadata_version": 1,
        "source": "broker_authoritative_historical_ohlcv",
        "instrument": instrument.upper(),
        "timeframe": timeframe.upper(),
        "candle_count": len(ordered),
        "first_candle_at": timestamps[0].isoformat(),
        "last_candle_at": timestamps[-1].isoformat(),
        "collected_at": _as_utc(collected_at or datetime.now(UTC)).isoformat(),
        "closed_candles_only": True,
        "timestamps_unique": True,
        "timestamps_monotonic": True,
        "csv_sha256": _sha256_file(path),
    }
    metadata_path.write_text(
        json.dumps(metadata, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    return {
        "dataset_path": str(path),
        "metadata_path": str(metadata_path),
        **metadata,
    }


async def _collect_from_cli(args: argparse.Namespace) -> dict[str, object]:
    provider = BrokerMarketDataProvider()
    candles = await collect_broker_corpus(
        provider,
        user_id=args.user_id,
        broker_connection_id=args.broker_connection_id,
        instrument=args.instrument,
        timeframe=args.timeframe,
        target_candles=args.target_candles,
        page_size=args.page_size,
    )
    return persist_corpus(
        candles,
        output_path=args.output,
        instrument=args.instrument,
        timeframe=args.timeframe,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Collect a broker-authoritative historical OHLCV training corpus"
    )
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--broker-connection-id", required=True)
    parser.add_argument("--instrument", required=True)
    parser.add_argument("--timeframe", default="H1")
    parser.add_argument("--target-candles", type=int, default=20_000)
    parser.add_argument("--page-size", type=int, default=500)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    result = asyncio.run(_collect_from_cli(args))
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
