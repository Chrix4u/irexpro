"""Tests for the durable daily M1 materialized cache layer."""
from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from app.domain.training import m1_materialized_cache as cache
from app.domain.training.m1_materialized_cache import (
    M1_CHUNK_MANIFEST_VERSION,
    M1_CHUNK_SCHEMA_VERSION,
    daily_chunk_paths,
    day_hours_in_window,
    effective_before_hour_token,
    load_validated_daily_chunk,
    m1_materialization_semantics_fingerprint,
    materialize_daily_chunk,
    utc_date_of,
)

CUTOFF = datetime(2026, 9, 22, 14, 30, tzinfo=UTC)


def _row(minute: datetime, *, price_digits: int = 5) -> dict:
    close = 1.10000 + minute.minute * 0.00001
    return {
        "timestamp": minute.isoformat(),
        "open": close,
        "high": close + 0.00001,
        "low": close - 0.00001,
        "close": close,
        "volume": 12.0,
        "tick_volume": 12.0,
        "spread_points": 2.0,
        "price_digits": price_digits,
        "quote_volume": 30.0,
    }


def _day_rows(day: date, *, hours: int = 3) -> list[dict]:
    rows = []
    for hour in range(hours):
        for minute in range(60):
            rows.append(
                _row(datetime(day.year, day.month, day.day, hour, minute, tzinfo=UTC))
            )
    return rows


def _hour_inputs(day: date, *, hours: int = 3, missing: set[int] | None = None) -> list:
    missing = missing or set()
    inputs = []
    for hour in range(24):
        hour_start = datetime(day.year, day.month, day.day, hour, tzinfo=UTC)
        if hour < hours:
            if hour in missing:
                inputs.append(
                    {"hour": hour_start.isoformat(), "status": "missing_404"}
                )
            else:
                inputs.append(
                    {
                        "hour": hour_start.isoformat(),
                        "status": "data",
                        "raw_sha256": "0" * 64,
                        "raw_bytes": 4096,
                        "row_count": 60,
                    }
                )
        else:
            inputs.append(
                {"hour": hour_start.isoformat(), "status": "out_of_window"}
            )
    return inputs


def _materialize(
    tmp_path: Path,
    day: date,
    *,
    rows: list[dict] | None = None,
    hour_inputs: list | None = None,
    cutoff: datetime = CUTOFF,
) -> dict:
    return materialize_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        day,
        rows if rows is not None else _day_rows(day),
        hour_inputs if hour_inputs is not None else _hour_inputs(day),
        effective_before_hour=effective_before_hour_token(cutoff),
        price_digits=5,
        window_hours=3,
        market_closed_hours=0,
    )


def test_materialize_then_load_round_trips_rows_and_manifest(tmp_path: Path):
    day = date(2026, 9, 21)
    rows = _day_rows(day)
    manifest = _materialize(tmp_path, day)

    assert manifest["manifest_version"] == M1_CHUNK_MANIFEST_VERSION
    assert manifest["chunk_schema_version"] == M1_CHUNK_SCHEMA_VERSION
    assert manifest["instrument"] == "EURUSD"
    assert manifest["trading_date"] == day.isoformat()
    assert manifest["row_count"] == len(rows)
    assert manifest["first_timestamp"] == rows[0]["timestamp"]
    assert manifest["last_timestamp"] == rows[-1]["timestamp"]
    assert manifest["price_digits"] == 5
    assert manifest["semantics_fingerprint"] == m1_materialization_semantics_fingerprint()
    assert manifest["effective_before_hour"] == effective_before_hour_token(CUTOFF)
    assert manifest["missing_hours"] == 0
    assert len(manifest["raw_hour_inputs"]) == 24

    parquet_path, manifest_path = daily_chunk_paths(
        tmp_path / "cache", "EURUSD", day
    )
    assert parquet_path.is_file() and manifest_path.is_file()
    # Atomic writes leave no temporary artifacts behind.
    assert not list((tmp_path / "cache" / "EURUSD" / "m1").glob("*.tmp"))

    result = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        day,
        effective_before_hour=effective_before_hour_token(CUTOFF),
    )
    assert result.valid
    assert result.rows == rows
    assert result.manifest["chunk_sha256"] == manifest["chunk_sha256"]


def test_missing_chunk_files_report_absent(tmp_path: Path):
    result = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        date(2026, 9, 21),
        effective_before_hour=effective_before_hour_token(CUTOFF),
    )
    assert not result.valid
    assert result.invalidation_reason == "chunk_files_absent"


