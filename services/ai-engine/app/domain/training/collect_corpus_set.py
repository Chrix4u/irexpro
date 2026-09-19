"""Collect a reproducible multi-instrument historical OHLCV corpus set."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

import httpx

from app.domain.training.collect_historical import collect_historical_corpus

DEFAULT_INSTRUMENTS = (
    "EURUSD",
    "GBPUSD",
    "USDJPY",
    "AUDUSD",
    "USDCAD",
    "USDCHF",
)

Collector = Callable[..., dict[str, Any]]


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def collect_historical_corpus_set(
    *,
    api_base_url: str,
    internal_api_key: str,
    user_id: str,
    broker_connection_id: str,
    output_dir: str | Path,
    instruments: tuple[str, ...] = DEFAULT_INSTRUMENTS,
    timeframe: str = "H1",
    target_rows_per_instrument: int = 10000,
    page_size: int = 500,
    before: datetime | None = None,
    client: httpx.Client | None = None,
    collector: Collector = collect_historical_corpus,
    collected_at: datetime | None = None,
) -> dict[str, Any]:
    """
    Collect all requested instruments against one common historical cut-off.

    The function fails closed: every requested instrument must yield exactly
    target_rows_per_instrument validated closed candles before the set manifest
    is written.
    """
    if not instruments:
        raise ValueError("At least one instrument is required")
    normalized = tuple(dict.fromkeys(i.strip().upper() for i in instruments if i.strip()))
    if len(normalized) != len(instruments):
        raise ValueError("Instrument list contains blanks or duplicates")
    if target_rows_per_instrument < 250:
        raise ValueError("target_rows_per_instrument must be at least 250")
    if not 10 <= page_size <= 500:
        raise ValueError("page_size must be between 10 and 500")
    if not internal_api_key.strip():
        raise ValueError("internal_api_key is required")

    observed_at = collected_at or datetime.now(UTC)
    common_before = before or observed_at
    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)

    datasets: dict[str, dict[str, Any]] = {}
    total_rows = 0

    for instrument in normalized:
        output_path = destination / f"{instrument}_{timeframe.upper()}.csv"
        result = collector(
            api_base_url=api_base_url,
            internal_api_key=internal_api_key,
            user_id=user_id,
            broker_connection_id=broker_connection_id,
            instrument=instrument,
            timeframe=timeframe,
            target_rows=target_rows_per_instrument,
            output_path=output_path,
            before=common_before,
            page_size=page_size,
            client=client,
            now=observed_at,
        )

        row_count = int(result.get("row_count", 0))
        if row_count != target_rows_per_instrument:
            raise ValueError(
                f"{instrument} corpus incomplete: expected "
                f"{target_rows_per_instrument}, got {row_count}"
            )
        if str(result.get("instrument", "")).upper() != instrument:
            raise ValueError(f"{instrument} corpus returned mismatched instrument metadata")
        if str(result.get("timeframe", "")).upper() != timeframe.upper():
            raise ValueError(f"{instrument} corpus returned mismatched timeframe metadata")
        if not bool(result.get("closed_candles_only", False)):
            raise ValueError(f"{instrument} corpus is not closed-candle-only")

        dataset_record = {
            "dataset_path": result["dataset_path"],
            "manifest_path": result["manifest_path"],
            "dataset_sha256": result["dataset_sha256"],
            "row_count": row_count,
            "start": result["start"],
            "end": result["end"],
            "pages_fetched": result["pages_fetched"],
            "source_account_fingerprint": result["source_account_fingerprint"],
        }
        datasets[instrument] = dataset_record
        total_rows += row_count

    account_fingerprints = {
        record["source_account_fingerprint"] for record in datasets.values()
    }
    if len(account_fingerprints) != 1:
        raise ValueError("Corpus set contains inconsistent source-account provenance")

    set_identity_material = json.dumps(
        {
            "instruments": normalized,
            "timeframe": timeframe.upper(),
            "target_rows_per_instrument": target_rows_per_instrument,
            "common_before": common_before.isoformat(),
            "datasets": {
                instrument: datasets[instrument]["dataset_sha256"]
                for instrument in normalized
            },
        },
        sort_keys=True,
        separators=(",", ":"),
    )

    manifest = {
        "manifest_version": 1,
        "corpus_set_id": _sha256_text(set_identity_material),
        "source": "irexpro_internal_broker_ohlcv",
        "source_account_fingerprint": next(iter(account_fingerprints)),
        "timeframe": timeframe.upper(),
        "instruments": list(normalized),
        "instrument_count": len(normalized),
        "target_rows_per_instrument": target_rows_per_instrument,
        "total_rows": total_rows,
        "common_before": common_before.isoformat(),
        "collected_at": observed_at.isoformat(),
        "closed_candles_only": True,
        "datasets": datasets,
    }

    manifest_path = destination / "corpus-set.manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return {**manifest, "manifest_path": str(manifest_path)}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Collect the iRexPro multi-instrument historical training corpus"
    )
    parser.add_argument("--api-base-url", required=True)
    parser.add_argument(
        "--internal-api-key",
        default=os.getenv("NESTJS_INTERNAL_API_KEY", ""),
        help="Internal API key; defaults to NESTJS_INTERNAL_API_KEY env var",
    )
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--broker-connection-id", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--timeframe", default="H1")
    parser.add_argument("--target-rows-per-instrument", type=int, default=10000)
    parser.add_argument("--page-size", type=int, default=500)
    parser.add_argument(
        "--instruments",
        default=",".join(DEFAULT_INSTRUMENTS),
        help="Comma-separated symbols",
    )
    parser.add_argument("--before")
    args = parser.parse_args()

    instruments = tuple(
        symbol.strip().upper()
        for symbol in args.instruments.split(",")
        if symbol.strip()
    )
    before = (
        datetime.fromisoformat(args.before.replace("Z", "+00:00"))
        if args.before
        else None
    )
    result = collect_historical_corpus_set(
        api_base_url=args.api_base_url,
        internal_api_key=args.internal_api_key,
        user_id=args.user_id,
        broker_connection_id=args.broker_connection_id,
        output_dir=args.output_dir,
        instruments=instruments,
        timeframe=args.timeframe,
        target_rows_per_instrument=args.target_rows_per_instrument,
        page_size=args.page_size,
        before=before,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
