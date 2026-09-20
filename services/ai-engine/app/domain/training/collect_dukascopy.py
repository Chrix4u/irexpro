"""Collect real bid/ask tick history from Dukascopy's public datafeed.

This research-only source is independent from user broker connections. Hourly
.bi5 files are decoded and aggregated to canonical UTC M1 midpoint candles.
The historical spread is preserved from the last quote in each completed
minute, while tick count is retained as activity volume.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import lzma
import math
import struct
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import pandas as pd

from app.domain.training.dataset_builder import load_ohlcv_csv

DUKASCOPY_DATAFEED_BASE_URL = "https://datafeed.dukascopy.com/datafeed"
INITIAL_FOREX_PRICE_DIGITS = {
    "EURUSD": 5,
    "GBPUSD": 5,
    "USDJPY": 3,
    "AUDUSD": 5,
    "USDCAD": 5,
    "USDCHF": 5,
}
_RECORD = struct.Struct(">IIIff")
_NEW_YORK = ZoneInfo("America/New_York")


def _is_forex_market_closed_hour(hour: datetime) -> bool:
    """Return True for hours inside the standard FX weekend closure.

    The global spot-FX trading week is treated as Sunday 17:00 New York
    through Friday 17:00 New York. Using America/New_York keeps the UTC
    boundary correct across DST transitions.
    """
    if hour.tzinfo is None:
        hour = hour.replace(tzinfo=UTC)
    local = hour.astimezone(_NEW_YORK)
    weekday = local.weekday()

    if weekday == 5:  # Saturday
        return True
    if weekday == 6 and local.hour < 17:  # Sunday before weekly open
        return True
    if weekday == 4 and local.hour >= 17:  # Friday after weekly close
        return True
    return False


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _hour_url(instrument: str, hour: datetime) -> str:
    hour = hour.astimezone(UTC)
    return (
        f"{DUKASCOPY_DATAFEED_BASE_URL}/{instrument.upper()}/"
        f"{hour.year:04d}/{hour.month - 1:02d}/{hour.day:02d}/"
        f"{hour.hour:02d}h_ticks.bi5"
    )



def _raw_cache_path(
    cache_dir: Path,
    instrument: str,
    hour: datetime,
) -> Path:
    hour = hour.astimezone(UTC)
    return (
        cache_dir
        / instrument.upper()
        / f"{hour.year:04d}"
        / f"{hour.month - 1:02d}"
        / f"{hour.day:02d}"
        / f"{hour.hour:02d}h_ticks.bi5"
    )

def decode_dukascopy_ticks(
    payload: bytes,
    *,
    hour_start: datetime,
    price_digits: int,
) -> list[tuple[datetime, float, float, float, float, int]]:
    """Decode one Dukascopy hourly .bi5 payload.

    Returns tuples of:
      (timestamp_utc, ask, bid, ask_volume, bid_volume, spread_points)
    """
    if not payload:
        return []
    if hour_start.tzinfo is None:
        hour_start = hour_start.replace(tzinfo=UTC)
    else:
        hour_start = hour_start.astimezone(UTC)

    raw = lzma.decompress(payload)
    if len(raw) % _RECORD.size != 0:
        raise ValueError(
            f"Malformed Dukascopy payload: {len(raw)} bytes is not a multiple "
            f"of {_RECORD.size}"
        )

    price_scale = 10**price_digits
    ticks: list[tuple[datetime, float, float, float, float, int]] = []
    previous_ms = -1

    for offset in range(0, len(raw), _RECORD.size):
        ms, ask_raw, bid_raw, ask_volume, bid_volume = _RECORD.unpack_from(raw, offset)
        if ms >= 60 * 60 * 1000:
            raise ValueError(f"Tick millisecond offset outside hour: {ms}")
        if ms < previous_ms:
            raise ValueError("Dukascopy tick payload is not chronological")
        previous_ms = ms

        if ask_raw <= 0 or bid_raw <= 0 or ask_raw < bid_raw:
            raise ValueError("Dukascopy tick contains invalid bid/ask geometry")
        if not math.isfinite(ask_volume) or not math.isfinite(bid_volume):
            raise ValueError("Dukascopy tick contains non-finite quote volume")

        spread_points = int(ask_raw - bid_raw)
        ticks.append(
            (
                hour_start + timedelta(milliseconds=ms),
                ask_raw / price_scale,
                bid_raw / price_scale,
                max(float(ask_volume), 0.0),
                max(float(bid_volume), 0.0),
                spread_points,
            )
        )

    return ticks


def aggregate_ticks_to_m1(
    ticks: list[tuple[datetime, float, float, float, float, int]],
    *,
    price_digits: int,
) -> list[dict[str, Any]]:
    """Aggregate bid/ask ticks into completed UTC M1 midpoint bars."""
    if not ticks:
        return []

    buckets: dict[datetime, dict[str, Any]] = {}
    for timestamp, ask, bid, ask_volume, bid_volume, spread_points in ticks:
        minute = timestamp.replace(second=0, microsecond=0)
        mid = (ask + bid) / 2.0
        row = buckets.get(minute)

        if row is None:
            row = {
                "timestamp": minute,
                "open": mid,
                "high": mid,
                "low": mid,
                "close": mid,
                "volume": 0.0,
                "tick_volume": 0.0,
                "spread_points": float(spread_points),
                "price_digits": price_digits,
                "quote_volume": 0.0,
                "_last_tick": timestamp,
            }
            buckets[minute] = row

        row["high"] = max(float(row["high"]), mid)
        row["low"] = min(float(row["low"]), mid)
        row["close"] = mid
        row["volume"] = float(row["volume"]) + 1.0
        row["tick_volume"] = float(row["tick_volume"]) + 1.0
        row["quote_volume"] = float(row["quote_volume"]) + ask_volume + bid_volume

        if timestamp >= row["_last_tick"]:
            row["spread_points"] = float(spread_points)
            row["_last_tick"] = timestamp

    rows = []
    for minute in sorted(buckets):
        row = dict(buckets[minute])
        row.pop("_last_tick", None)
        row["timestamp"] = minute.isoformat()
        rows.append(row)
    return rows


def _fetch_hour(
    *,
    instrument: str,
    hour: datetime,
    price_digits: int,
    timeout_seconds: float,
    max_retries: int,
    cache_dir: Path | None = None,
) -> tuple[datetime, list[dict[str, Any]], int, bool]:
    url = _hour_url(instrument, hour)
    cache_path = (
        _raw_cache_path(cache_dir, instrument, hour)
        if cache_dir is not None
        else None
    )
    missing_marker = (
        cache_path.with_suffix(cache_path.suffix + ".missing")
        if cache_path is not None
        else None
    )

    if missing_marker is not None and missing_marker.is_file():
        return hour, [], 0, True

    if cache_path is not None and cache_path.is_file():
        payload = cache_path.read_bytes()
        try:
            ticks = decode_dukascopy_ticks(
                payload,
                hour_start=hour,
                price_digits=price_digits,
            )
            rows = aggregate_ticks_to_m1(ticks, price_digits=price_digits)
            return hour, rows, 0, False
        except (lzma.LZMAError, ValueError):
            cache_path.unlink(missing_ok=True)
    headers = {
        "User-Agent": "iRexPro-Research/1.0",
        "Accept": "*/*",
    }

    with httpx.Client(
        timeout=timeout_seconds,
        follow_redirects=True,
    ) as client:
        for attempt in range(max_retries + 1):
            try:
                response = client.get(url, headers=headers)
                if response.status_code == 404:
                    if missing_marker is not None:
                        missing_marker.parent.mkdir(parents=True, exist_ok=True)
                        missing_marker.touch(exist_ok=True)
                    return hour, [], 0, True

                transient = response.status_code == 429 or response.status_code >= 500
                if transient and attempt < max_retries:
                    delay = min(12.0, 1.0 * (2**attempt))
                    time.sleep(delay)
                    continue

                response.raise_for_status()
                ticks = decode_dukascopy_ticks(
                    response.content,
                    hour_start=hour,
                    price_digits=price_digits,
                )
                rows = aggregate_ticks_to_m1(ticks, price_digits=price_digits)
                if cache_path is not None:
                    cache_path.parent.mkdir(parents=True, exist_ok=True)
                    temporary = cache_path.with_suffix(cache_path.suffix + ".tmp")
                    temporary.write_bytes(response.content)
                    temporary.replace(cache_path)
                    if missing_marker is not None:
                        missing_marker.unlink(missing_ok=True)
                return hour, rows, len(response.content), False
            except httpx.HTTPStatusError as exc:
                retryable = (
                    exc.response.status_code == 429
                    or exc.response.status_code >= 500
                )
                if not retryable or attempt >= max_retries:
                    raise
                time.sleep(min(12.0, 1.0 * (2**attempt)))
            except (httpx.TransportError, lzma.LZMAError, ValueError):
                if attempt >= max_retries:
                    raise
                time.sleep(min(12.0, 1.0 * (2**attempt)))

    raise RuntimeError("Unreachable Dukascopy fetch state")


def collect_dukascopy_m1_corpus(
    *,
    instrument: str,
    target_rows: int,
    output_path: str | Path,
    now: datetime | None = None,
    max_lookback_days: int = 90,
    parallelism: int = 3,
    batch_hours: int = 24,
    timeout_seconds: float = 30.0,
    max_retries: int = 5,
    cache_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Collect latest real Dukascopy bid/ask ticks and aggregate to M1."""
    symbol = instrument.upper()
    if symbol not in INITIAL_FOREX_PRICE_DIGITS:
        raise ValueError(f"Unsupported initial-universe instrument: {symbol}")
    if target_rows < 250:
        raise ValueError("target_rows must be at least 250")
    if max_lookback_days < 2:
        raise ValueError("max_lookback_days must be at least 2")
    if not 1 <= parallelism <= 16:
        raise ValueError("parallelism must be between 1 and 16")
    if not 1 <= batch_hours <= 168:
        raise ValueError("batch_hours must be between 1 and 168")

    observed_now = now or datetime.now(UTC)
    if observed_now.tzinfo is None:
        observed_now = observed_now.replace(tzinfo=UTC)
    else:
        observed_now = observed_now.astimezone(UTC)

    # Use only fully completed hourly files.
    cursor = observed_now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
    earliest = cursor - timedelta(days=max_lookback_days)
    price_digits = INITIAL_FOREX_PRICE_DIGITS[symbol]
    cache_root = Path(cache_dir) if cache_dir is not None else None
    if cache_root is not None:
        cache_root.mkdir(parents=True, exist_ok=True)

    rows_by_timestamp: dict[str, dict[str, Any]] = {}
    hours_requested = 0
    hours_with_data = 0
    missing_hours = 0
    bytes_downloaded = 0
    recovered_hours = 0
    market_closed_hours = 0

    while len(rows_by_timestamp) < target_rows and cursor >= earliest:
        hours: list[datetime] = []
        for _ in range(batch_hours):
            if cursor < earliest:
                break
            candidate_hour = cursor
            cursor -= timedelta(hours=1)
            if _is_forex_market_closed_hour(candidate_hour):
                market_closed_hours += 1
                continue
            hours.append(candidate_hour)

        if not hours:
            # A whole batch can fall inside the weekly FX closure. Keep
            # walking backward until the lookback boundary rather than
            # treating a closed-market batch as end-of-history.
            continue

        failed_hours: list[tuple[datetime, Exception]] = []
        with ThreadPoolExecutor(max_workers=parallelism) as pool:
            futures = {
                pool.submit(
                    _fetch_hour,
                    instrument=symbol,
                    hour=hour,
                    price_digits=price_digits,
                    timeout_seconds=timeout_seconds,
                    max_retries=max_retries,
                    cache_dir=cache_root,
                ): hour
                for hour in hours
            }
            for future in as_completed(futures):
                requested_hour = futures[future]
                hours_requested += 1
                try:
                    _hour, rows, payload_bytes, missing = future.result()
                except Exception as exc:  # recovery is serial and fail-closed below
                    failed_hours.append((requested_hour, exc))
                    continue

                bytes_downloaded += payload_bytes
                if missing:
                    missing_hours += 1
                    continue
                if rows:
                    hours_with_data += 1
                for row in rows:
                    rows_by_timestamp[str(row["timestamp"])] = row

        # Public datafeed occasionally returns transient 5xx responses under
        # concurrency. Retry failed hours serially with a larger retry budget.
        # Never silently skip an unresolved hour: an artificial data gap would
        # contaminate returns, indicators, and spread-cost evaluation.
        for failed_hour, original_error in failed_hours:
            try:
                _hour, rows, payload_bytes, missing = _fetch_hour(
                    instrument=symbol,
                    hour=failed_hour,
                    price_digits=price_digits,
                    timeout_seconds=max(timeout_seconds, 30.0),
                    max_retries=max(max_retries + 2, 7),
                    cache_dir=cache_root,
                )
            except Exception as recovery_error:
                raise RuntimeError(
                    "Dukascopy hour remained unavailable after serial recovery: "
                    f"{symbol} {failed_hour.isoformat()}"
                ) from recovery_error

            recovered_hours += 1
            bytes_downloaded += payload_bytes
            if missing:
                missing_hours += 1
                continue
            if rows:
                hours_with_data += 1
            for row in rows:
                rows_by_timestamp[str(row["timestamp"])] = row

    if len(rows_by_timestamp) < target_rows:
        raise ValueError(
            f"Dukascopy yielded only {len(rows_by_timestamp)} M1 rows for {symbol}; "
            f"{target_rows} requested within {max_lookback_days} days"
        )

    ordered = sorted(
        rows_by_timestamp.values(),
        key=lambda row: pd.Timestamp(row["timestamp"]),
    )[-target_rows:]

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    frame = pd.DataFrame(ordered)
    frame.to_csv(output, index=False)

    # Reuse core OHLCV validation and assert friction completeness separately.
    validated = load_ohlcv_csv(output)
    friction_columns = ["spread_points", "price_digits", "tick_volume"]
    for column in friction_columns:
        if column not in frame.columns or frame[column].isna().any():
            raise ValueError(f"Dukascopy corpus missing required friction column: {column}")
    if (frame["spread_points"] < 0).any():
        raise ValueError("Dukascopy corpus contains negative spread points")
    if (frame["tick_volume"] <= 0).any():
        raise ValueError("Dukascopy corpus contains non-positive tick counts")

    manifest = {
        "manifest_version": 1,
        "instrument": symbol,
        "timeframe": "M1",
        "source": "dukascopy_public_datafeed_ticks",
        "source_base_url": DUKASCOPY_DATAFEED_BASE_URL,
        "price_basis": "midpoint_of_historical_best_bid_ask",
        "spread_basis": "last_historical_bid_ask_spread_per_closed_minute",
        "volume_semantics": "quote_tick_count",
        "price_digits": price_digits,
        "row_count": len(validated),
        "hours_requested": hours_requested,
        "hours_with_data": hours_with_data,
        "missing_hours": missing_hours,
        "recovered_hours": recovered_hours,
        "market_closed_hours_skipped": market_closed_hours,
        "bytes_downloaded": bytes_downloaded,
        "start": validated["timestamp"].iloc[0].isoformat(),
        "end": validated["timestamp"].iloc[-1].isoformat(),
        "collected_at": observed_now.isoformat(),
        "closed_candles_only": True,
        "friction_data_complete": True,
        "raw_cache_enabled": cache_root is not None,
        "dataset_sha256": _sha256_file(output),
    }
    manifest_path = output.with_suffix(".manifest.json")
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return {
        **manifest,
        "dataset_path": str(output),
        "manifest_path": str(manifest_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Collect real Dukascopy bid/ask tick history as causal M1 corpus"
    )
    parser.add_argument("--instrument", required=True)
    parser.add_argument("--target-rows", type=int, default=25000)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-lookback-days", type=int, default=90)
    parser.add_argument("--parallelism", type=int, default=3)
    parser.add_argument("--cache-dir")
    args = parser.parse_args()

    result = collect_dukascopy_m1_corpus(
        instrument=args.instrument,
        target_rows=args.target_rows,
        output_path=args.output,
        max_lookback_days=args.max_lookback_days,
        parallelism=args.parallelism,
        cache_dir=args.cache_dir,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
