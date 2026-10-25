from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import pandas as pd

from app.domain.training.broker_native_prospective import (
    PAIRS,
    build_prospective_pair_frame,
    evaluate_fixed_base_prospective,
)

DEFAULT_DEVELOPMENT_ROOT = Path(
    "/home/lightworld/research/irexpro-broker-native-micro-v1-25k-frozen"
)
DEFAULT_HOLDOUT_ROOT = Path(
    "/home/lightworld/research/irexpro-broker-native-prospective-holdout-v1"
)
DEFAULT_CUTOFF = "2026-10-02T21:00:00Z"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development-root", type=Path, default=DEFAULT_DEVELOPMENT_ROOT)
    parser.add_argument("--holdout-root", type=Path, default=DEFAULT_HOLDOUT_ROOT)
    parser.add_argument("--cutoff", default=DEFAULT_CUTOFF)
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("services/ai-engine/reports/broker-native-v84-base-h5-prospective-v1.json"),
    )
    args = parser.parse_args()

    cutoff = pd.Timestamp(args.cutoff)
    development_frames: list[pd.DataFrame] = []
    holdout_frames: list[pd.DataFrame] = []
    pair_evidence: dict[str, dict[str, object]] = {}

    for pair in PAIRS:
        development_path = args.development_root / f"{pair}_M1.csv"
        holdout_path = args.holdout_root / f"{pair}_M1.csv"
        development_raw = pd.read_csv(development_path)
        holdout_raw = pd.read_csv(holdout_path)
        prepared = build_prospective_pair_frame(
            development_raw,
            holdout_raw,
            pair=pair,
            cutoff=cutoff,
            horizon_bars=5,
            lookback_bars=60,
        )
        development = prepared["development"].copy()
        holdout = prepared["holdout"].copy()
        development["pair"] = pair
        holdout["pair"] = pair
        development_frames.append(development)
        holdout_frames.append(holdout)
        pair_evidence[pair] = {
            "development_source_rows": int(len(development_raw)),
            "development_model_rows": int(len(development)),
            "holdout_source_rows": int(len(holdout_raw)),
            "holdout_scorable_rows": int(len(holdout)),
            "development_sha256": file_sha256(development_path),
            "holdout_sha256": file_sha256(holdout_path),
            "holdout_start": (
                pd.Timestamp(holdout["timestamp"].min()).isoformat() if not holdout.empty else None
            ),
            "holdout_end": (
                pd.Timestamp(holdout["timestamp"].max()).isoformat() if not holdout.empty else None
            ),
        }
        print(
            f"prepared pair={pair} development={len(development)} holdout={len(holdout)}",
            flush=True,
        )

    pooled_development = pd.concat(development_frames, ignore_index=True).sort_values(
        ["timestamp", "pair"]
    )
    pooled_holdout = pd.concat(holdout_frames, ignore_index=True).sort_values(
        ["timestamp", "pair"]
    )
    holdout_manifest = args.holdout_root / "manifest.json"
    report = evaluate_fixed_base_prospective(
        pooled_development,
        pooled_holdout,
        development_cutoff=cutoff.isoformat(),
        holdout_manifest_sha256=file_sha256(holdout_manifest),
        horizon_bars=5,
        min_calibration_timestamps=500,
    )
    report.update(
        {
            "development_manifest_sha256": file_sha256(args.development_root / "manifest.json"),
            "pair_evidence": pair_evidence,
            "development_rows": int(len(pooled_development)),
            "holdout_scorable_rows": int(len(pooled_holdout)),
            "sealed_prior_future_holdouts_used_for_selection": False,
            "research_only": True,
        }
    )

    args.report.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.report.with_suffix(args.report.suffix + ".tmp")
    temporary.write_text(json.dumps(report, indent=2, default=str) + "\n", encoding="utf-8")
    os.replace(temporary, args.report)
    args.report.with_suffix(args.report.suffix + ".sha256").write_text(
        file_sha256(args.report) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "report": str(args.report),
                "economic_screen_passed": report["economic_screen_passed"],
                "metrics": report["metrics"],
                "holdout_stability": report["holdout_stability"],
                "participation": report["participation"],
                "next_action": report["next_action"],
            },
            indent=2,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
