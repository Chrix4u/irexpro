from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.domain.training.cross_pair_relative_value import (
    PAIRS,
    evaluate_relative_value_corpora,
)

DEFAULT_CUTOFF = "2026-09-22T18:23:05.100429+00:00"


def _dataset_mapping(values: list[str]) -> dict[str, Path]:
    mapping: dict[str, Path] = {}
    for value in values:
        if "=" not in value:
            raise ValueError("--dataset must use PAIR=/absolute/path form")
        pair, raw_path = value.split("=", 1)
        pair = pair.strip().upper()
        if pair not in PAIRS:
            raise ValueError(f"unsupported pair in --dataset: {pair}")
        if pair in mapping:
            raise ValueError(f"duplicate --dataset pair: {pair}")
        mapping[pair] = Path(raw_path).expanduser().resolve()
    missing = sorted(set(PAIRS).difference(mapping))
    extra = sorted(set(mapping).difference(PAIRS))
    if missing or extra:
        raise ValueError(f"exact six-pair dataset mapping required; missing={missing} extra={extra}")
    return mapping


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run the research-only cross-pair relative-value v1 horizon-1 screen."
    )
    parser.add_argument(
        "--dataset",
        action="append",
        default=[],
        help="Repeat exactly six times as PAIR=/absolute/path/to/corpus.parquet",
    )
    parser.add_argument("--decision-time-before", default=DEFAULT_CUTOFF)
    parser.add_argument(
        "--report",
        type=Path,
        required=True,
        help="Atomic JSON report destination.",
    )
    parser.add_argument("--min-train-periods", type=int, default=None)
    parser.add_argument("--validation-periods", type=int, default=7200)
    parser.add_argument("--rolling-window", type=int, default=60)
    parser.add_argument("--calibration-min-periods", type=int, default=200)
    parser.add_argument("--calibration-min-rows", type=int, default=200)
    parser.add_argument("--commission-bps", type=float, default=0.0)
    parser.add_argument("--slippage-bps", type=float, default=0.0)
    args = parser.parse_args()

    report = evaluate_relative_value_corpora(
        _dataset_mapping(args.dataset),
        report_path=args.report,
        decision_time_before=args.decision_time_before,
        min_train_periods=args.min_train_periods,
        validation_periods=args.validation_periods,
        max_splits=1,
        rolling_window=args.rolling_window,
        calibration_min_periods=args.calibration_min_periods,
        calibration_min_rows=args.calibration_min_rows,
        commission_bps=args.commission_bps,
        slippage_bps=args.slippage_bps,
    )
    print(
        json.dumps(
            {
                "report": report["report_path"],
                "candidate": report["candidate"],
                "research_gate_passed": report["research_gate_passed"],
                "trading": report["trading"],
                "participation": report["participation"],
                "robustness": report["robustness"],
                "approved_for_paper": report["approved_for_paper"],
                "approved_for_demo": report["approved_for_demo"],
                "approved_for_live": report["approved_for_live"],
            },
            indent=2,
            default=str,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
