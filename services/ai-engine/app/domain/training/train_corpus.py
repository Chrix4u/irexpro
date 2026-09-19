"""Batch-train per-instrument XGBoost candidates from a verified corpus directory."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.domain.training.train_xgboost import train_offline


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _safe_bundle_name(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._")
    while ".." in safe:
        safe = safe.replace("..", "_")
    if not safe:
        raise ValueError("bundle name must contain at least one safe character")
    return safe


def _load_corpus_manifest(dataset_path: Path) -> dict[str, Any]:
    manifest_path = dataset_path.with_suffix(".manifest.json")
    if not manifest_path.is_file():
        raise ValueError(f"Corpus manifest missing for {dataset_path.name}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected_sha = str(manifest.get("dataset_sha256", "")).lower()
    actual_sha = _sha256_file(dataset_path)
    if not expected_sha or expected_sha != actual_sha:
        raise ValueError(f"Corpus checksum mismatch for {dataset_path.name}")
    if manifest.get("source") != "broker_internal_historical_ohlcv":
        raise ValueError(f"Corpus is not broker-authoritative: {dataset_path.name}")
    if manifest.get("closed_candles_only") is not True:
        raise ValueError(f"Corpus is not declared closed-candle-only: {dataset_path.name}")
    return manifest


def _discover_datasets(corpus_dir: Path, timeframe: str) -> list[tuple[Path, dict[str, Any]]]:
    timeframe = timeframe.upper()
    discovered: list[tuple[Path, dict[str, Any]]] = []
    for dataset_path in sorted(corpus_dir.glob(f"*_{timeframe}.csv")):
        manifest = _load_corpus_manifest(dataset_path)
        instrument = str(manifest.get("instrument", "")).upper()
        manifest_timeframe = str(manifest.get("timeframe", "")).upper()
        if not instrument or manifest_timeframe != timeframe:
            raise ValueError(f"Corpus manifest route mismatch for {dataset_path.name}")
        discovered.append((dataset_path, manifest))

    if not discovered:
        raise ValueError(f"No verified *_{timeframe}.csv corpora found in {corpus_dir}")
    return discovered


def train_corpus_bundle(
    *,
    corpus_dir: str | Path,
    output_dir: str | Path,
    bundle_name: str,
    timeframe: str = "H1",
    horizon_bars: int = 3,
    neutral_return_threshold: float = 0.0002,
    train_ratio: float = 0.8,
    approve_for_paper: bool = False,
    min_samples: int = 250,
) -> dict[str, Any]:
    """
    Train one XGBoost candidate per verified instrument/timeframe corpus.

    Bundle creation never grants live approval. Paper approval is explicit and
    applies to every artifact in this batch only when approve_for_paper=True.
    """
    corpus_root = Path(corpus_dir)
    output_root = Path(output_dir)
    output_root.mkdir(parents=True, exist_ok=True)

    safe_bundle = _safe_bundle_name(bundle_name)
    routes: list[dict[str, Any]] = []

    for dataset_path, corpus_manifest in _discover_datasets(corpus_root, timeframe):
        instrument = str(corpus_manifest["instrument"]).upper()
        model_version = f"xgboost-{instrument.lower()}-{timeframe.lower()}-{safe_bundle}"
        result = train_offline(
            str(dataset_path),
            model_version,
            instrument=instrument,
            timeframe=timeframe,
            horizon_bars=horizon_bars,
            neutral_return_threshold=neutral_return_threshold,
            train_ratio=train_ratio,
            output_dir=output_root,
            training_data_source="broker_internal_historical_ohlcv",
            approve_for_paper=approve_for_paper,
            min_samples=min_samples,
        )

        artifact_path = Path(result["artifact_path"])
        metadata_path = Path(result["metadata_path"])
        routes.append(
            {
                "instrument": instrument,
                "timeframe": timeframe.upper(),
                "model_version": model_version,
                "artifact_path": artifact_path.name,
                "metadata_path": metadata_path.name,
                "artifact_sha256": result["artifact_sha256"],
                "dataset_sha256": result["dataset_sha256"],
                "validation_metrics": result["metrics"],
                "approved_for_paper": bool(result["approved_for_paper"]),
                "approved_for_live": False,
            }
        )

    bundle = {
        "bundle_version": 1,
        "bundle_name": safe_bundle,
        "created_at": datetime.now(UTC).isoformat(),
        "timeframe": timeframe.upper(),
        "approved_for_paper": bool(approve_for_paper),
        "approved_for_live": False,
        "models": routes,
    }
    bundle_path = output_root / f"{safe_bundle}.bundle.json"
    bundle_path.write_text(json.dumps(bundle, indent=2, sort_keys=True), encoding="utf-8")

    return {
        **bundle,
        "bundle_path": str(bundle_path),
        "model_count": len(routes),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Train one verified XGBoost candidate per corpus instrument"
    )
    parser.add_argument("--corpus-dir", default="data/corpus")
    parser.add_argument("--output-dir", default="models")
    parser.add_argument("--bundle-name", required=True)
    parser.add_argument("--timeframe", default="H1")
    parser.add_argument("--horizon-bars", type=int, default=3)
    parser.add_argument("--neutral-return-threshold", type=float, default=0.0002)
    parser.add_argument("--train-ratio", type=float, default=0.8)
    parser.add_argument("--min-samples", type=int, default=250)
    parser.add_argument(
        "--approve-for-paper",
        action="store_true",
        help="Explicitly mark every trained candidate in this bundle paper-eligible",
    )
    args = parser.parse_args()

    report = train_corpus_bundle(
        corpus_dir=args.corpus_dir,
        output_dir=args.output_dir,
        bundle_name=args.bundle_name,
        timeframe=args.timeframe,
        horizon_bars=args.horizon_bars,
        neutral_return_threshold=args.neutral_return_threshold,
        train_ratio=args.train_ratio,
        approve_for_paper=args.approve_for_paper,
        min_samples=args.min_samples,
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
