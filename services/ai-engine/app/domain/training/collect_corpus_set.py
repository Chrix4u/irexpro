"""Collect a reproducible multi-instrument OHLCV corpus set."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.domain.training.collect_historical import collect_historical_corpus

DEFAULT_INSTRUMENTS = [
    "EURUSD",
    "GBPUSD",
    "USDJPY",
    "AUDUSD",
    "USDCAD",
    "USDCHF",
]


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def collect_corpus_set(
    *,
    api_base_url: str,
    internal_api_key: str,
    user_id: str,
    broker_connection_id: str,
    instruments: list[str],
    timeframe: str,
    target_rows: int,
    output_dir: str | Path,
    before: datetime | None = None,
) -> dict[str, Any]:
    """Collect all requested instruments using one common historical cutoff."""
    if not instruments:
        raise ValueError("At least one instrument is required")

    normalized = [instrument.strip().upper() for instrument in instruments if instrument.strip()]
    if not normalized:
        raise ValueError("At least one non-empty instrument is required")
    if len(set(normalized)) != len(normalized):
        raise ValueError("Duplicate instruments are not allowed")

    corpus_cutoff = before or datetime.now(UTC)
    root = Path(output_dir)
    root.mkdir(parents=True, exist_ok=True)

    datasets: list[dict[str, Any]] = []
    for instrument in normalized:
        output_path = root / f"{instrument}_{timeframe.upper()}.csv"
        result = collect_historical_corpus(
            api_base_url=api_base_url,
            internal_api_key=internal_api_key,
            user_id=user_id,
            broker_connection_id=broker_connection_id,
            instrument=instrument,
            timeframe=timeframe,
            target_rows=target_rows,
            output_path=output_path,
            before=corpus_cutoff,
            now=corpus_cutoff,
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
            }
        )

    if len(datasets) != len(normalized):
        raise ValueError("Corpus set is incomplete")

    digest_material = "\n".join(
        f'{item["instrument"]}:{item["dataset_sha256"]}'
        for item in sorted(datasets, key=lambda item: item["instrument"])
    )

    manifest = {
        "manifest_version": 1,
        "type": "irexpro_multi_instrument_ohlcv_corpus",
        "source": "irexpro_internal_broker_ohlcv",
        "source_account_fingerprint": _sha256_text(f"{user_id}:{broker_connection_id}"),
        "timeframe": timeframe.upper(),
        "target_rows_per_instrument": target_rows,
        "instrument_count": len(datasets),
        "instruments": normalized,
        "common_cutoff": corpus_cutoff.isoformat(),
        "overall_start": min(item["start"] for item in datasets),
        "overall_end": max(item["end"] for item in datasets),
        "datasets": datasets,
        "corpus_set_sha256": _sha256_text(digest_material),
    }

    manifest_path = root / f"corpus_{timeframe.upper()}_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return {**manifest, "manifest_path": str(manifest_path)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect multi-pair historical OHLCV corpus")
    parser.add_argument("--api-base-url", required=True)
    parser.add_argument(
        "--internal-api-key",
        default=os.getenv("NESTJS_INTERNAL_API_KEY", ""),
        help="Internal API key; defaults to NESTJS_INTERNAL_API_KEY",
    )
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--broker-connection-id", required=True)
    parser.add_argument("--instruments", nargs="+", default=DEFAULT_INSTRUMENTS)
    parser.add_argument("--timeframe", default="H1")
    parser.add_argument("--target-rows", type=int, default=10000)
    parser.add_argument("--output-dir", default="data/historical")
    parser.add_argument("--before")
    args = parser.parse_args()

    before = datetime.fromisoformat(args.before.replace("Z", "+00:00")) if args.before else None
    result = collect_corpus_set(
        api_base_url=args.api_base_url,
        internal_api_key=args.internal_api_key,
        user_id=args.user_id,
        broker_connection_id=args.broker_connection_id,
        instruments=args.instruments,
        timeframe=args.timeframe,
        target_rows=args.target_rows,
        output_dir=args.output_dir,
        before=before,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
