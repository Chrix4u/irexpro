"""Collect broker-authoritative historical OHLCV corpora for offline training."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Iterable

import pandas as pd

from app.domain.market_data.providers.broker_provider import BrokerMarketDataProvider
from app.domain.market_data.schemas import OHLCVCandle

DEFAULT_INSTRUMENTS = ("EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF")
TIMEFRAME_SECONDS = {
    "M1": 60,
    "M5": 5 * 60,
    "M15": 15 * 60,
    "M30": 30 * 60,
    "H1": 60 * 60,
    "H4": 4 * 60 * 60,
    "D1": 24 * 60 * 60,
}


def _closed_before(candle: OHLCVCandle, timeframe: str, now: datetime) -> bool:
    duration = TIMEFRAME_SECONDS.get(timeframe.upper())
    if duration is None:
        raise ValueError(f"Unsupported corpus timeframe: {timeframe}")
    timestamp = candle.timestamp
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)
    return timestamp + timedelta(seconds=duration) <= now


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


async def collect_instrument_history(
    provider: BrokerMarketDataProvider,
    *,
    user_id: str,
    broker_connection_id: str,
    instrument: str,
    timeframe: str,
    target_rows: int,
    page_size: int = 500,
    end_time: datetime | None = None,
    request_delay_seconds: float = 0.15,
    now: datetime | None = None,
) -> list[OHLCVCandle]:
    """Page backwards through broker history until target closed candles are collected."""
    if target_rows < 250:
        raise ValueError("target_rows must be at least 250")
    if page_size < 10 or page_size > 500:
        raise ValueError("page_size must be between 10 and 500")
    if request_delay_seconds < 0:
        raise ValueError("request_delay_seconds cannot be negative")

    timeframe = timeframe.upper()
    if timeframe not in TIMEFRAME_SECONDS:
        raise ValueError(f"Unsupported corpus timeframe: {timeframe}")

    observed_now = now or datetime.now(UTC)
    if observed_now.tzinfo is None:
        observed_now = observed_now.replace(tzinfo=UTC)
    cursor = end_time or observed_now
    if cursor.tzinfo is None:
        cursor = cursor.replace(tzinfo=UTC)

    by_timestamp: dict[datetime, OHLCVCandle] = {}
    max_pages = max(5, (target_rows // page_size) + 20)

    for _ in range(max_pages):
        page = await provider.get_historical_ohlcv(
            instrument,
            timeframe,
            end_time=cursor,
            limit=page_size,
            user_id=user_id,
            broker_connection_id=broker_connection_id,
        )
        if not page:
            break

        for candle in page:
            timestamp = candle.timestamp
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=UTC)
                candle = candle.model_copy(update={"timestamp": timestamp})
            if timestamp > cursor:
                continue
            if not _closed_before(candle, timeframe, observed_now):
                continue
            by_timestamp[timestamp] = candle

        page_timestamps = [
            candle.timestamp if candle.timestamp.tzinfo is not None
            else candle.timestamp.replace(tzinfo=UTC)
            for candle in page
        ]
        oldest = min(page_timestamps)
        next_cursor = oldest - timedelta(microseconds=1)
        if next_cursor >= cursor:
            break
        cursor = next_cursor

        if len(by_timestamp) >= target_rows:
            break
        if request_delay_seconds:
            await asyncio.sleep(request_delay_seconds)

    candles = [by_timestamp[key] for key in sorted(by_timestamp)]
    if len(candles) < target_rows:
        raise ValueError(
            f"Broker history returned only {len(candles)} closed candles for "
            f"{instrument} {timeframe}; requested {target_rows}"
        )
    return candles[-target_rows:]


def write_corpus(
    candles: Iterable[OHLCVCandle],
    *,
    output_dir: str | Path,
    instrument: str,
    timeframe: str,
    broker_connection_id: str,
) -> dict[str, object]:
    """Write a deterministic OHLCV CSV and integrity manifest."""
    rows = list(candles)
    if not rows:
        raise ValueError("Cannot write an empty corpus")

    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    instrument = instrument.upper()
    timeframe = timeframe.upper()

    dataset_path = output / f"{instrument}_{timeframe}.csv"
    manifest_path = output / f"{instrument}_{timeframe}.manifest.json"

    frame = pd.DataFrame(
        [
            {
                "timestamp": candle.timestamp.isoformat(),
                "open": candle.open,
                "high": candle.high,
                "low": candle.low,
                "close": candle.close,
                "volume": candle.volume,
            }
            for candle in rows
        ]
    )
    frame = frame.sort_values("timestamp").drop_duplicates("timestamp", keep="last")
    frame.to_csv(dataset_path, index=False)

    manifest: dict[str, object] = {
        "manifest_version": 1,
        "source": "broker_internal_historical_ohlcv",
        "instrument": instrument,
        "timeframe": timeframe,
        "broker_connection_id": broker_connection_id,
        "row_count": len(frame),
        "start_at": str(frame["timestamp"].iloc[0]),
        "end_at": str(frame["timestamp"].iloc[-1]),
        "collected_at": datetime.now(UTC).isoformat(),
        "dataset_sha256": _sha256_file(dataset_path),
        "closed_candles_only": True,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return {
        **manifest,
        "dataset_path": str(dataset_path),
        "manifest_path": str(manifest_path),
    }


async def collect_corpus(
    *,
    user_id: str,
    broker_connection_id: str,
    instruments: Iterable[str] = DEFAULT_INSTRUMENTS,
    timeframe: str = "H1",
    target_rows: int = 15000,
    output_dir: str | Path = "data/corpus",
    request_delay_seconds: float = 0.15,
) -> list[dict[str, object]]:
    provider = BrokerMarketDataProvider()
    reports: list[dict[str, object]] = []

    for instrument in instruments:
        symbol = instrument.strip().upper()
        if not symbol:
            continue
        candles = await collect_instrument_history(
            provider,
            user_id=user_id,
            broker_connection_id=broker_connection_id,
            instrument=symbol,
            timeframe=timeframe,
            target_rows=target_rows,
            request_delay_seconds=request_delay_seconds,
        )
        reports.append(
            write_corpus(
                candles,
                output_dir=output_dir,
                instrument=symbol,
                timeframe=timeframe,
                broker_connection_id=broker_connection_id,
            )
        )

    return reports


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Collect broker-authoritative historical OHLCV for XGBoost training"
    )
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--broker-connection-id", required=True)
    parser.add_argument(
        "--instruments",
        default=",".join(DEFAULT_INSTRUMENTS),
        help="Comma-separated broker symbols",
    )
    parser.add_argument("--timeframe", default="H1")
    parser.add_argument("--rows", type=int, default=15000)
    parser.add_argument("--output-dir", default="data/corpus")
    parser.add_argument("--request-delay-ms", type=int, default=150)
    args = parser.parse_args()

    reports = asyncio.run(
        collect_corpus(
            user_id=args.user_id,
            broker_connection_id=args.broker_connection_id,
            instruments=args.instruments.split(","),
            timeframe=args.timeframe,
            target_rows=args.rows,
            output_dir=args.output_dir,
            request_delay_seconds=args.request_delay_ms / 1000.0,
        )
    )
    print(json.dumps(reports, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
