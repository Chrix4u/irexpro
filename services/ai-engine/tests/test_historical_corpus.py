"""Tests for broker-backed historical corpus collection."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pandas as pd

from app.domain.training.collect_historical import collect_historical_corpus


def test_collect_historical_corpus_pages_backwards_and_deduplicates(tmp_path: Path):
    start = datetime(2026, 1, 1, tzinfo=UTC)
    source = []
    for index in range(360):
        timestamp = start + timedelta(hours=index)
        close = 1.10 + index * 0.00001
        source.append(
            {
                "timestamp": timestamp.isoformat(),
                "open": f"{close - 0.0001:.5f}",
                "high": f"{close + 0.0002:.5f}",
                "low": f"{close - 0.0002:.5f}",
                "close": f"{close:.5f}",
                "volume": str(1000 + index),
            }
        )

    requested_before: list[datetime] = []

    def handler(request: httpx.Request) -> httpx.Response:
        before = datetime.fromisoformat(request.url.params["before"].replace("Z", "+00:00"))
        limit = int(request.url.params["limit"])
        requested_before.append(before)
        eligible = [
            candle
            for candle in source
            if datetime.fromisoformat(candle["timestamp"]) <= before
        ]
        page = eligible[-limit:]
        return httpx.Response(
            200,
            json={
                "instrument": "EURUSD",
                "timeframe": "H1",
                "source": "broker",
                "count": len(page),
                "candles": page,
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    output = tmp_path / "EURUSD_H1.csv"
    result = collect_historical_corpus(
        api_base_url="https://api.example.test/api/v1",
        internal_api_key="test-internal-key",
        user_id="00000000-0000-0000-0000-000000000001",
        broker_connection_id="00000000-0000-0000-0000-000000000002",
        instrument="EURUSD",
        timeframe="H1",
        target_rows=300,
        page_size=200,
        output_path=output,
        client=client,
        now=datetime(2026, 2, 1, tzinfo=UTC),
    )

    frame = pd.read_csv(output)
    assert len(frame) == 300
    assert frame["timestamp"].is_unique
    assert result["row_count"] == 300
    assert result["pages_fetched"] == 2
    assert result["closed_candles_only"] is True
    assert result["source_account_fingerprint"]
    assert "broker_connection_id" not in result
    assert Path(result["manifest_path"]).is_file()
    manifest_text = Path(result["manifest_path"]).read_text(encoding="utf-8")
    assert "00000000-0000-0000-0000-000000000001" not in manifest_text
    assert "00000000-0000-0000-0000-000000000002" not in manifest_text
    assert requested_before[1] < requested_before[0]


def test_collect_historical_corpus_rejects_non_progressing_history(tmp_path: Path):
    candle = {
        "timestamp": "2026-01-01T00:00:00+00:00",
        "open": "1.1000",
        "high": "1.1010",
        "low": "1.0990",
        "close": "1.1005",
        "volume": "1000",
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "instrument": "EURUSD",
                "timeframe": "H1",
                "source": "broker",
                "count": 1,
                "candles": [candle],
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    output = tmp_path / "EURUSD_H1.csv"

    try:
        collect_historical_corpus(
            api_base_url="https://api.example.test/api/v1",
            internal_api_key="test-internal-key",
            user_id="00000000-0000-0000-0000-000000000001",
            broker_connection_id="00000000-0000-0000-0000-000000000002",
            instrument="EURUSD",
            timeframe="H1",
            target_rows=250,
            output_path=output,
            client=client,
            now=datetime(2026, 2, 1, tzinfo=UTC),
        )
    except ValueError as exc:
        assert "yielded only 1 closed candles" in str(exc)
    else:
        raise AssertionError("Expected insufficient historical corpus error")
