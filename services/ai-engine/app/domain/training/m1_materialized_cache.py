"""Durable daily M1 materialized cache over the raw Dukascopy ``.bi5`` store.

The raw hourly ``.bi5`` files remain the source of truth. This module adds a
verified derived layer::

    raw .bi5  ->  verified daily M1 materialization (Parquet)  ->  pair MTF corpus

Each UTC trading day is materialized once into a self-describing Parquet chunk
plus a manifest. A resumed collection run verifies every chunk (schema version,
SHA-256, instrument, trading date, semantics fingerprint, and the frozen study
cutoff identity) and loads verified days directly, skipping the original
``.bi5`` decode and M1 aggregation for those days.

Chunk writes are atomic: a temporary Parquet file is fully written and hashed,
a temporary manifest is written, and only then are both atomically replaced
into place. An interrupted writer can therefore never leave a chunk that a
future run interprets as complete.
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from datetime import time as dt_time
from pathlib import Path
from typing import Any

import pandas as pd

# Source identity constants. These mirror collect_dukascopy's public feed
# constants but are deliberately local so this cache module never imports the
# collector (the collector imports this module). A drift between the two is
# caught by the semantics fingerprint tests.
DUKASCOPY_SOURCE_IDENTIFIER = "dukascopy_public_datafeed_ticks"
DUKASCOPY_SOURCE_BASE_URL = "https://datafeed.dukascopy.com/datafeed"

M1_CHUNK_MANIFEST_VERSION = 1
M1_CHUNK_SCHEMA_VERSION = 1
M1_CHUNK_BUILD_VERSION = "irexpro-m1-materializer/1"

M1_CHUNK_PARQUET_ENGINE = "pyarrow"

# Canonical column order and dtypes of a materialized daily M1 chunk. The
# order mirrors the row dicts produced by
# ``collect_dukascopy.aggregate_ticks_to_m1`` so a chunk-based corpus is
# byte-identical to one built straight from decoded raw hours.
M1_CHUNK_COLUMNS: tuple[tuple[str, str], ...] = (
    ("timestamp", "string"),
    ("open", "float64"),
    ("high", "float64"),
    ("low", "float64"),
    ("close", "float64"),
    ("volume", "float64"),
    ("tick_volume", "float64"),
    ("spread_points", "float64"),
    ("price_digits", "int64"),
    ("quote_volume", "float64"),
)

HOUR_STATUS_DATA = "data"
HOUR_STATUS_MISSING_404 = "missing_404"
HOUR_STATUS_MARKET_CLOSED = "market_closed"
HOUR_STATUS_OUT_OF_WINDOW = "out_of_window"


def m1_materialization_semantics_fingerprint() -> str:
    """Stable fingerprint over Dukascopy decode + M1 aggregation semantics.

    Any change to the semantics described here (record format, price basis,
    spread basis, volume semantics, aggregation boundaries, or the materialized
    column schema) must produce a different fingerprint so that previously
    materialized chunks invalidate instead of silently mixing representations.
    """
    payload = {
        "schema_version": M1_CHUNK_SCHEMA_VERSION,
        "source": DUKASCOPY_SOURCE_IDENTIFIER,
        "record_format": ">IIIff",
        "price_basis": "midpoint_of_historical_best_bid_ask",
        "spread_basis": "last_historical_bid_ask_spread_per_closed_minute",
        "volume_semantics": "quote_tick_count",
        "quote_volume_semantics": "sum_of_quote_volumes",
        "timezone": "UTC",
        "aggregation": (
            "per-hour-local minute buckets keyed by ISO-8601 UTC minute "
            "timestamp; merged across the day's hours by timestamp"
        ),
        "columns": [[name, dtype] for name, dtype in M1_CHUNK_COLUMNS],
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode("utf-8")
    ).hexdigest()


def effective_before_hour_token(effective_before: datetime) -> str:
    """Normalize a study cutoff to its UTC hour identity token.

    Two resumed runs of the same experiment share the same frozen
    ``effective_before`` and therefore the same token; a different experiment
    cutoff produces a different token and cannot reuse the other run's chunks.
    """
    if effective_before.tzinfo is None:
        effective_before = effective_before.replace(tzinfo=UTC)
    return effective_before.astimezone(UTC).replace(
        minute=0, second=0, microsecond=0
    ).isoformat()


def daily_chunk_paths(
    cache_dir: str | Path,
    instrument: str,
    trading_date: date,
) -> tuple[Path, Path]:
    """Return ``(parquet_path, manifest_path)`` for one instrument-day chunk."""
    root = Path(cache_dir) / instrument.upper() / "m1"
    return (
        root / f"{trading_date.isoformat()}.parquet",
        root / f"{trading_date.isoformat()}.manifest.json",
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _chunk_frame_from_rows(rows: list[dict[str, Any]]) -> pd.DataFrame:
    frame = pd.DataFrame(rows, columns=[name for name, _ in M1_CHUNK_COLUMNS])
    for name, dtype in M1_CHUNK_COLUMNS:
        if dtype == "string":
            frame[name] = frame[name].astype(str)
        else:
            frame[name] = frame[name].astype(dtype)
    return frame


def _validated_loaded_frame(
    frame: pd.DataFrame,
    *,
    expected_row_count: int,
    expected_first: str | None,
    expected_last: str | None,
) -> bool:
    if list(frame.columns) != [name for name, _ in M1_CHUNK_COLUMNS]:
        return False
    for name, dtype in M1_CHUNK_COLUMNS:
        observed = str(frame[name].dtype)
        if dtype == "string":
            if observed not in {"object", "str", "string"}:
                return False
        elif observed != dtype:
            return False
    if len(frame) != expected_row_count:
        return False
    if expected_row_count == 0:
        return True
    timestamps = frame["timestamp"].astype(str).tolist()
    if timestamps[0] != expected_first or timestamps[-1] != expected_last:
        return False
    return True


@dataclass(frozen=True)
class ChunkValidationResult:
    """Outcome of verifying one daily materialized chunk."""

    valid: bool
    rows: list[dict[str, Any]] | None = None
    manifest: dict[str, Any] | None = None
    invalidation_reason: str | None = None


def load_validated_daily_chunk(
    cache_dir: str | Path,
    instrument: str,
    trading_date: date,
    *,
    effective_before_hour: str,
) -> ChunkValidationResult:
    """Verify and load one daily M1 chunk, or explain why it is unusable.

    Verification order (fail-closed at every step):

    1. both chunk files exist and the manifest is valid JSON;
    2. manifest version and chunk schema version are current;
    3. manifest instrument and trading date match the request;
    4. the collector/data-semantics fingerprint matches the current build;
    5. the frozen study cutoff identity matches this run's cutoff;
    6. the SHA-256 of the materialized Parquet matches the manifest;
    7. the Parquet loads with the exact expected schema, row count, and
       first/last timestamps.
    """
    parquet_path, manifest_path = daily_chunk_paths(
        cache_dir, instrument, trading_date
    )
    if not parquet_path.is_file() or not manifest_path.is_file():
        return ChunkValidationResult(
            valid=False, invalidation_reason="chunk_files_absent"
        )

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ChunkValidationResult(
            valid=False, invalidation_reason="manifest_unreadable"
        )
    if not isinstance(manifest, dict):
        return ChunkValidationResult(
            valid=False, invalidation_reason="manifest_not_object"
        )

    if manifest.get("manifest_version") != M1_CHUNK_MANIFEST_VERSION:
        return ChunkValidationResult(
            valid=False, invalidation_reason="manifest_version_mismatch"
        )
    if manifest.get("chunk_schema_version") != M1_CHUNK_SCHEMA_VERSION:
        return ChunkValidationResult(
            valid=False, invalidation_reason="schema_version_mismatch"
        )
    if manifest.get("instrument") != instrument.upper():
        return ChunkValidationResult(
            valid=False, invalidation_reason="instrument_mismatch"
        )
    if manifest.get("trading_date") != trading_date.isoformat():
        return ChunkValidationResult(
            valid=False, invalidation_reason="trading_date_mismatch"
        )
    if manifest.get("semantics_fingerprint") != (
        m1_materialization_semantics_fingerprint()
    ):
        return ChunkValidationResult(
            valid=False, invalidation_reason="semantics_fingerprint_mismatch"
        )
    if manifest.get("effective_before_hour") != effective_before_hour:
        return ChunkValidationResult(
            valid=False, invalidation_reason="study_cutoff_mismatch"
        )

    try:
        chunk_sha256 = _sha256_file(parquet_path)
    except OSError:
        return ChunkValidationResult(
            valid=False, invalidation_reason="chunk_unreadable"
        )
    if chunk_sha256 != manifest.get("chunk_sha256"):
        return ChunkValidationResult(
            valid=False, invalidation_reason="chunk_sha256_mismatch"
        )

    try:
        frame = pd.read_parquet(parquet_path, engine=M1_CHUNK_PARQUET_ENGINE)
    except Exception:
        return ChunkValidationResult(
            valid=False, invalidation_reason="chunk_parquet_malformed"
        )

    expected_row_count = manifest.get("row_count")
    if not isinstance(expected_row_count, int) or expected_row_count < 0:
        return ChunkValidationResult(
            valid=False, invalidation_reason="manifest_row_count_invalid"
        )
    if not _validated_loaded_frame(
        frame,
        expected_row_count=expected_row_count,
        expected_first=manifest.get("first_timestamp"),
        expected_last=manifest.get("last_timestamp"),
    ):
        return ChunkValidationResult(
            valid=False, invalidation_reason="chunk_schema_drift"
        )

    rows = frame.to_dict("records")
    return ChunkValidationResult(valid=True, rows=rows, manifest=manifest)


def materialize_daily_chunk(
    cache_dir: str | Path,
    instrument: str,
    trading_date: date,
    rows: list[dict[str, Any]],
    raw_hour_inputs: list[dict[str, Any]],
    *,
    effective_before_hour: str,
    price_digits: int,
    window_hours: int,
    market_closed_hours: int,
) -> dict[str, Any]:
    """Atomically materialize one verified daily M1 chunk.

    ``raw_hour_inputs`` records, for every hour of the day that was considered,
    the status (``data`` with the raw SHA-256, ``missing_404``,
    ``market_closed``, or ``out_of_window``) so a rebuilt day remains
    auditable against the raw source of truth.
    """
    parquet_path, manifest_path = daily_chunk_paths(
        cache_dir, instrument, trading_date
    )
    parquet_path.parent.mkdir(parents=True, exist_ok=True)

    frame = _chunk_frame_from_rows(rows)
    if frame["timestamp"].duplicated().any():
        raise ValueError("materialized M1 chunk contains duplicate timestamps")
    timestamps = frame["timestamp"].astype(str).tolist()

    temporary_parquet = parquet_path.with_suffix(parquet_path.suffix + ".tmp")
    frame.to_parquet(
        temporary_parquet,
        engine=M1_CHUNK_PARQUET_ENGINE,
        index=False,
    )
    chunk_sha256 = _sha256_file(temporary_parquet)

    missing_hours = sum(
        1
        for entry in raw_hour_inputs
        if entry.get("status") == HOUR_STATUS_MISSING_404
    )
    manifest = {
        "manifest_version": M1_CHUNK_MANIFEST_VERSION,
        "chunk_schema_version": M1_CHUNK_SCHEMA_VERSION,
        "build_version": M1_CHUNK_BUILD_VERSION,
        "instrument": instrument.upper(),
        "trading_date": trading_date.isoformat(),
        "timeframe": "M1",
        "source": DUKASCOPY_SOURCE_IDENTIFIER,
        "source_base_url": DUKASCOPY_SOURCE_BASE_URL,
        "price_basis": "midpoint_of_historical_best_bid_ask",
        "spread_basis": "last_historical_bid_ask_spread_per_closed_minute",
        "volume_semantics": "quote_tick_count",
        "price_digits": price_digits,
        "row_count": len(frame),
        "first_timestamp": timestamps[0] if timestamps else None,
        "last_timestamp": timestamps[-1] if timestamps else None,
        "window_hours": window_hours,
        "market_closed_hours": market_closed_hours,
        "missing_hours": missing_hours,
        "raw_hour_inputs": raw_hour_inputs,
        "chunk_sha256": chunk_sha256,
        "semantics_fingerprint": m1_materialization_semantics_fingerprint(),
        "effective_before_hour": effective_before_hour,
        "created_at": datetime.now(UTC).isoformat(),
    }

    temporary_manifest = manifest_path.with_suffix(
        manifest_path.suffix + ".tmp"
    )
    temporary_manifest.write_text(
        json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8"
    )
    # Atomic replacement of both files. A crash before the first replace
    # leaves only ignored ``.tmp`` files; a crash between the two replaces
    # leaves a manifest whose SHA-256 no longer matches the Parquet, which
    # validation rejects and rebuilds. Neither state can be mistaken for a
    # complete chunk.
    os.replace(temporary_parquet, parquet_path)
    os.replace(temporary_manifest, manifest_path)
    return manifest


def day_hours_in_window(
    trading_date: date,
    *,
    earliest: datetime,
    latest_inclusive: datetime,
) -> list[datetime]:
    """UTC hours of ``trading_date`` inside ``[earliest, latest_inclusive]``.

    Returned newest-first to match the collector's backward walk order.
    """
    day_start = datetime.combine(trading_date, dt_time(0, 0), tzinfo=UTC)
    hours: list[datetime] = []
    for offset in range(23, -1, -1):
        hour = day_start + timedelta(hours=offset)
        if earliest <= hour <= latest_inclusive:
            hours.append(hour)
    return hours


def utc_date_of(hour: datetime) -> date:
    if hour.tzinfo is None:
        hour = hour.replace(tzinfo=UTC)
    return hour.astimezone(UTC).date()