def test_interrupted_tmp_chunk_is_ignored(tmp_path: Path):
    day = date(2026, 9, 21)
    parquet_path, manifest_path = daily_chunk_paths(
        tmp_path / "cache", "EURUSD", day
    )
    parquet_path.parent.mkdir(parents=True, exist_ok=True)
    # Simulate an interrupted writer: only ignored temporary files exist.
    parquet_path.with_suffix(parquet_path.suffix + ".tmp").write_bytes(b"partial")
    manifest_path.with_suffix(manifest_path.suffix + ".tmp").write_text(
        "{ partial", encoding="utf-8"
    )

    result = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        day,
        effective_before_hour=effective_before_hour_token(CUTOFF),
    )
    assert not result.valid
    assert result.invalidation_reason == "chunk_files_absent"


def test_sha_mismatch_invalidates_chunk(tmp_path: Path):
    day = date(2026, 9, 21)
    _materialize(tmp_path, day)
    parquet_path, _ = daily_chunk_paths(tmp_path / "cache", "EURUSD", day)
    parquet_path.write_bytes(b"tampered payload")

    result = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        day,
        effective_before_hour=effective_before_hour_token(CUTOFF),
    )
    assert not result.valid
    assert result.invalidation_reason == "chunk_sha256_mismatch"


def test_malformed_parquet_invalidates_chunk(tmp_path: Path):
    day = date(2026, 9, 21)
    _materialize(tmp_path, day)
    parquet_path, manifest_path = daily_chunk_paths(
        tmp_path / "cache", "EURUSD", day
    )
    # Corrupt the parquet bytes but keep the manifest hash consistent with a
    # hash of the corrupted payload so the failure is a genuine parse error.
    parquet_path.write_bytes(b"not a parquet file at all")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    import hashlib

    manifest["chunk_sha256"] = hashlib.sha256(b"not a parquet file at all").hexdigest()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        day,
        effective_before_hour=effective_before_hour_token(CUTOFF),
    )
    assert not result.valid
    assert result.invalidation_reason == "chunk_parquet_malformed"


def test_schema_version_change_invalidates_chunk(tmp_path: Path):
    day = date(2026, 9, 21)
    _materialize(tmp_path, day)
    _, manifest_path = daily_chunk_paths(tmp_path / "cache", "EURUSD", day)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["chunk_schema_version"] = M1_CHUNK_SCHEMA_VERSION + 1
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        day,
        effective_before_hour=effective_before_hour_token(CUTOFF),
    )
    assert not result.valid
    assert result.invalidation_reason == "schema_version_mismatch"


def test_semantics_fingerprint_change_invalidates_chunk(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    day = date(2026, 9, 21)
    _materialize(tmp_path, day)

    monkeypatch.setattr(
        cache,
        "m1_materialization_semantics_fingerprint",
        lambda: "d" * 64,
    )

    result = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        day,
        effective_before_hour=effective_before_hour_token(CUTOFF),
    )
    assert not result.valid
    assert result.invalidation_reason == "semantics_fingerprint_mismatch"


def test_different_study_cutoff_cannot_reuse_chunk(tmp_path: Path):
    day = date(2026, 9, 21)
    _materialize(tmp_path, day)

    later_cutoff = CUTOFF + timedelta(hours=6)
    result = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        day,
        effective_before_hour=effective_before_hour_token(later_cutoff),
    )
    assert not result.valid
    assert result.invalidation_reason == "study_cutoff_mismatch"


def test_exact_same_cutoff_reuses_chunk(tmp_path: Path):
    day = date(2026, 9, 21)
    _materialize(tmp_path, day)

    resumed_cutoff = CUTOFF + timedelta(minutes=17)
    result = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        day,
        effective_before_hour=effective_before_hour_token(resumed_cutoff),
    )
    assert result.valid
    assert result.rows is not None and len(result.rows) == 180


def test_instrument_and_date_mismatch_invalidate_chunk(tmp_path: Path):
    day = date(2026, 9, 21)
    _materialize(tmp_path, day)

    wrong_instrument = load_validated_daily_chunk(
        tmp_path / "cache",
        "GBPUSD",
        day,
        effective_before_hour=effective_before_hour_token(CUTOFF),
    )
    assert not wrong_instrument.valid
    assert wrong_instrument.invalidation_reason == "chunk_files_absent"

    wrong_date = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        date(2026, 9, 20),
        effective_before_hour=effective_before_hour_token(CUTOFF),
    )
    assert not wrong_date.valid
    assert wrong_date.invalidation_reason == "chunk_files_absent"

    _materialize(tmp_path, date(2026, 9, 20))
    tampered = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        date(2026, 9, 20),
        effective_before_hour=effective_before_hour_token(CUTOFF),
    )
    assert tampered.valid
    _, manifest_path = daily_chunk_paths(
        tmp_path / "cache", "EURUSD", date(2026, 9, 20)
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["trading_date"] = "2026-09-19"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    mismatched = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        date(2026, 9, 20),
        effective_before_hour=effective_before_hour_token(CUTOFF),
    )
    assert not mismatched.valid
    assert mismatched.invalidation_reason == "trading_date_mismatch"


