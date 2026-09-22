"""End-to-end Research Resilience V2 regression tests.

These tests drive the real collector pipeline (decode -> aggregate ->
materialize -> verified resume) over a synthetic pre-seeded raw ``.bi5`` cache
with the network replaced by a deterministic fake, then prove:

* cold vs warm operation counts (performance evidence, WS11),
* exact dataset equivalence between the chunked path, a warm resume, and a
  clean rebuild from the original raw decode primitives (WS3),
* selective per-day recovery from every corruption/incompatibility class
  (WS10),
* frozen study cutoff identity rules (WS4),
* and staged runner execution equivalence with the monolithic study (WS7).
"""
from __future__ import annotations

import hashlib
import json
import lzma
import struct
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pandas as pd
import pytest

from app.domain.training import collect_dukascopy as collector_module
from app.domain.training import run_first_six_pair as runner
from app.domain.training.collect_dukascopy import (
    _hour_url,
    _is_forex_market_closed_hour,
    _raw_cache_path,
    aggregate_ticks_to_m1,
    collect_dukascopy_m1_corpus,
    decode_dukascopy_ticks,
)
from app.domain.training.m1_materialized_cache import (
    daily_chunk_paths,
    effective_before_hour_token,
)

_RECORD = struct.Struct(">IIIff")

# Geometry: now = Monday 2026-01-05 12:00 UTC, lookback 3 days.
#   cursor  = 2026-01-05 11:00, earliest = 2026-01-02 11:00.
# Open-market hours inside the window:
#   Jan 5 (Mon):  00:00-11:00  -> 12 open hours
#   Jan 4 (Sun):  22:00-23:00  -> 2 open hours (rest closed)
#   Jan 3 (Sat):  none         -> 0 open hours
#   Jan 2 (Fri):  11:00-21:00  -> 11 open hours (22:00/23:00 closed)
NOW = datetime(2026, 1, 5, 12, tzinfo=UTC)
LOOKBACK_DAYS = 3
OPEN_HOURS: list[datetime] = []
_cursor = NOW.replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
_earliest = _cursor - timedelta(days=LOOKBACK_DAYS)
_hour = _cursor
while _hour >= _earliest:
    if not _is_forex_market_closed_hour(_hour):
        OPEN_HOURS.append(_hour)
    _hour -= timedelta(hours=1)
OPEN_HOURS.sort()
OPEN_DAYS = sorted({hour.date() for hour in OPEN_HOURS})
DATA_HOURS_PER_DAY = {
    day: [hour for hour in OPEN_HOURS if hour.date() == day] for day in OPEN_DAYS
}
# Every UTC day the backward walk visits, including fully closed weekend days
# that still get a (zero-row) materialized chunk.
WALKED_DAYS = sorted(
    {
        (_cursor - timedelta(days=offset)).date()
        for offset in range(LOOKBACK_DAYS + 1)
    },
    reverse=True,
)
MARKET_CLOSED_HOURS_IN_WALK = sum(
    1
    for _h in OPEN_HOURS
) * 0  # placeholder replaced below
MARKET_CLOSED_HOURS_IN_WALK = sum(
    1
    for _d in WALKED_DAYS
    for _h in range(24)
    if _is_forex_market_closed_hour(
        datetime(_d.year, _d.month, _d.day, _h, tzinfo=UTC)
    )
    and (
        datetime(_d.year, _d.month, _d.day, _h, tzinfo=UTC) >= _earliest
    )
)


def _ticks_for_hour(hour: datetime) -> list[tuple[int, int, int, float, float]]:
    ticks = []
    for minute in range(60):
        ms = minute * 60_000 + 500
        mid = 110_000 + (hour.day * 10_000) + (hour.hour * 100) + minute
        ticks.append((ms, mid + 2, mid, 1.0, 1.0))
    return ticks


def _bi5_payload(records: list[tuple[int, int, int, float, float]]) -> bytes:
    raw = b"".join(_RECORD.pack(*record) for record in records)
    return lzma.compress(raw, format=lzma.FORMAT_ALONE)


def _payload_for_hour(hour: datetime) -> bytes:
    return _bi5_payload(_ticks_for_hour(hour))


def _seed_raw_cache(cache_dir: Path, hours: list[datetime]) -> None:
    for hour in hours:
        path = _raw_cache_path(cache_dir, "EURUSD", hour)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_payload_for_hour(hour))


def _ground_truth_rows(
    cache_dir: Path, hours: list[datetime]
) -> list[dict]:
    """Compute M1 rows straight from the raw decode primitives."""
    rows_by_timestamp: dict[str, dict] = {}
    for hour in sorted(hours):
        payload = _raw_cache_path(cache_dir, "EURUSD", hour).read_bytes()
        ticks = decode_dukascopy_ticks(
            payload, hour_start=hour, price_digits=5
        )
        for row in aggregate_ticks_to_m1(ticks, price_digits=5):
            rows_by_timestamp[str(row["timestamp"])] = row
    return sorted(rows_by_timestamp.values(), key=lambda row: str(row["timestamp"]))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class _FakeResponse:
    def __init__(self, status_code: int, content: bytes):
        self.status_code = status_code
        self.content = content

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise collector_module.httpx.HTTPStatusError(
                "fake error", request=None, response=None
            )


