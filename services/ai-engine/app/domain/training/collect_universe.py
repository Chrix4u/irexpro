"""Collect the broker-backed FX training universe used by iRexPro model research."""
from __future__ import annotations

import argparse
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from app.domain.training.collect_historical import collect_historical_corpus

DEFAULT_FX_UNIVERSE = (
    "EURUSD",
    "GBPUSD",
    "USDJPY",
    "AUDUSD",
    "USDCAD",
    "USDCHF",
)


def collect_training_universe(
    *,
    api_base_url: str,
    internal_api_key: str,
    user_id: str,
    broker_connection_id: str,
    output_dir: str | Path,
    instruments: tuple[str, ...] = DEFAULT_FX_UNIVERSE,
    timeframe: str = "H1",
    target_rows_per_instrument: int = 10_000,
    page_size: int = 500,
    before: datetime | None = None,
    client: httpx.Client | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """
    Collect one reproducible historical dataset per instrument.

    All instruments share the same collection cutoff so cross-instrument
    research does not accidentally compare datasets collected at materially
    different points in time.
    """
    normalized = tuple(dict.fromkeys(value.strip().upper() for value in instruments if value.strip()))
    if not normalized:
        raise ValueError("At least one instrument is required")
    if len(normalized) > 32:
        raise ValueError("Training universe is unexpectedly large")
    if target_rows_per_instrument < 250:
        raise ValueError("target_rows_per_instrument must be at least 250")

    observed_now = now or datetime.now(UTC)
    common_before = before or observed_now
    root = Path(output_dir)
    root.mkdir(parents=True, exist_ok=True)

    owned_client = client is None
    http = client or httpx.Client(timeout=30.0)
    datasets: list[dict[str, Any]] = []

    try:
        for instrument in normalized:
            output_path = root / f"{instrument}_{timeframe.upper()}.csv"
            result = collect_historical_corpus(
                api_base_url=api_base_url,
                internal_api_key=internal_api_key,
                user_id=user_id,
                broker_connection_id=broker_connection_id,
                instrument=instrument,
                timeframe=timeframe,
                target_rows=target_rows_per_instrument,
                page_size=page_size,
                output_path=output_path,
                before=common_before,
                client=http,
                now=observed_now,
            )
            datasets.append(
                {
                    "instrument": result["instrument"],
                    "timeframe": result["timeframe"],
                    "row_count": result["row_count"],
                    "start": result["start"],
                    "end": result["end"],
                    "dataset_sha256": result["dataset_sha256"],
                    "dataset_path": result["dataset_path"],
                    "manifest_path": result["manifest_path"],
                    "pages_fetched": result["pages_fetched"],
                    "closed_candles_only": result["closed_candles_only"],
                }
            )
    finally:
        if owned_client:
            http.close()

    manifest = {
        "manifest_version": 1,
        "source": "irexpro_internal_broker_ohlcv",
        "timeframe": timeframe.upper(),
        "common_before": common_before.isoformat(),
        "collected_at": observed_now.isoformat(),
        "target_rows_per_instrument": target_rows_per_instrument,
        "instrument_count": len(datasets),
        "instruments": list(normalized),
        "datasets": datasets,
    }
    manifest_path = root / f"training_universe_{timeframe.upper()}.manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return {**manifest, "manifest_path": str(manifest_path)}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Collect the iRexPro multi-instrument historical training universe"
    )
    parser.add_argument("--api-base-url", required=True)
    parser.add_argument(
        "--internal-api-key",
        default=os.getenv("NESTJS_INTERNAL_API_KEY", ""),
        help="Internal API key; defaults to NESTJS_INTERNAL_API_KEY env var",
    )
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--broker-connection-id", required=True)
    parser.add_argument(
        "--instruments",
        default=",".join(DEFAULT_FX_UNIVERSE),
        help="Comma-separated symbols",
    )
    parser.add_argument("--timeframe", default="H1")
    parser.add_argument("--target-rows-per-instrument", type=int, default=10_000)
    parser.add_argument("--page-size", type=int, default=500)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--before")
    args = parser.parse_args()

    before = (
        datetime.fromisoformat(args.before.replace("Z", "+00:00"))
        if args.before
        else None
    )
    result = collect_training_universe(
        api_base_url=args.api_base_url,
        internal_api_key=args.internal_api_key,
        user_id=args.user_id,
        broker_connection_id=args.broker_connection_id,
        instruments=tuple(args.instruments.split(",")),
        timeframe=args.timeframe,
        target_rows_per_instrument=args.target_rows_per_instrument,
        page_size=args.page_size,
        output_dir=args.output_dir,
        before=before,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