def test_empty_day_chunk_round_trips(tmp_path: Path):
    day = date(2026, 9, 20)  # A Sunday: legitimately zero M1 rows.
    manifest = _materialize(
        tmp_path,
        day,
        rows=[],
        hour_inputs=_hour_inputs(day, hours=0),
    )
    assert manifest["row_count"] == 0
    assert manifest["first_timestamp"] is None
    assert manifest["last_timestamp"] is None

    result = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        day,
        effective_before_hour=effective_before_hour_token(CUTOFF),
    )
    assert result.valid
    assert result.rows == []


def test_missing_hour_status_is_recorded_in_manifest(tmp_path: Path):
    day = date(2026, 9, 21)
    manifest = _materialize(
        tmp_path, day, hour_inputs=_hour_inputs(day, missing={1})
    )
    assert manifest["missing_hours"] == 1
    statuses = [entry["status"] for entry in manifest["raw_hour_inputs"]]
    assert statuses.count("missing_404") == 1
    assert statuses.count("data") == 2
    assert statuses.count("out_of_window") == 21


def test_duplicate_timestamp_rows_are_rejected(tmp_path: Path):
    day = date(2026, 9, 21)
    rows = _day_rows(day)
    with pytest.raises(ValueError, match="duplicate timestamps"):
        materialize_daily_chunk(
            tmp_path / "cache",
            "EURUSD",
            day,
            rows + [dict(rows[0])],
            _hour_inputs(day),
            effective_before_hour=effective_before_hour_token(CUTOFF),
            price_digits=5,
            window_hours=3,
            market_closed_hours=0,
        )
    # The rejected write must not leave a complete chunk behind.
    parquet_path, manifest_path = daily_chunk_paths(
        tmp_path / "cache", "EURUSD", day
    )
    assert not parquet_path.is_file()
    assert not manifest_path.is_file()


def test_cutoff_hour_token_normalizes_to_utc_hour():
    assert (
        effective_before_hour_token(datetime(2026, 9, 22, 14, 39, 1, tzinfo=UTC))
        == "2026-09-22T14:00:00+00:00"
    )
    # Two resumes of the same frozen cutoff share the token even if the
    # wall-clock moment differs by minutes inside the same hour.
    assert effective_before_hour_token(CUTOFF) == effective_before_hour_token(
        CUTOFF + timedelta(minutes=29)
    )
    assert effective_before_hour_token(CUTOFF) != effective_before_hour_token(
        CUTOFF + timedelta(minutes=31)
    )


def test_day_hours_in_window_returns_newest_first_partial_days():
    earliest = datetime(2026, 9, 19, 17, tzinfo=UTC)
    latest = datetime(2026, 9, 21, 11, tzinfo=UTC)

    newest = day_hours_in_window(date(2026, 9, 21), earliest=earliest, latest_inclusive=latest)
    assert newest[0] == datetime(2026, 9, 21, 11, tzinfo=UTC)
    assert newest[-1] == datetime(2026, 9, 21, 0, tzinfo=UTC)
    assert len(newest) == 12

    oldest = day_hours_in_window(date(2026, 9, 19), earliest=earliest, latest_inclusive=latest)
    assert oldest[0] == datetime(2026, 9, 19, 23, tzinfo=UTC)
    assert oldest[-1] == datetime(2026, 9, 19, 17, tzinfo=UTC)
    assert len(oldest) == 7

    middle = day_hours_in_window(date(2026, 9, 20), earliest=earliest, latest_inclusive=latest)
    assert len(middle) == 24


def test_utc_date_of_handles_naive_and_aware_hours():
    assert utc_date_of(datetime(2026, 9, 21, 23, tzinfo=UTC)) == date(2026, 9, 21)
    assert utc_date_of(datetime(2026, 9, 22, 0, 30)) == date(2026, 9, 22)


def test_manifest_row_count_drift_invalidates_chunk(tmp_path: Path):
    day = date(2026, 9, 21)
    _materialize(tmp_path, day)
    _, manifest_path = daily_chunk_paths(tmp_path / "cache", "EURUSD", day)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["row_count"] = 999
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = load_validated_daily_chunk(
        tmp_path / "cache",
        "EURUSD",
        day,
        effective_before_hour=effective_before_hour_token(CUTOFF),
    )
    assert not result.valid
    assert result.invalidation_reason == "chunk_schema_drift"