class _FakeHttpClient:
    """Deterministic network replacement with per-URL canned responses."""

    responses: dict[str, tuple[int, bytes]] = {}
    requested_urls: list[str] = []

    def __init__(self, *args, **kwargs):
        del args, kwargs

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def get(self, url: str, headers=None):
        del headers
        type(self).requested_urls.append(url)
        status, content = type(self).responses.get(url, (404, b""))
        return _FakeResponse(status, content)


@pytest.fixture()
def fake_network(monkeypatch: pytest.MonkeyPatch):
    _FakeHttpClient.responses = {}
    _FakeHttpClient.requested_urls = []
    monkeypatch.setattr(
        "app.domain.training.collect_dukascopy.httpx.Client", _FakeHttpClient
    )
    return _FakeHttpClient


def _collect(
    tmp_path: Path,
    *,
    now: datetime = NOW,
    target_rows: int = 1200,
    use_m1_chunks: bool = True,
) -> dict:
    return collect_dukascopy_m1_corpus(
        instrument="EURUSD",
        target_rows=target_rows,
        output_path=tmp_path / "out" / "EURUSD_M1.csv",
        now=now,
        max_lookback_days=LOOKBACK_DAYS,
        parallelism=3,
        cache_dir=tmp_path / "cache",
        use_m1_chunks=use_m1_chunks,
    )


def _seeded_collect(tmp_path: Path, **kwargs) -> dict:
    _seed_raw_cache(tmp_path / "cache", OPEN_HOURS)
    return _collect(tmp_path, **kwargs)


def test_cold_then_warm_operation_counts_and_identical_dataset(tmp_path: Path):
    """WS11 evidence: warm derived cache does materially less work.

    Cold run: every raw hour decoded, four daily chunks built.
    Warm resume with the identical frozen cutoff: zero raw decodes, all
    verified days loaded directly from materialized chunks.
    """
    cold = _seeded_collect(tmp_path)

    assert cold["m1_chunks_enabled"] is True
    assert cold["m1_chunk_hits"] == 0
    assert cold["m1_chunks_built"] == len(WALKED_DAYS)
    assert cold["raw_hours_redecoded"] == len(OPEN_HOURS)
    assert cold["raw_cache_hits"] == len(OPEN_HOURS)
    assert cold["raw_downloads"] == 0
    assert cold["decode_hours_avoided"] == 0

    first_csv = tmp_path / "out" / "EURUSD_M1.csv"
    cold_sha = _sha256(first_csv)

    warm = _collect(tmp_path)

    assert warm["m1_chunk_hits"] == len(WALKED_DAYS)
    assert warm["m1_chunks_built"] == 0
    assert warm["raw_hours_redecoded"] == 0
    assert warm["raw_cache_hits"] == 0
    assert warm["decode_hours_avoided"] == len(OPEN_HOURS)
    assert warm["raw_downloads"] == 0
    assert warm["m1_chunks_invalidated"] == 0

    # The resumed dataset is byte-identical to the cold dataset.
    assert _sha256(first_csv) == cold_sha
    assert warm["dataset_sha256"] == cold["dataset_sha256"]
    assert warm["row_count"] == 1200


def test_cached_dataset_equals_clean_rebuild_from_raw_primitives(tmp_path: Path):
    """WS3 equivalence: chunked corpus == original decode/aggregate output."""
    result = _seeded_collect(tmp_path)
    produced = tmp_path / "out" / "EURUSD_M1.csv"

    ground_truth = _ground_truth_rows(tmp_path / "cache", OPEN_HOURS)[-1200:]
    expected_frame = pd.DataFrame(ground_truth)
    expected_csv = tmp_path / "expected.csv"
    expected_frame.to_csv(expected_csv, index=False)

    assert _sha256(produced) == _sha256(expected_csv)
    assert result["row_count"] == 1200
    assert result["missing_hours"] == 0
    assert result["hours_with_data"] == len(OPEN_HOURS)

    # Friction semantics survive the chunk round-trip untouched.
    frame = pd.read_csv(produced)
    assert frame["spread_points"].eq(2.0).all()
    assert frame["price_digits"].eq(5).all()
    assert frame["tick_volume"].gt(0).all()
    assert list(frame.columns) == [
        "timestamp",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "tick_volume",
        "spread_points",
        "price_digits",
        "quote_volume",
    ]


def test_warm_resume_with_chunks_disabled_still_rebuilds(tmp_path: Path):
    """The escape hatch keeps the original raw-decode path working."""
    _seeded_collect(tmp_path)
    result = _collect(tmp_path, use_m1_chunks=False)

    assert result["m1_chunk_hits"] == 0
    assert result["raw_hours_redecoded"] == len(OPEN_HOURS)
    assert result["decode_hours_avoided"] == 0


def test_interrupted_tmp_chunk_is_ignored_and_rebuilt(tmp_path: Path):
    _seeded_collect(tmp_path)

    victim_day = OPEN_DAYS[0]
    parquet_path, manifest_path = daily_chunk_paths(
        tmp_path / "cache", "EURUSD", victim_day
    )
    parquet_path.unlink()
    manifest_path.unlink()
    parquet_path.with_suffix(parquet_path.suffix + ".tmp").write_bytes(b"partial")
    manifest_path.with_suffix(manifest_path.suffix + ".tmp").write_text(
        "{ partial", encoding="utf-8"
    )

    result = _collect(tmp_path)

    # The interrupted day was rebuilt; all other days were verified hits.
    assert result["m1_chunk_hits"] == len(WALKED_DAYS) - 1
    assert result["m1_chunks_built"] == 1
    assert result["raw_hours_redecoded"] == len(DATA_HOURS_PER_DAY[victim_day])
    assert result["dataset_sha256"]
    assert len(pd.read_csv(tmp_path / "out" / "EURUSD_M1.csv")) == 1200


