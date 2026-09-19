"""Collect a reproducible multi-instrument historical OHLCV corpus set."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

import httpx

from app.domain.training.collect_historical import collect_historical_corpus

DEFAULT_H1_INSTRUMENTS = (
    "EURUSD",
    "GBPUSD",
    "USDJPY",
    "AUDUSD",
    "USDCAD",
    "USDCHF",
)


def _canonical_sha256(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def normalize_instruments(instruments: Iterable[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in instruments:
        instrument = raw.strip().upper()
        if not instrument or instrument in seen:
            continue
        if not instrument.isalnum():
            raise ValueError(f"Invalid instrument code: {raw!r}")
        seen.add(instrument)
        normalized.append(instrument)
    if not normalized:
        raise ValueError("At least one instrument is required")
    return normalized


def collect_corpus_set(
    *,
    api_base_url: str,
    internal_api_key: str,
    user_id: str,
    broker_connection_id: str,
    instruments: Iterable[str] = DEFAULT_H1_INSTRUMENTS,
    timeframe: str = "H1",
    target_rows_per_instrument: int = 10000,
    output_dir: str | Path = "data/corpus",
    page_size: int = 500,
    client: httpx.Client | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """
    Collect all required instrument datasets against one shared cutoff.

    The top-level set manifest is written only after every instrument succeeds,
    so its presence is the completion marker for a training corpus set.
    """
    selected = normalize_instruments(instruments)
    observed_now = now or datetime.now(UTC)
    if observed_now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    if not internal_api_key.strip():
        raise ValueError("internal_api_key is required")

    destination = Path(output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    manifest_path = destination / "corpus-set.manifest.json"
    # The manifest is the completion marker. Remove any previous marker before
    # starting so a failed refresh cannot leave a stale "complete" corpus.
    manifest_path.unlink(missing_ok=True)

    owned_client = client is None
    http = client or httpx.Client(timeout=30.0)
    members: list[dict[str, Any]] = []

    try:
        for instrument in selected:
            dataset_path = destination / f"{instrument}_{timeframe.upper()}.csv"
            result = collect_historical_corpus(
                api_base_url=api_base_url,
                internal_api_key=internal_api_key,
                user_id=user_id,
                broker_connection_id=broker_connection_id,
                instrument=instrument,
                timeframe=timeframe,
                target_rows=target_rows_per_instrument,
                output_path=dataset_path,
                before=observed_now,
                page_size=page_size,
                client=http,
                now=observed_now,
            )
            members.append(
                {
                    "instrument": result["instrument"],
                    "timeframe": result["timeframe"],
                    "row_count": result["row_count"],
                    "start": result["start"],
                    "end": result["end"],
                    "dataset_sha256": result["dataset_sha256"],
                    "dataset_path": result["dataset_path"],
                    "manifest_path": result["manifest_path"],
                    "source_account_fingerprint": result["source_account_fingerprint"],
                    "closed_candles_only": result["closed_candles_only"],
                }
            )
    finally:
        if owned_client:
            http.close()

    expected = set(selected)
    completed = {str(member["instrument"]) for member in members}
    if completed != expected:
        missing = sorted(expected - completed)
        raise ValueError(f"Corpus set incomplete; missing instruments: {missing}")

    source_fingerprints = {
        str(member["source_account_fingerprint"])
        for member in members
    }
    if len(source_fingerprints) != 1:
        raise ValueError("Corpus members do not share the same broker-account fingerprint")

    fingerprint_payload = {
        "manifest_version": 1,
        "timeframe": timeframe.upper(),
        "target_rows_per_instrument": target_rows_per_instrument,
        "cutoff": observed_now.isoformat(),
        "members": [
            {
                "instrument": member["instrument"],
                "dataset_sha256": member["dataset_sha256"],
                "row_count": member["row_count"],
                "start": member["start"],
                "end": member["end"],
            }
            for member in sorted(members, key=lambda item: str(item["instrument"]))
        ],
    }
    corpus_set_sha256 = _canonical_sha256(fingerprint_payload)
    corpus_set_id = f"{timeframe.lower()}-{corpus_set_sha256[:16]}"
    total_row_count = sum(int(member["row_count"]) for member in members)

    manifest = {
        "manifest_version": 1,
        "corpus_type": "multi_instrument_ohlcv",
        "corpus_set_id": corpus_set_id,
        "source": "irexpro_internal_broker_ohlcv",
        "timeframe": timeframe.upper(),
        "instruments": selected,
        "instrument_count": len(selected),
        "target_rows_per_instrument": target_rows_per_instrument,
        "total_row_count": total_row_count,
        "cutoff": observed_now.isoformat(),
        "collected_at": observed_now.isoformat(),
        "source_account_fingerprint": next(iter(source_fingerprints)),
        "complete": True,
        "members": members,
        "corpus_set_sha256": corpus_set_sha256,
    }

    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return {**manifest, "manifest_path": str(manifest_path)}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Collect a multi-instrument broker OHLCV training corpus"
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
        default=",".join(DEFAULT_H1_INSTRUMENTS),
        help="Comma-separated instrument codes",
    )
    parser.add_argument("--timeframe", default="H1")
    parser.add_argument("--target-rows-per-instrument", type=int, default=10000)
    parser.add_argument("--page-size", type=int, default=500)
    parser.add_argument("--output-dir", default="data/corpus")
    args = parser.parse_args()

    result = collect_corpus_set(
        api_base_url=args.api_base_url,
        internal_api_key=args.internal_api_key,
        user_id=args.user_id,
        broker_connection_id=args.broker_connection_id,
        instruments=args.instruments.split(","),
        timeframe=args.timeframe,
        target_rows_per_instrument=args.target_rows_per_instrument,
        page_size=args.page_size,
        output_dir=args.output_dir,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
