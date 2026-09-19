"""Tests for multi-instrument historical training corpus collection."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pandas as pd

from app.domain.training.collect_universe import collect_training_universe


def test_collect_training_universe_uses_common_cutoff_and_writes_manifest(tmp_path: Path):
    start = datetime(2026, 1, 1, tzinfo=UTC)
    sources: dict[str, list[dict[str, str]]] = {}

    for symbol, base in (("EURUSD", 1.10), ("GBPUSD", 1.30)):
        rows: list[dict[str, str]] = []
        for index in range(320):
            timestamp = start + timedelta(hours=index)
            close = base + index * 0.00001
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
        sources[symbol] = rows

    first_before: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        symbol = request.url.params["instrument"]
        before_raw = request.url.params["before"]
        first_before.setdefault(symbol, before_raw)
        before = datetime.fromisoformat(before_raw.replace("Z", "+00:00"))
        limit = int(request.url.params["limit"])
        eligible = [
            candle
            for candle in sources[symbol]
            if datetime.fromisoformat(candle["timestamp"]) <= before
        ]
        page = eligible[-limit:]
        return httpx.Response(
            200,
            json={
                "instrument": symbol,
                "timeframe": "H1",
                "source": "broker",
                "count": len(page),
                "candles": page,
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    common_now = datetime(2026, 2, 1, tzinfo=UTC)
    result = collect_training_universe(
        api_base_url="https://api.example.test/api/v1",
        internal_api_key="test-internal-key",
        user_id="00000000-0000-0000-0000-000000000001",
        broker_connection_id="00000000-0000-0000-0000-000000000002",
        instruments=("EURUSD", "GBPUSD"),
        timeframe="H1",
        target_rows_per_instrument=300,
        page_size=200,
        output_dir=tmp_path,
        client=client,
        now=common_now,
    )

    assert result["instrument_count"] == 2
    assert result["instruments"] == ["EURUSD", "GBPUSD"]
    assert first_before["EURUSD"] == first_before["GBPUSD"]
    assert Path(result["manifest_path"]).is_file()

    for dataset in result["datasets"]:
        frame = pd.read_csv(dataset["dataset_path"])
        assert len(frame) == 300
        assert frame["timestamp"].is_unique
        assert dataset["closed_candles_only"] is True
        assert len(dataset["dataset_sha256"]) == 64


def test_collect_training_universe_deduplicates_requested_symbols(tmp_path: Path):
    # Input normalization should fail before any HTTP call when the resulting
    # universe is empty, and should remove duplicates when non-empty.
    try:
        collect_training_universe(
            api_base_url="https://api.example.test/api/v1",
            internal_api_key="test-internal-key",
            user_id="00000000-0000-0000-0000-000000000001",
            broker_connection_id="00000000-0000-0000-0000-000000000002",
            instruments=("", "   "),
            output_dir=tmp_path,
        )
    except ValueError as exc:
        assert "At least one instrument" in str(exc)
    else:
        raise AssertionError("Expected empty training universe to be rejected")