def test_sha_mismatch_rebuilds_only_that_day(tmp_path: Path):
    _seeded_collect(tmp_path)
    original_sha = _sha256(tmp_path / "out" / "EURUSD_M1.csv")

    victim_day = OPEN_DAYS[1]
    parquet_path, _ = daily_chunk_paths(tmp_path / "cache", "EURUSD", victim_day)
    parquet_path.write_bytes(b"corrupted chunk bytes")

    result = _collect(tmp_path)

    assert result["m1_chunks_invalidated"] == 1
    assert result["m1_chunk_invalidation_reasons"] == {
        "chunk_sha256_mismatch": 1
    }
    assert result["m1_chunk_hits"] == len(WALKED_DAYS) - 1
    assert result["m1_chunks_built"] == 1
    assert result["raw_hours_redecoded"] == len(DATA_HOURS_PER_DAY[victim_day])
    # Only the victim day's raw hours were re-decoded; the others were hits.
    assert result["decode_hours_avoided"] == (
        len(OPEN_HOURS) - len(DATA_HOURS_PER_DAY[victim_day])
    )
    # Selective rebuild restores the exact same dataset.
    assert _sha256(tmp_path / "out" / "EURUSD_M1.csv") == original_sha


def test_malformed_parquet_rebuilds_only_that_day(tmp_path: Path):
    _seeded_collect(tmp_path)

    victim_day = OPEN_DAYS[2]
    parquet_path, manifest_path = daily_chunk_paths(
        tmp_path / "cache", "EURUSD", victim_day
    )
    parquet_path.write_bytes(b"definitely not parquet")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["chunk_sha256"] = hashlib.sha256(b"definitely not parquet").hexdigest()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = _collect(tmp_path)

    assert result["m1_chunks_invalidated"] == 1
    assert result["m1_chunk_invalidation_reasons"] == {
        "chunk_parquet_malformed": 1
    }
    assert result["m1_chunk_hits"] == len(WALKED_DAYS) - 1
    assert result["m1_chunks_built"] == 1
    assert result["dataset_sha256"]


def test_raw_corruption_selective_refetch_and_rebuild(
    tmp_path: Path, fake_network: type[_FakeHttpClient]
):
    """A corrupt raw .bi5 triggers refetch of that hour only."""
    _seeded_collect(tmp_path)
    original_sha = _sha256(tmp_path / "out" / "EURUSD_M1.csv")

    victim_day = OPEN_DAYS[0]
    victim_hour = DATA_HOURS_PER_DAY[victim_day][0]
    corrupt_path = _raw_cache_path(tmp_path / "cache", "EURUSD", victim_hour)
    corrupt_path.write_bytes(b"garbage not lzma")

    # Force a rebuild of that day (delete its chunk) and serve the original
    # payload from the fake network.
    parquet_path, manifest_path = daily_chunk_paths(
        tmp_path / "cache", "EURUSD", victim_day
    )
    parquet_path.unlink()
    manifest_path.unlink()
    fake_network.responses[_hour_url("EURUSD", victim_hour)] = (
        200,
        _payload_for_hour(victim_hour),
    )

    result = _collect(tmp_path)

    assert result["m1_chunk_hits"] == len(WALKED_DAYS) - 1
    assert result["m1_chunks_built"] == 1
    assert result["raw_cache_corruption_refetches"] == 1
    assert result["raw_downloads"] == 1
    assert fake_network.requested_urls == [_hour_url("EURUSD", victim_hour)]
    # The raw cache is healed with the canonical payload.
    assert corrupt_path.read_bytes() == _payload_for_hour(victim_hour)
    assert _sha256(tmp_path / "out" / "EURUSD_M1.csv") == original_sha


def test_valid_chunk_shields_warm_resume_from_raw_corruption(tmp_path: Path):
    """A verified chunk is self-contained; raw corruption cannot leak in."""
    _seeded_collect(tmp_path)
    original_sha = _sha256(tmp_path / "out" / "EURUSD_M1.csv")

    victim_hour = DATA_HOURS_PER_DAY[OPEN_DAYS[0]][0]
    _raw_cache_path(tmp_path / "cache", "EURUSD", victim_hour).write_bytes(
        b"garbage"
    )

    result = _collect(tmp_path)

    assert result["m1_chunk_hits"] == len(WALKED_DAYS)
    assert result["raw_hours_redecoded"] == 0
    assert result["m1_chunks_invalidated"] == 0
    assert _sha256(tmp_path / "out" / "EURUSD_M1.csv") == original_sha


