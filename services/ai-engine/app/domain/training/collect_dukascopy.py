"""Collect real bid/ask tick history from Dukascopy's public datafeed.

This research-only source is independent from user broker connections. Hourly
.bi5 files are decoded and aggregated to canonical UTC M1 midpoint candles.
The historical spread is preserved from the last quote in each completed
minute, while tick count is retained as activity volume.

Resilience layers (in order):

1. Raw hourly ``.bi5`` cache (source of truth, atomically written).
2. Verified daily M1 materialized chunks (Parquet + manifest) that let an
   interrupted and resumed pair collection skip the raw decode/aggregation
   of already-completed days.
3. Deterministic adaptive provider backpressure that steps worker
   parallelism down under transient provider pressure and back up after
   sustained healthy batches.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import lzma
import math
import struct
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime, timedelta
from datetime import time as dt_time
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import pandas as pd

from app.domain.training.adaptive_throttle import (
    AdaptiveFetchThrottle,
    AdaptiveThrottlePolicy,
)
from app.domain.training.dataset_builder import load_ohlcv_csv
from app.domain.training.m1_materialized_cache import (
    HOUR_STATUS_DATA,
    HOUR_STATUS_MARKET_CLOSED,
    HOUR_STATUS_MISSING_404,
    HOUR_STATUS_OUT_OF_WINDOW,
    day_hours_in_window,
    effective_before_hour_token,
    load_validated_daily_chunk,
    materialize_daily_chunk,
    utc_date_of,
)

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

ProgressLogger = Callable[[str], None]


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
    telemetry: dict[str, Any] | None = None,
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

    if telemetry is not None:
        telemetry.update(
            {
                "from_raw_cache": False,
                "network_download": False,
                "downloaded_bytes": 0,
                "retry_events": 0,
                "raw_cache_corruption_refetch": False,
            }
        )

    def _record_retry() -> None:
        if telemetry is not None:
            telemetry["retry_events"] = telemetry.get("retry_events", 0) + 1

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
            if telemetry is not None:
                telemetry["from_raw_cache"] = True
            return hour, rows, 0, False
        except (lzma.LZMAError, ValueError):
            cache_path.unlink(missing_ok=True)
            if telemetry is not None:
                telemetry["raw_cache_corruption_refetch"] = True
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
                    _record_retry()
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
                if telemetry is not None:
                    telemetry["network_download"] = True
                    telemetry["downloaded_bytes"] = len(response.content)
                return hour, rows, len(response.content), False
            except httpx.HTTPStatusError as exc:
                retryable = (
                    exc.response.status_code == 429
                    or exc.response.status_code >= 500
                )
                if not retryable or attempt >= max_retries:
                    raise
                _record_retry()
                time.sleep(min(12.0, 1.0 * (2**attempt)))
            except (httpx.TransportError, lzma.LZMAError, ValueError):
                if attempt >= max_retries:
                    raise
                _record_retry()
                time.sleep(min(12.0, 1.0 * (2**attempt)))

    raise RuntimeError("Unreachable Dukascopy fetch state")


class _CollectionTelemetry:
    """Accumulated resilience/efficiency counters for one pair collection."""

    def __init__(self) -> None:
        self.raw_cache_hits = 0
        self.raw_downloads = 0
        self.raw_bytes_downloaded = 0
        self.raw_hours_redecoded = 0
        self.raw_cache_corruption_refetches = 0
        self.m1_chunk_hits = 0
        self.m1_chunks_built = 0
        self.m1_chunks_invalidated = 0
        self.m1_chunk_invalidation_reasons: dict[str, int] = {}
        self.decode_hours_avoided = 0
        self.provider_retry_count = 0

    def record_hour_telemetry(self, hour_telemetry: dict[str, Any] | None) -> None:
        if not hour_telemetry:
            return
        if hour_telemetry.get("from_raw_cache"):
            self.raw_cache_hits += 1
            self.raw_hours_redecoded += 1
        if hour_telemetry.get("network_download"):
            self.raw_downloads += 1
            self.raw_hours_redecoded += 1
            self.raw_bytes_downloaded += int(hour_telemetry.get("downloaded_bytes", 0))
        if hour_telemetry.get("raw_cache_corruption_refetch"):
            self.raw_cache_corruption_refetches += 1
        self.provider_retry_count += int(hour_telemetry.get("retry_events", 0))

    def as_manifest_fields(self) -> dict[str, Any]:
        return {
            "raw_cache_hits": self.raw_cache_hits,
            "raw_downloads": self.raw_downloads,
            "raw_bytes_downloaded": self.raw_bytes_downloaded,
            "raw_hours_redecoded": self.raw_hours_redecoded,
            "raw_cache_corruption_refetches": self.raw_cache_corruption_refetches,
            "m1_chunk_hits": self.m1_chunk_hits,
            "m1_chunks_built": self.m1_chunks_built,
            "m1_chunks_invalidated": self.m1_chunks_invalidated,
            "m1_chunk_invalidation_reasons": dict(self.m1_chunk_invalidation_reasons),
            "decode_hours_avoided": self.decode_hours_avoided,
            "provider_retry_count": self.provider_retry_count,
        }


def _hour_status_entry(
    hour: datetime,
    *,
    status: str,
    cache_root: Path | None,
    instrument: str,
    row_count: int | None = None,
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "hour": hour.astimezone(UTC).isoformat(),
        "status": status,
    }
    if status == HOUR_STATUS_DATA and cache_root is not None:
        raw_path = _raw_cache_path(cache_root, instrument, hour)
        if raw_path.is_file():
            entry["raw_sha256"] = _sha256_file(raw_path)
            entry["raw_bytes"] = raw_path.stat().st_size
    if row_count is not None:
        entry["row_count"] = row_count
    return entry


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
    use_m1_chunks: bool = True,
    throttle_policy: AdaptiveThrottlePolicy | None = None,
    progress: ProgressLogger | None = None,
) -> dict[str, Any]:
    """Collect latest real Dukascopy bid/ask ticks and aggregate to M1.

    The walk is day-granular: for each UTC trading day inside the lookback
    window (newest first) the collector first attempts to load a verified
    daily M1 materialized chunk; only days without a valid chunk fall back to
    the original raw ``.bi5`` fetch/decode path, after which the day is
    materialized atomically. The final M1 selection (last ``target_rows``
    minutes) is identical to the hour-batch walk for the same window.
    """
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
    latest_inclusive = cursor
    price_digits = INITIAL_FOREX_PRICE_DIGITS[symbol]
    cache_root = Path(cache_dir) if cache_dir is not None else None
    if cache_root is not None:
        cache_root.mkdir(parents=True, exist_ok=True)
    chunks_enabled = cache_root is not None and use_m1_chunks
    cutoff_token = effective_before_hour_token(observed_now)

    throttle = AdaptiveFetchThrottle(
        AdaptiveThrottlePolicy(
            initial_workers=parallelism,
            min_workers=1,
            reduce_after_pressure_events=(
                throttle_policy.reduce_after_pressure_events
                if throttle_policy is not None
                else 2
            ),
            recover_after_clean_batches=(
                throttle_policy.recover_after_clean_batches
                if throttle_policy is not None
                else 2
            ),
        ),
        on_change=(
            lambda old, new, reason: (
                progress(
                    f"stage=collect instrument={symbol} "
                    f"throttle={new} previous={old} reason={reason}"
                )
                if progress is not None
                else None
            )
        ),
    )

    rows_by_timestamp: dict[str, dict[str, Any]] = {}
    hours_requested = 0
    hours_with_data = 0
    missing_hours = 0
    bytes_downloaded = 0
    recovered_hours = 0
    serial_recovery_calls = 0
    market_closed_hours = 0
    telemetry = _CollectionTelemetry()

    def _log(message: str) -> None:
        if progress is not None:
            progress(f"stage=collect instrument={symbol} {message}")

    while len(rows_by_timestamp) < target_rows and cursor >= earliest:
        trading_date = utc_date_of(cursor)
        day_window = day_hours_in_window(
            trading_date,
            earliest=earliest,
            latest_inclusive=latest_inclusive,
        )
        day_start = datetime.combine(trading_date, dt_time(0, 0), tzinfo=UTC)
        cursor = day_start - timedelta(hours=1)

        day_open_hours: list[datetime] = []
        for hour in day_window:
            if _is_forex_market_closed_hour(hour):
                market_closed_hours += 1
                continue
            day_open_hours.append(hour)

        if not day_window:
            # A whole day can fall outside the window boundary (for example
            # inside the weekly FX closure). Keep walking backward rather than
            # treating a closed-market day as end-of-history.
            continue

        if chunks_enabled:
            validation = load_validated_daily_chunk(
                cache_root,
                symbol,
                trading_date,
                effective_before_hour=cutoff_token,
            )
            if validation.valid and validation.rows is not None:
                chunk_manifest = validation.manifest or {}
                for row in validation.rows:
                    rows_by_timestamp[str(row["timestamp"])] = row
                telemetry.m1_chunk_hits += 1
                market_closed_hours += int(chunk_manifest.get("market_closed_hours", 0))
                for entry in chunk_manifest.get("raw_hour_inputs", []):
                    status = entry.get("status")
                    if status not in {
                        HOUR_STATUS_DATA,
                        HOUR_STATUS_MISSING_404,
                    }:
                        continue
                    hours_requested += 1
                    if status == HOUR_STATUS_MISSING_404:
                        missing_hours += 1
                    else:
                        telemetry.decode_hours_avoided += 1
                        if int(entry.get("row_count", 0)) > 0:
                            hours_with_data += 1
                _log(
                    f"status=chunk_hit date={trading_date.isoformat()} "
                    f"rows={len(validation.rows)}"
                )
                continue
            if not validation.valid and validation.invalidation_reason not in {
                "chunk_files_absent",
            }:
                telemetry.m1_chunks_invalidated += 1
                reason = validation.invalidation_reason or "unknown"
                telemetry.m1_chunk_invalidation_reasons[reason] = (
                    telemetry.m1_chunk_invalidation_reasons.get(reason, 0) + 1
                )
                _log(
                    f"status=chunk_invalid date={trading_date.isoformat()} "
                    f"reason={reason}"
                )

        # Rebuild path: fetch/decode this day's open hours from the raw
        # layer, then materialize the day as one verified chunk.
        day_rows_by_timestamp: dict[str, dict[str, Any]] = {}
        day_pressure_events = 0
        failed_hours: list[tuple[datetime, Exception]] = []

        for group_start in range(0, len(day_open_hours), batch_hours):
            group = day_open_hours[group_start : group_start + batch_hours]
            if not group:
                continue
            hour_telemetries: dict[datetime, dict[str, Any]] = {
                hour: {} for hour in group
            }
            with ThreadPoolExecutor(max_workers=throttle.level) as pool:
                futures = {
                    pool.submit(
                        _fetch_hour,
                        instrument=symbol,
                        hour=hour,
                        price_digits=price_digits,
                        timeout_seconds=timeout_seconds,
                        max_retries=max_retries,
                        cache_dir=cache_root,
                        telemetry=hour_telemetries[hour],
                    ): hour
                    for hour in group
                }
                for future in as_completed(futures):
                    requested_hour = futures[future]
                    hours_requested += 1
                    try:
                        _hour, rows, payload_bytes, missing = future.result()
                    except Exception as exc:  # recovery is serial and fail-closed below
                        failed_hours.append((requested_hour, exc))
                        day_pressure_events += 1
                        continue

                    telemetry.record_hour_telemetry(
                        hour_telemetries.get(requested_hour)
                    )
                    bytes_downloaded += payload_bytes
                    if missing:
                        missing_hours += 1
                        continue
                    if rows:
                        hours_with_data += 1
                    for row in rows:
                        day_rows_by_timestamp[str(row["timestamp"])] = row

        # Public datafeed occasionally returns transient 5xx responses under
        # concurrency. Retry failed hours serially with a larger retry budget.
        # A single exhausted serial pass can still coincide with a short-lived
        # provider outage, so use a small number of bounded recovery rounds
        # separated by cooldowns. Never silently skip an unresolved hour: an
        # artificial data gap would contaminate indicators and return evidence.
        for failed_hour, original_error in failed_hours:
            last_error: Exception = original_error
            recovered = False
            for recovery_round in range(3):
                if recovery_round > 0:
                    time.sleep(15.0 * recovery_round)

                serial_recovery_calls += 1
                recovery_telemetry: dict[str, Any] = {}
                try:
                    _hour, rows, payload_bytes, missing = _fetch_hour(
                        instrument=symbol,
                        hour=failed_hour,
                        price_digits=price_digits,
                        timeout_seconds=max(timeout_seconds, 30.0),
                        max_retries=max(max_retries + 2 + recovery_round, 7),
                        cache_dir=cache_root,
                        telemetry=recovery_telemetry,
                    )
                except Exception as recovery_error:
                    last_error = recovery_error
                    day_pressure_events += 1
                    continue

                telemetry.record_hour_telemetry(recovery_telemetry)
                recovered = True
                break

            if not recovered:
                raise RuntimeError(
                    "Dukascopy hour remained unavailable after bounded serial recovery: "
                    f"{symbol} {failed_hour.isoformat()}"
                ) from last_error

            recovered_hours += 1
            bytes_downloaded += payload_bytes
            if missing:
                missing_hours += 1
                continue
            if rows:
                hours_with_data += 1
            for row in rows:
                day_rows_by_timestamp[str(row["timestamp"])] = row

        throttle.observe_batch(day_pressure_events)

        for row in day_rows_by_timestamp.values():
            rows_by_timestamp[str(row["timestamp"])] = row

        if chunks_enabled:
            open_hour_row_counts = {
                hour.astimezone(UTC): 0 for hour in day_open_hours
            }
            day_window_set = {hour.astimezone(UTC) for hour in day_window}
            for row in day_rows_by_timestamp.values():
                minute = datetime.fromisoformat(str(row["timestamp"]))
                hour = minute.replace(minute=0, second=0, microsecond=0)
                if hour in open_hour_row_counts:
                    open_hour_row_counts[hour] += 1

            closed_in_day = sum(
                1 for hour in day_window if _is_forex_market_closed_hour(hour)
            )
            raw_hour_inputs = []
            for hour in sorted(
                day_start + timedelta(hours=offset) for offset in range(24)
            ):
                normalized_hour = hour.astimezone(UTC)
                if normalized_hour not in day_window_set:
                    raw_hour_inputs.append(
                        _hour_status_entry(
                            hour,
                            status=HOUR_STATUS_OUT_OF_WINDOW,
                            cache_root=cache_root,
                            instrument=symbol,
                        )
                    )
                elif normalized_hour in open_hour_row_counts:
                    raw_hour_inputs.append(
                        _hour_status_entry(
                            hour,
                            status=(
                                HOUR_STATUS_MISSING_404
                                if _hour_has_missing_marker(cache_root, symbol, hour)
                                else HOUR_STATUS_DATA
                            ),
                            cache_root=cache_root,
                            instrument=symbol,
                            row_count=open_hour_row_counts[normalized_hour],
                        )
                    )
                else:
                    raw_hour_inputs.append(
                        _hour_status_entry(
                            hour,
                            status=HOUR_STATUS_MARKET_CLOSED,
                            cache_root=cache_root,
                            instrument=symbol,
                        )
                    )
            materialize_daily_chunk(
                cache_root,
                symbol,
                trading_date,
                sorted(
                    day_rows_by_timestamp.values(),
                    key=lambda row: str(row["timestamp"]),
                ),
                raw_hour_inputs,
                effective_before_hour=cutoff_token,
                price_digits=price_digits,
                window_hours=len(day_window),
                market_closed_hours=closed_in_day,
            )
            telemetry.m1_chunks_built += 1
            _log(
                f"status=chunk_built date={trading_date.isoformat()} "
                f"rows={len(day_rows_by_timestamp)}"
            )

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
    # Atomic replacement: an interrupted pair collection must never leave a
    # partial M1 corpus a future stage could mistake for complete.
    corpus_tmp = output.with_suffix(output.suffix + ".tmp")
    frame.to_csv(corpus_tmp, index=False)
    corpus_tmp.replace(output)

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
        "serial_recovery_calls": serial_recovery_calls,
        "market_closed_hours_skipped": market_closed_hours,
        "bytes_downloaded": bytes_downloaded,
        "m1_chunks_enabled": chunks_enabled,
        "study_cutoff_hour": cutoff_token,
        **telemetry.as_manifest_fields(),
        "provider_throttle_level": throttle.telemetry.final_level,
        "provider_throttle_reductions": throttle.telemetry.reductions,
        "provider_throttle_recoveries": throttle.telemetry.recoveries,
        "start": validated["timestamp"].iloc[0].isoformat(),
        "end": validated["timestamp"].iloc[-1].isoformat(),
        "collected_at": observed_now.isoformat(),
        "closed_candles_only": True,
        "friction_data_complete": True,
        "raw_cache_enabled": cache_root is not None,
        "dataset_sha256": _sha256_file(output),
    }
    manifest_path = output.with_suffix(".manifest.json")
    manifest_tmp = manifest_path.with_suffix(manifest_path.suffix + ".tmp")
    manifest_tmp.write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    manifest_tmp.replace(manifest_path)
    return {
        **manifest,
        "dataset_path": str(output),
        "manifest_path": str(manifest_path),
    }


def _hour_has_missing_marker(
    cache_root: Path | None,
    instrument: str,
    hour: datetime,
) -> bool:
    if cache_root is None:
        return False
    raw_path = _raw_cache_path(cache_root, instrument, hour)
    marker = raw_path.with_suffix(raw_path.suffix + ".missing")
    return marker.is_file()


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
    parser.add_argument(
        "--no-m1-chunks",
        action="store_true",
        help="Disable the derived daily M1 materialized chunk cache",
    )
    args = parser.parse_args()

    result = collect_dukascopy_m1_corpus(
        instrument=args.instrument,
        target_rows=args.target_rows,
        output_path=args.output,
        max_lookback_days=args.max_lookback_days,
        parallelism=args.parallelism,
        cache_dir=args.cache_dir,
        use_m1_chunks=not args.no_m1_chunks,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
