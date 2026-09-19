"""Tests for reproducible multi-instrument historical corpus sets."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.domain.training.collect_corpus_set import (
    DEFAULT_INSTRUMENTS,
    collect_historical_corpus_set,
)


def test_collect_corpus_set_uses_one_cutoff_and_writes_manifest(tmp_path: Path):
    calls: list[dict[str, Any]] = []
    account_fingerprint = "a" * 64

    def collector(**kwargs):
        calls.append(kwargs)
        instrument = kwargs["instrument"]
        output = Path(kwargs["output_path"])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text("timestamp,open,high,low,close,volume\n", encoding="utf-8")
        child_manifest = output.with_suffix(".manifest.json")
        child_manifest.write_text("{}", encoding="utf-8")
        return {
            "instrument": instrument,
            "timeframe": "H1",
            "row_count": 10000,
            "pages_fetched": 20,
            "start": "2024-01-01T00:00:00+00:00",
            "end": "2025-02-20T15:00:00+00:00",
            "dataset_sha256": instrument.lower().ljust(64, "0")[:64],
            "closed_candles_only": True,
            "source_account_fingerprint": account_fingerprint,
            "dataset_path": str(output),
            "manifest_path": str(child_manifest),
        }

    cutoff = datetime(2026, 9, 19, 18, 0, tzinfo=UTC)
    result = collect_historical_corpus_set(
        api_base_url="https://api.example.test/api/v1",
        internal_api_key="internal-key",
        user_id="00000000-0000-0000-0000-000000000001",
        broker_connection_id="00000000-0000-0000-0000-000000000002",
        output_dir=tmp_path,
        before=cutoff,
        collected_at=cutoff,
        collector=collector,
    )

    assert tuple(result["instruments"]) == DEFAULT_INSTRUMENTS
    assert result["instrument_count"] == 6
    assert result["total_rows"] == 60000
    assert result["target_rows_per_instrument"] == 10000
    assert result["common_before"] == cutoff.isoformat()
    assert result["source_account_fingerprint"] == account_fingerprint
    assert len(result["corpus_set_id"]) == 64
    assert len(calls) == 6
    assert all(call["before"] == cutoff for call in calls)
    assert all(call["now"] == cutoff for call in calls)

    manifest_path = Path(result["manifest_path"])
    assert manifest_path.is_file()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["total_rows"] == 60000
    assert set(manifest["datasets"]) == set(DEFAULT_INSTRUMENTS)
    manifest_text = manifest_path.read_text(encoding="utf-8")
    assert "00000000-0000-0000-0000-000000000001" not in manifest_text
    assert "00000000-0000-0000-0000-000000000002" not in manifest_text


def test_collect_corpus_set_fails_closed_on_incomplete_pair(tmp_path: Path):
    def collector(**kwargs):
        instrument = kwargs["instrument"]
        output = Path(kwargs["output_path"])
        return {
            "instrument": instrument,
            "timeframe": "H1",
            "row_count": 9999 if instrument == "USDJPY" else 10000,
            "pages_fetched": 20,
            "start": "2024-01-01T00:00:00+00:00",
            "end": "2025-02-20T15:00:00+00:00",
            "dataset_sha256": "b" * 64,
            "closed_candles_only": True,
            "source_account_fingerprint": "a" * 64,
            "dataset_path": str(output),
            "manifest_path": str(output.with_suffix(".manifest.json")),
        }

    try:
        collect_historical_corpus_set(
            api_base_url="https://api.example.test/api/v1",
            internal_api_key="internal-key",
            user_id="u",
            broker_connection_id="c",
            output_dir=tmp_path,
            collector=collector,
            collected_at=datetime(2026, 9, 19, 18, 0, tzinfo=UTC),
        )
    except ValueError as exc:
        assert "USDJPY corpus incomplete" in str(exc)
    else:
        raise AssertionError("Expected incomplete corpus-set failure")

    assert not (tmp_path / "corpus-set.manifest.json").exists()


def test_collect_corpus_set_clears_stale_complete_manifest_before_refresh(tmp_path: Path):
    stale_manifest = tmp_path / "corpus-set.manifest.json"
    stale_manifest.write_text('{"complete": true}', encoding="utf-8")

    def collector(**kwargs):
        instrument = kwargs["instrument"]
        output = Path(kwargs["output_path"])
        return {
            "instrument": instrument,
            "timeframe": "H1",
            "row_count": 10 if instrument == "EURUSD" else 10000,
            "pages_fetched": 1,
            "start": "2024-01-01T00:00:00+00:00",
            "end": "2025-02-20T15:00:00+00:00",
            "dataset_sha256": "c" * 64,
            "closed_candles_only": True,
            "source_account_fingerprint": "a" * 64,
            "dataset_path": str(output),
            "manifest_path": str(output.with_suffix(".manifest.json")),
        }

    try:
        collect_historical_corpus_set(
            api_base_url="https://api.example.test/api/v1",
            internal_api_key="internal-key",
            user_id="u",
            broker_connection_id="c",
            output_dir=tmp_path,
            collector=collector,
            collected_at=datetime(2026, 9, 19, 18, 0, tzinfo=UTC),
        )
    except ValueError as exc:
        assert "EURUSD corpus incomplete" in str(exc)
    else:
        raise AssertionError("Expected incomplete corpus-set failure")

    assert not stale_manifest.exists()