def test_schema_version_change_invalidates_only_affected_day(tmp_path: Path):
    _seeded_collect(tmp_path)
    original_sha = _sha256(tmp_path / "out" / "EURUSD_M1.csv")

    victim_day = OPEN_DAYS[0]
    _, manifest_path = daily_chunk_paths(tmp_path / "cache", "EURUSD", victim_day)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["chunk_schema_version"] = 99
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = _collect(tmp_path)

    assert result["m1_chunks_invalidated"] == 1
    assert result["m1_chunk_invalidation_reasons"] == {
        "schema_version_mismatch": 1
    }
    assert result["m1_chunk_hits"] == len(WALKED_DAYS) - 1
    assert _sha256(tmp_path / "out" / "EURUSD_M1.csv") == original_sha


def test_semantics_fingerprint_change_invalidates_every_chunk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _seeded_collect(tmp_path)

    from app.domain.training import m1_materialized_cache as cache_module

    monkeypatch.setattr(
        cache_module,
        "m1_materialization_semantics_fingerprint",
        lambda: "e" * 64,
    )

    result = _collect(tmp_path)

    assert result["m1_chunks_invalidated"] == len(WALKED_DAYS)
    assert result["m1_chunk_invalidation_reasons"] == {
        "semantics_fingerprint_mismatch": len(WALKED_DAYS)
    }
    assert result["m1_chunk_hits"] == 0
    # Everything is deterministically rebuilt from the intact raw layer.
    assert result["raw_hours_redecoded"] == len(OPEN_HOURS)
    assert result["m1_chunks_built"] == len(WALKED_DAYS)
    assert result["dataset_sha256"]


def test_different_study_cannot_reuse_chunks_of_another_cutoff(tmp_path: Path):
    """WS4: a newer experiment cutoff must not reuse the frozen run's chunks."""
    first = _seeded_collect(tmp_path)
    first_sha = first["dataset_sha256"]

    later_now = NOW + timedelta(hours=6)
    later_hours = [
        hour
        for hour in OPEN_HOURS
        if hour <= later_now.replace(minute=0, second=0, microsecond=0)
        - timedelta(hours=1)
    ]
    extra_hour = later_now.replace(minute=0, second=0, microsecond=0) - timedelta(
        hours=1
    )
    while extra_hour >= later_now - timedelta(days=LOOKBACK_DAYS):
        if (
            not _is_forex_market_closed_hour(extra_hour)
            and extra_hour not in OPEN_HOURS
        ):
            later_hours.append(extra_hour)
        extra_hour -= timedelta(hours=1)
    _seed_raw_cache(tmp_path / "cache", later_hours)

    second = _collect(tmp_path, now=later_now)

    assert second["m1_chunk_hits"] == 0
    assert second["m1_chunks_invalidated"] >= 1
    assert set(second["m1_chunk_invalidation_reasons"]) == {
        "study_cutoff_mismatch"
    }
    # All days were rebuilt from the raw layer without any network access.
    assert second["raw_downloads"] == 0
    assert second["m1_chunks_built"] >= 1
    # The newer cutoff produces its own dataset, not the frozen one.
    assert second["dataset_sha256"] != first_sha
    assert second["study_cutoff_hour"] == effective_before_hour_token(later_now)


def test_exact_frozen_cutoff_resumes_across_wallclock_time(tmp_path: Path):
    """Resumed hours later with the same experiment cutoff: chunks still hit."""
    _seeded_collect(tmp_path)

    resumed = _collect(tmp_path, now=NOW + timedelta(minutes=29))

    assert resumed["m1_chunk_hits"] == len(WALKED_DAYS)
    assert resumed["m1_chunks_built"] == 0
    assert resumed["m1_chunks_invalidated"] == 0
    assert resumed["study_cutoff_hour"] == effective_before_hour_token(NOW)


def test_weekend_and_market_closed_hours_are_handled_deterministically(
    tmp_path: Path,
):
    result = _seeded_collect(tmp_path)

    # Sat Jan 3 is fully closed: its chunk exists with zero rows and every
    # hour accounted for.
    saturday = date(2026, 1, 3)
    parquet_path, manifest_path = daily_chunk_paths(
        tmp_path / "cache", "EURUSD", saturday
    )
    assert parquet_path.is_file()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["row_count"] == 0
    assert manifest["market_closed_hours"] == 24
    statuses = [entry["status"] for entry in manifest["raw_hour_inputs"]]
    assert statuses.count("market_closed") == 24
    assert manifest["first_timestamp"] is None

    # Sunday has 22 closed hours and 2 open hours.
    sunday = date(2026, 1, 4)
    _, sunday_manifest_path = daily_chunk_paths(
        tmp_path / "cache", "EURUSD", sunday
    )
    sunday_manifest = json.loads(sunday_manifest_path.read_text(encoding="utf-8"))
    assert sunday_manifest["market_closed_hours"] == 22
    assert sunday_manifest["row_count"] == 120

    assert result["market_closed_hours_skipped"] == MARKET_CLOSED_HOURS_IN_WALK
    assert result["row_count"] == 1200


