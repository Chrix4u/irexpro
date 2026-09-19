"""Collect a reproducible historical OHLCV corpus from iRexPro's internal broker API."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pandas as pd

from app.domain.training.dataset_builder import load_ohlcv_csv

TIMEFRAME_SECONDS = {
    "M1": 60,
    "M5": 5 * 60,
    "M15": 15 * 60,
    "M30": 30 * 60,
    "H1": 60 * 60,
    "H4": 4 * 60 * 60,
    "D1": 24 * 60 * 60,
}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _parse_candles(payload: dict[str, Any]) -> list[dict[str, Any]]:
    candles = payload.get("candles")
    if not isinstance(candles, list):
        raise ValueError("Market-data response is missing candles")
    rows: list[dict[str, Any]] = []
    for candle in candles:
        if not isinstance(candle, dict):
            continue
        rows.append(
            {
                "timestamp": candle.get("timestamp"),
                "open": candle.get("open"),
                "high": candle.get("high"),
                "low": candle.get("low"),
                "close": candle.get("close"),
                "volume": candle.get("volume"),
            }
        )
    return rows


def _closed_candle_cutoff(timeframe: str, now: datetime) -> datetime:
    seconds = TIMEFRAME_SECONDS.get(timeframe.upper())
    if seconds is None:
        raise ValueError(f"Unsupported timeframe for corpus collection: {timeframe}")
    return now - timedelta(seconds=seconds)


def collect_historical_corpus(
    *,
    api_base_url: str,
    internal_api_key: str,
    user_id: str,
    broker_connection_id: str,
    instrument: str,
    timeframe: str,
    target_rows: int,
    output_path: str | Path,
    before: datetime | None = None,
    page_size: int = 500,
    client: httpx.Client | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Page backwards through broker history and persist a validated CSV + manifest."""
    if target_rows < 250:
        raise ValueError("target_rows must be at least 250")
    if not 10 <= page_size <= 500:
        raise ValueError("page_size must be between 10 and 500")
    if not internal_api_key.strip():
        raise ValueError("internal_api_key is required")

    owned_client = client is None
    http = client or httpx.Client(timeout=30.0)
    cursor = before or datetime.now(UTC)
    observed_now = now or datetime.now(UTC)
    closed_cutoff = _closed_candle_cutoff(timeframe, observed_now)
    rows_by_timestamp: dict[str, dict[str, Any]] = {}
    pages = 0

    try:
        while len(rows_by_timestamp) < target_rows:
            response = http.get(
                f"{api_base_url.rstrip('/')}/market-data/internal/ohlcv",
                params={
                    "userId": user_id,
                    "brokerConnectionId": broker_connection_id,
                    "instrument": instrument.upper(),
                    "timeframe": timeframe.upper(),
                    "limit": page_size,
                    "before": cursor.isoformat(),
                },
                headers={"x-irexpro-internal-api-key": internal_api_key},
            )
            response.raise_for_status()
            page = _parse_candles(response.json())
            pages += 1
            if not page:
                break

            timestamps: list[datetime] = []
            new_rows = 0
            for row in page:
                parsed = pd.to_datetime(row["timestamp"], utc=True, errors="coerce")
                if pd.isna(parsed):
                    continue
                timestamp = parsed.to_pydatetime()
                timestamps.append(timestamp)
                if timestamp > closed_cutoff:
                    continue
                key = timestamp.isoformat()
                if key not in rows_by_timestamp:
                    rows_by_timestamp[key] = {
                        **row,
                        "timestamp": timestamp.isoformat(),
                    }
                    new_rows += 1

            if not timestamps:
                break

            oldest = min(timestamps)
            next_cursor = oldest - timedelta(milliseconds=1)
            if next_cursor >= cursor or new_rows == 0:
                break
            cursor = next_cursor

        if len(rows_by_timestamp) < target_rows:
            raise ValueError(
                f"Historical source yielded only {len(rows_by_timestamp)} closed candles; "
                f"{target_rows} requested"
            )

        ordered = sorted(
            rows_by_timestamp.values(),
            key=lambda row: pd.Timestamp(row["timestamp"]),
        )[-target_rows:]

        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        pd.DataFrame(ordered).to_csv(output, index=False)
        validated = load_ohlcv_csv(output)

        manifest = {
            "manifest_version": 1,
            "instrument": instrument.upper(),
            "timeframe": timeframe.upper(),
            "source": "irexpro_internal_broker_ohlcv",
            "broker_connection_id": broker_connection_id,
            "row_count": len(validated),
            "pages_fetched": pages,
            "start": validated["timestamp"].iloc[0].isoformat(),
            "end": validated["timestamp"].iloc[-1].isoformat(),
            "collected_at": observed_now.isoformat(),
            "dataset_sha256": _sha256_file(output),
            "closed_candles_only": True,
        }
        manifest_path = output.with_suffix(".manifest.json")
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
        return {**manifest, "dataset_path": str(output), "manifest_path": str(manifest_path)}
    finally:
        if owned_client:
            http.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect historical broker OHLCV for XGBoost")
    parser.add_argument("--api-base-url", required=True)
    parser.add_argument(
        "--internal-api-key",
        default=os.getenv("NESTJS_INTERNAL_API_KEY", ""),
        help="Internal API key; defaults to NESTJS_INTERNAL_API_KEY env var",
    )
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--broker-connection-id", required=True)
    parser.add_argument("--instrument", required=True)
    parser.add_argument("--timeframe", default="H1")
    parser.add_argument("--target-rows", type=int, default=10000)
    parser.add_argument("--output", required=True)
    parser.add_argument("--before")
    args = parser.parse_args()

    before = datetime.fromisoformat(args.before.replace("Z", "+00:00")) if args.before else None
    result = collect_historical_corpus(
        api_base_url=args.api_base_url,
        internal_api_key=args.internal_api_key,
        user_id=args.user_id,
        broker_connection_id=args.broker_connection_id,
        instrument=args.instrument,
        timeframe=args.timeframe,
        target_rows=args.target_rows,
        output_path=args.output,
        before=before,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
