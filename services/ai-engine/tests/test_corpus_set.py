"""Tests for reproducible multi-instrument corpus collection."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

from app.domain.training.collect_corpus_set import collect_corpus_set


def test_collect_corpus_set_uses_common_cutoff_and_manifest(tmp_path: Path):
    start = datetime(2025, 1, 1, tzinfo=UTC)
    instruments = ["EURUSD", "GBPUSD"]
    source: dict[str, list[dict[str, str]]] = {}

    for offset, instrument in enumerate(instruments):
        rows: list[dict[str, str]] = []
        for index in range(320):
            timestamp = start + timedelta(hours=index)
            close = 1.10 + offset * 0.10 + index * 0.00001
            rows.append(
                {
                    "timestamp": timestamp.isoformat(),
                    "open": f"{close - 0.0001:.5f}",
                    "high": f"{close + 0.0002:.5f}",
                    "low": f"{close - 0.0002:.5f}",
                    "close": f"{close:.5f}",
                    "volume": str(1000 + index),
                }
            )
        source[instrument] = rows

    seen_before: dict[str, set[str]] = {instrument: set() for instrument in instruments}

    def handler(request: httpx.Request) -> httpx.Response:
        instrument = request.url.params["instrument"]
        before = request.url.params["before"]
        limit = int(request.url.params["limit"])
        seen_before[instrument].add(before)
        before_dt = datetime.fromisoformat(before.replace("Z", "+00:00"))
        eligible = [
            candle
            for candle in source[instrument]
            if datetime.fromisoformat(candle["timestamp"]) <= before_dt
        ]
        page = eligible[-limit:]
        return httpx.Response(
            200,
            json={
                "instrument": instrument,
                "timeframe": "H1",
                "source": "broker",
                "count": len(page),
                "candles": page,
            },
        )

    import app.domain.training.collect_historical as historical

    original_client = httpx.Client
    historical.httpx.Client = lambda timeout=30.0: original_client(
        transport=httpx.MockTransport(handler),
        timeout=timeout,
    )
    try:
        cutoff = datetime(2025, 2, 1, tzinfo=UTC)
        result = collect_corpus_set(
            api_base_url="https://api.example.test/api/v1",
            internal_api_key="test-internal-key",
            user_id="00000000-0000-0000-0000-000000000001",
            broker_connection_id="00000000-0000-0000-0000-000000000002",
            instruments=instruments,
            timeframe="H1",
            target_rows=300,
            output_dir=tmp_path,
            before=cutoff,
        )
    finally:
        historical.httpx.Client = original_client

    assert result["instrument_count"] == 2
    assert result["instruments"] == instruments
    assert result["common_cutoff"] == cutoff.isoformat()
    assert len(result["corpus_set_sha256"]) == 64

    manifest_path = Path(result["manifest_path"])
    assert manifest_path.is_file()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["instrument_count"] == 2
    assert all(item["row_count"] == 300 for item in manifest["datasets"])
    assert all(Path(item["dataset_path"]).is_file() for item in manifest["datasets"])
    assert all(seen_before[instrument] for instrument in instruments)


def test_collect_corpus_set_rejects_duplicate_instruments(tmp_path: Path):
    try:
        collect_corpus_set(
            api_base_url="https://api.example.test/api/v1",
            internal_api_key="test-key",
            user_id="user",
            broker_connection_id="connection",
            instruments=["EURUSD", "eurusd"],
            timeframe="H1",
            target_rows=300,
            output_dir=tmp_path,
        )
    except ValueError as exc:
        assert "Duplicate instruments" in str(exc)
    else:
        raise AssertionError("Expected duplicate-instrument validation error")