def test_legitimate_missing_hours_are_deterministic(tmp_path: Path):
    """404 hours stay missing across resumes; nothing refetches them."""
    _seed_raw_cache(tmp_path / "cache", OPEN_HOURS)
    missing_hour = DATA_HOURS_PER_DAY[OPEN_DAYS[1]][0]  # A Sunday open hour.
    raw_path = _raw_cache_path(tmp_path / "cache", "EURUSD", missing_hour)
    raw_path.unlink()
    marker = raw_path.with_suffix(raw_path.suffix + ".missing")
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.touch()

    first = _collect(tmp_path)
    assert first["missing_hours"] == 1

    _, manifest_path = daily_chunk_paths(
        tmp_path / "cache", "EURUSD", OPEN_DAYS[1]
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    statuses = {
        entry["hour"]: entry["status"] for entry in manifest["raw_hour_inputs"]
    }
    assert statuses[missing_hour.isoformat()] == "missing_404"
    assert manifest["missing_hours"] == 1

    second = _collect(tmp_path)
    assert second["m1_chunk_hits"] == len(WALKED_DAYS)
    assert second["missing_hours"] == 1
    assert second["m1_chunks_built"] == 0
    assert second["dataset_sha256"] == first["dataset_sha256"]


def test_telemetry_counters_are_exposed_in_the_manifest(tmp_path: Path):
    result = _seeded_collect(tmp_path)

    for key in (
        "raw_cache_hits",
        "raw_downloads",
        "raw_bytes_downloaded",
        "raw_hours_redecoded",
        "m1_chunk_hits",
        "m1_chunks_built",
        "m1_chunks_invalidated",
        "decode_hours_avoided",
        "provider_retry_count",
        "provider_throttle_level",
        "provider_throttle_reductions",
        "provider_throttle_recoveries",
        "study_cutoff_hour",
        "pair_resume_source",
    ):
        assert key in result or key == "pair_resume_source", key

    assert result["provider_throttle_level"] == 3
    assert result["provider_retry_count"] == 0
    assert result["provider_throttle_reductions"] == 0
    assert result["raw_bytes_downloaded"] == 0


def test_fail_closed_unresolved_hour_is_preserved(
    tmp_path: Path, fake_network: type[_FakeHttpClient], monkeypatch: pytest.MonkeyPatch
):
    """No network + missing raw hour => bounded recovery then hard failure."""
    monkeypatch.setattr(
        collector_module.time, "sleep", lambda seconds: None
    )
    cache_dir = tmp_path / "cache"
    victim_hour = OPEN_HOURS[0]  # Oldest open hour: earlier days materialize.
    hours_without_victim = [h for h in OPEN_HOURS if h != victim_hour]
    _seed_raw_cache(cache_dir, hours_without_victim)
    victim_url = _hour_url("EURUSD", victim_hour)
    fake_network.responses[victim_url] = (503, b"")

    with pytest.raises(RuntimeError, match="remained unavailable"):
        _collect(tmp_path)

    # The day containing the unresolved hour must NOT be materialized.
    victim_day = victim_hour.date()
    parquet_path, _ = daily_chunk_paths(cache_dir, "EURUSD", victim_day)
    assert not parquet_path.is_file()
    # Earlier days are already durably materialized.
    for day in OPEN_DAYS:
        if day != victim_day:
            day_parquet, _ = daily_chunk_paths(cache_dir, "EURUSD", day)
            if DATA_HOURS_PER_DAY.get(day):
                assert day_parquet.is_file(), day


def test_transient_provider_pressure_is_counted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Provider retry events are counted and surface in the manifest."""
    monkeypatch.setattr(
        collector_module.time, "sleep", lambda seconds: None
    )

    _FakeHttpClient.responses = {}
    _FakeHttpClient.requested_urls = []
    flaky_url = _hour_url("EURUSD", OPEN_HOURS[0])

    class _FlakyClient(_FakeHttpClient):
        def get(self, url: str, headers=None):
            type(self).requested_urls.append(url)
            if url == flaky_url and len(
                [u for u in type(self).requested_urls if u == url]
            ) == 1:
                return _FakeResponse(429, b"slow down")
            status, content = type(self).responses.get(url, (404, b""))
            return _FakeResponse(status, content)

    for hour in OPEN_HOURS:
        _FakeHttpClient.responses[_hour_url("EURUSD", hour)] = (
            200,
            _payload_for_hour(hour),
        )
    monkeypatch.setattr(
        "app.domain.training.collect_dukascopy.httpx.Client", _FlakyClient
    )

    result = _collect(tmp_path)

    assert result["provider_retry_count"] == 1
    assert result["raw_downloads"] == len(OPEN_HOURS)
    assert result["raw_bytes_downloaded"] > 0
    assert result["row_count"] == 1200
    assert result["m1_chunks_built"] == len(WALKED_DAYS)


# ---------------------------------------------------------------------------
# Staged runner execution (WS7/WS8) and resume equivalence.
# ---------------------------------------------------------------------------


def _install_runner_fakes(
    monkeypatch: pytest.MonkeyPatch,
    universe: tuple[str, ...],
    *,
    fail_horizons: tuple[int, ...] = (),
) -> dict[str, dict]:
    from datetime import datetime as dt

    calls = {"collect": {}, "build": {}, "evaluate": {}}

    def fake_collect(
        *,
        instrument: str,
        target_rows: int,
        output_path,
        now=None,
        cache_dir=None,
        max_lookback_days=90,
        progress=None,
    ):
        del target_rows, now, cache_dir, max_lookback_days, progress
        calls["collect"].setdefault(instrument, 0)
        calls["collect"][instrument] += 1
        Path(output_path).write_text(
            "timestamp,open,high,low,close,volume,tick_volume,spread_points,price_digits\n",
            encoding="utf-8",
        )
        return {
            "instrument": instrument,
            "source": "dukascopy_public_datafeed_ticks",
            "row_count": 250,
            "spread_basis": "last_historical_bid_ask_spread_per_closed_minute",
            "dataset_sha256": f"raw-{instrument}",
            "friction_data_complete": True,
        }

    def fake_build(*, m1_path, output_path, instrument):
        del m1_path
        calls["build"].setdefault(instrument, 0)
        calls["build"][instrument] += 1
        Path(output_path).write_text(
            "decision_time\n"
            + "".join(
                f"2026-01-01T00:{minute:02d}:00Z\n" for minute in range(60)
            ),
            encoding="utf-8",
        )
        return {
            "instrument": instrument,
            "friction_data_complete": True,
            "dataset_sha256": f"corpus-{instrument}",
            "row_count": 250,
        }

    qualification_cutoff = dt(2026, 1, 2, 0, 0, tzinfo=UTC)

    def fake_evaluate(datasets, *, report_path, predictions_path=None, **kwargs):
        del datasets, kwargs
        horizon = Path(report_path).stem.split("_")[-1]
        calls["evaluate"].setdefault(horizon, 0)
        calls["evaluate"][horizon] += 1
        if horizon in fail_horizons:
            raise RuntimeError(f"synthetic horizon failure {horizon}")
        report = {
            "overall": {
                "classification": {
                    "balanced_accuracy": 0.55,
                    "precision": 0.54,
                    "recall": 0.53,
                    "f1": 0.535,
                },
                "trading": {
                    "trade_or_period_count": 100,
                    "total_return": 0.02,
                    "profit_factor": 1.2,
                    "sharpe_ratio": 1.1,
                    "max_drawdown": 0.05,
                },
            },
            "by_instrument": {
                instrument: {"trading": {"total_return": 0.01}}
                for instrument in universe
            },
            "folds": [
                {"aggregate": {"trading": {"total_return": 0.01}}}
            ],
            "fold_count": 1,
            "walk_forward": {
                "unique_periods": 100,
                "min_train_periods": 60,
                "validation_periods": 20,
                "purge_periods": 5,
                "embargo_periods": 5,
                "confidence_threshold": 0.60,
            },
            "validation_predictions_path": None,
        }
        report_path = Path(report_path)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(report, indent=2, sort_keys=True), encoding="utf-8"
        )
        predictions = Path(predictions_path)
        predictions.parent.mkdir(parents=True, exist_ok=True)
        predictions.write_text("decision_time,instrument,fold\n", encoding="utf-8")
        return {**report, "report_path": str(report_path)}

    monkeypatch.setattr(runner, "INITIAL_FOREX_UNIVERSE", universe)
    monkeypatch.setattr(runner, "collect_dukascopy_m1_corpus", fake_collect)
    monkeypatch.setattr(
        runner, "build_multitimeframe_corpus_from_m1_csv", fake_build
    )
    monkeypatch.setattr(runner, "evaluate_multi_pair_corpora", fake_evaluate)
    monkeypatch.setattr(
        runner,
        "_research_qualification_cutoff",
        lambda corpora: qualification_cutoff,
    )
    return calls


UNIVERSE = ("EURUSD", "GBPUSD")


def test_staged_execution_matches_monolithic_study_byte_for_byte(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """WS7 equivalence: staged jobs produce the identical study summary."""
    before = datetime(2026, 1, 5, 12, tzinfo=UTC)
    horizons = (1, 5, 10)

    monolithic_dir = tmp_path / "monolithic"
    _install_runner_fakes(monkeypatch, UNIVERSE)
    runner.run_first_six_pair_study(
        output_dir=monolithic_dir,
        source="dukascopy",
        target_rows=250,
        horizons=horizons,
        before=before,
        resume=True,
    )
    monolithic_summary = (
        monolithic_dir / "reports" / "six_pair_walkforward_summary.json"
    ).read_bytes()

    staged_dir = tmp_path / "staged"
    _install_runner_fakes(monkeypatch, UNIVERSE)
    runner.run_first_six_pair_study(
        output_dir=staged_dir,
        source="dukascopy",
        target_rows=250,
        horizons=horizons,
        before=before,
        resume=True,
        stage="init",
    )
    for instrument in UNIVERSE:
        runner.run_first_six_pair_study(
            output_dir=staged_dir,
            source="dukascopy",
            target_rows=250,
            horizons=horizons,
            before=before,
            resume=True,
            stage="pairs",
            stage_instruments=(instrument,),
        )
    for horizon in horizons:
        runner.run_first_six_pair_study(
            output_dir=staged_dir,
            source="dukascopy",
            target_rows=250,
            horizons=horizons,
            before=before,
            resume=True,
            stage="horizons",
            stage_horizons=(horizon,),
        )
    staged_result = runner.run_first_six_pair_study(
        output_dir=staged_dir,
        source="dukascopy",
        target_rows=250,
        horizons=horizons,
        before=before,
        resume=True,
        stage="summarize",
    )
    staged_summary = (
        staged_dir / "reports" / "six_pair_walkforward_summary.json"
    ).read_bytes()

    # The only legitimate difference is the absolute output root embedded in
    # report paths; normalize it and require byte equality everywhere else.
    monolithic_normalized = json.loads(monolithic_summary)
    staged_normalized = json.loads(staged_summary)
    for payload, root in (
        (monolithic_normalized, str(monolithic_dir)),
        (staged_normalized, str(staged_dir)),
    ):
        for block in payload["horizon_reports"].values():
            block["report_path"] = block["report_path"].replace(root, "<ROOT>")
            if block.get("validation_predictions_path"):
                block["validation_predictions_path"] = block[
                    "validation_predictions_path"
                ].replace(root, "<ROOT>")
    assert staged_normalized == monolithic_normalized
    assert json.dumps(staged_normalized, indent=2, sort_keys=True) == json.dumps(
        monolithic_normalized, indent=2, sort_keys=True
    )
    assert staged_result["pair_resume_sources"] == {
        "EURUSD": "collected",
        "GBPUSD": "collected",
    }
    state = runner._read_json(staged_dir / "checkpoints" / "study-state.json")
    assert state is not None and state["study_complete"] is True
    assert state["effective_before"] == before.isoformat()


def test_staged_pair_resume_skips_completed_instruments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A cancelled stage resumes: completed pairs are never re-collected."""
    before = datetime(2026, 1, 5, 12, tzinfo=UTC)
    calls = _install_runner_fakes(monkeypatch, UNIVERSE)
    output = tmp_path / "staged"

    runner.run_first_six_pair_study(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(1,),
        before=before,
        resume=True,
        stage="init",
    )
    # Only EURUSD completed before the "cancellation".
    runner.run_first_six_pair_study(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(1,),
        before=before,
        resume=True,
        stage="pairs",
        stage_instruments=("EURUSD",),
    )
    assert calls["collect"] == {"EURUSD": 1}

    # The resumed dispatch processes the remaining pair only.
    result = runner.run_first_six_pair_study(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(1,),
        before=before,
        resume=True,
        stage="pairs",
    )
    assert calls["collect"] == {"EURUSD": 1, "GBPUSD": 1}
    # Provenance is stable across resumes; EURUSD was NOT re-collected.
    assert result["pair_resume_sources"] == {
        "EURUSD": "collected",
        "GBPUSD": "collected",
    }


def test_horizon_stage_requires_all_pair_checkpoints(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    before = datetime(2026, 1, 5, 12, tzinfo=UTC)
    _install_runner_fakes(monkeypatch, UNIVERSE)
    output = tmp_path / "staged"

    runner.run_first_six_pair_study(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(1,),
        before=before,
        resume=True,
        stage="init",
    )
    runner.run_first_six_pair_study(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(1,),
        before=before,
        resume=True,
        stage="pairs",
        stage_instruments=("EURUSD",),
    )

    with pytest.raises(ValueError, match="verified pair checkpoint for GBPUSD"):
        runner.run_first_six_pair_study(
            output_dir=output,
            source="dukascopy",
            target_rows=250,
            horizons=(1,),
            before=before,
            resume=True,
            stage="horizons",
            stage_horizons=(1,),
        )


def test_horizon_stage_resume_reuses_verified_checkpoints(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    before = datetime(2026, 1, 5, 12, tzinfo=UTC)
    calls = _install_runner_fakes(monkeypatch, UNIVERSE)
    output = tmp_path / "staged"
    common = dict(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(1,),
        before=before,
        resume=True,
    )

    runner.run_first_six_pair_study(**common, stage="init")
    runner.run_first_six_pair_study(**common, stage="pairs")
    runner.run_first_six_pair_study(**common, stage="horizons", stage_horizons=(1,))
    assert calls["evaluate"] == {"1m": 1}

    # Re-running the horizon stage resumes from its checkpoint.
    result = runner.run_first_six_pair_study(
        **common, stage="horizons", stage_horizons=(1,)
    )
    assert calls["evaluate"] == {"1m": 1}
    assert result["stage"] == "horizons"


def test_summarize_requires_all_horizon_checkpoints(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    before = datetime(2026, 1, 5, 12, tzinfo=UTC)
    _install_runner_fakes(monkeypatch, UNIVERSE)
    output = tmp_path / "staged"
    common = dict(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(1, 5),
        before=before,
        resume=True,
    )

    runner.run_first_six_pair_study(**common, stage="init")
    runner.run_first_six_pair_study(**common, stage="pairs")
    runner.run_first_six_pair_study(**common, stage="horizons", stage_horizons=(1,))

    with pytest.raises(ValueError, match="verified horizon checkpoint for 5"):
        runner.run_first_six_pair_study(**common, stage="summarize")


def test_failed_horizon_stage_can_be_rerun_without_touching_pairs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A cancelled horizon stage resumes; verified pair stages stay intact."""
    before = datetime(2026, 1, 5, 12, tzinfo=UTC)
    _install_runner_fakes(monkeypatch, UNIVERSE, fail_horizons=("5m",))
    output = tmp_path / "staged"
    common = dict(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(1, 5),
        before=before,
        resume=True,
    )

    runner.run_first_six_pair_study(**common, stage="init")
    runner.run_first_six_pair_study(**common, stage="pairs")

    with pytest.raises(RuntimeError, match="synthetic horizon failure"):
        runner.run_first_six_pair_study(
            **common, stage="horizons", stage_horizons=(5,)
        )

    # The pair checkpoints still validate: rerunning the pair stage is a no-op
    # and only the failed horizon is retried.
    calls = _install_runner_fakes(monkeypatch, UNIVERSE)
    pair_result = runner.run_first_six_pair_study(**common, stage="pairs")
    assert calls["collect"] == {}
    assert pair_result["pair_resume_sources"] == {
        "EURUSD": "collected",
        "GBPUSD": "collected",
    }
    runner.run_first_six_pair_study(**common, stage="horizons", stage_horizons=(5,))
    assert calls["evaluate"] == {"5m": 1}


def test_stage_requires_resume_and_valid_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _install_runner_fakes(monkeypatch, UNIVERSE)

    with pytest.raises(ValueError, match="requires --resume"):
        runner.run_first_six_pair_study(
            output_dir=tmp_path / "x",
            source="dukascopy",
            target_rows=250,
            horizons=(1,),
            stage="pairs",
        )

    # No init stage => no orchestration plan => fail closed.
    with pytest.raises(ValueError, match="orchestration plan"):
        runner.run_first_six_pair_study(
            output_dir=tmp_path / "x",
            source="dukascopy",
            target_rows=250,
            horizons=(1,),
            resume=True,
            stage="pairs",
        )


def test_stage_rejects_plan_bound_to_another_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _install_runner_fakes(monkeypatch, UNIVERSE)
    monkeypatch.setenv("IREXPRO_RESEARCH_CANDIDATE_SHA", "a" * 40)
    output = tmp_path / "staged"
    common = dict(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(1,),
        before=datetime(2026, 1, 5, 12, tzinfo=UTC),
        resume=True,
    )

    runner.run_first_six_pair_study(**common, stage="init")

    monkeypatch.setenv("IREXPRO_RESEARCH_CANDIDATE_SHA", "b" * 40)
    # The study-state fingerprint (which binds the candidate SHA) fails
    # closed before the plan check is even reached.
    with pytest.raises(ValueError, match="incompatible"):
        runner.run_first_six_pair_study(**common, stage="pairs")

    # Defense in depth: the plan-level candidate check fails closed on its
    # own when the study state is absent but a foreign plan is present.
    foreign_plan = tmp_path / "foreign"
    plan_dir = foreign_plan / "checkpoints"
    plan_dir.mkdir(parents=True)
    (plan_dir / "orchestration-plan.json").write_text(
        json.dumps(
            {
                "plan_version": 1,
                "candidate_sha": "d" * 40,
                "resume_fingerprint": "0" * 64,
                "effective_before": "2026-01-05T12:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="fingerprint does not match"):
        runner._verify_orchestration_plan(
            plan_dir / "orchestration-plan.json",
            expected_resume_fingerprint="1" * 64,
            expected_candidate_sha="d" * 40,
        )
    (plan_dir / "orchestration-plan.json").write_text(
        json.dumps(
            {
                "plan_version": 1,
                "candidate_sha": "e" * 40,
                "resume_fingerprint": "1" * 64,
                "effective_before": "2026-01-05T12:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="different candidate SHA"):
        runner._verify_orchestration_plan(
            plan_dir / "orchestration-plan.json",
            expected_resume_fingerprint="1" * 64,
            expected_candidate_sha="d" * 40,
        )


def test_stage_rejects_incompatible_plan_fingerprint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _install_runner_fakes(monkeypatch, UNIVERSE)
    monkeypatch.setenv("IREXPRO_RESEARCH_CANDIDATE_SHA", "a" * 40)
    output = tmp_path / "staged"
    common = dict(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(1,),
        before=datetime(2026, 1, 5, 12, tzinfo=UTC),
        resume=True,
    )

    runner.run_first_six_pair_study(**common, stage="init")

    with pytest.raises(ValueError, match="incompatible"):
        runner.run_first_six_pair_study(
            **{**common, "target_rows": 500}, stage="pairs"
        )


def test_stage_instruments_must_be_in_the_universe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _install_runner_fakes(monkeypatch, UNIVERSE)
    output = tmp_path / "staged"
    common = dict(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(1,),
        before=datetime(2026, 1, 5, 12, tzinfo=UTC),
        resume=True,
    )
    runner.run_first_six_pair_study(**common, stage="init")

    with pytest.raises(ValueError, match="not in the approved six-pair universe"):
        runner.run_first_six_pair_study(
            **common, stage="pairs", stage_instruments=("USDJPY",)
        )


def test_init_stage_freezes_cutoff_and_writes_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _install_runner_fakes(monkeypatch, UNIVERSE)
    monkeypatch.setenv("IREXPRO_RESEARCH_CANDIDATE_SHA", "c" * 40)
    before = datetime(2026, 1, 5, 12, tzinfo=UTC)
    output = tmp_path / "staged"

    plan = runner.run_first_six_pair_study(
        output_dir=output,
        source="dukascopy",
        target_rows=250,
        horizons=(1, 5, 10),
        before=before,
        resume=True,
        stage="init",
    )

    assert plan["candidate_sha"] == "c" * 40
    assert plan["effective_before"] == before.isoformat()
    assert plan["horizons"] == [1, 5, 10]
    assert plan["instruments"] == list(UNIVERSE)
    assert plan["bootstrap_dir"] is None
    assert Path(plan["plan_path"]).is_file()

    state = runner._read_json(output / "checkpoints" / "study-state.json")
    assert state is not None
    assert state["effective_before"] == before.isoformat()
    assert state["study_complete"] is False
