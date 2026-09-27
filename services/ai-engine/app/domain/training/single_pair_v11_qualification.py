"""USDJPY v11 qualification with nested training-only execution-gate selection."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import pandas as pd

from app.domain.training.model_qualification import (
    CONFIDENCE_FLOOR,
    EVENT_HYBRID_CALIBRATED_GATING_EXPERIMENT_NAME,
    EVENT_HYBRID_PAYOFF_RISK_EXPERIMENT_NAME,
    ModelVariant,
    QualificationExperiment,
    _qualification_checkpoint_fingerprint,
    run_nested_qualification_experiments,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora


def _frame_sha256(frame: pd.DataFrame) -> str:
    ordered = frame.copy()
    ordered["decision_time"] = pd.to_datetime(
        ordered["decision_time"], utc=True, errors="raise"
    ).map(lambda value: value.isoformat())
    ordered = ordered.sort_values(["decision_time", "instrument"]).reset_index(drop=True)
    ordered = ordered.reindex(sorted(ordered.columns), axis=1)
    payload = ordered.to_csv(index=False, float_format="%.12g", lineterminator="\n")
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def v11_experiments() -> tuple[QualificationExperiment, ...]:
    """Compare locked v10 with v11 using the exact same outer folds."""
    return (
        QualificationExperiment(
            name="baseline",
            variants=(ModelVariant(name="baseline_locked"),),
        ),
        QualificationExperiment(
            name=EVENT_HYBRID_CALIBRATED_GATING_EXPERIMENT_NAME,
            variants=(
                ModelVariant(
                    name="event_barrier_v11_hybrid_payoff_risk_calibrated_gating"
                ),
            ),
            mode="event_hybrid_dual_direction_payoff_risk_calibrated_gating",
        ),
    )


def evaluate_v11_candidate(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    decision_time_before: str | pd.Timestamp,
    report_path: str | Path,
    max_splits: int,
    reference_v10_report: str | Path | None = None,
    confidence_floor: float = CONFIDENCE_FLOOR,
) -> dict[str, Any]:
    if len(datasets) != 1:
        raise ValueError("v11 single-pair qualification requires exactly one dataset")
    if confidence_floor != CONFIDENCE_FLOOR:
        raise ValueError("v11 keeps direction confidence locked at 0.60")

    pooled, hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        decision_time_before=decision_time_before,
    )
    experiments = v11_experiments()
    fingerprint = _qualification_checkpoint_fingerprint(
        dataset_sha256=hashes,
        decision_time_before=decision_time_before,
        horizon_bars=horizon_bars,
        confidence_floor=confidence_floor,
        max_splits=max_splits,
        experiments=experiments,
    )

    output = Path(report_path)
    checkpoint_dir = output.parent / f"{output.stem}.checkpoints"
    report = run_nested_qualification_experiments(
        pooled,
        horizon_bars=horizon_bars,
        confidence_floor=confidence_floor,
        max_splits=max_splits,
        experiments=experiments,
        checkpoint_dir=checkpoint_dir,
        checkpoint_fingerprint=fingerprint,
    )
    report["dataset_sha256"] = hashes
    report["qualification_frame_sha256"] = _frame_sha256(pooled)
    report["qualification_frame_rows"] = int(len(pooled))
    report["qualification_checkpoint_fingerprint"] = fingerprint
    report["qualification_decision_time_before"] = pd.Timestamp(
        decision_time_before
    ).isoformat()
    report["single_pair_scope"] = {
        "instrument": next(iter(sorted(datasets))),
        "horizon_bars": int(horizon_bars),
        "candidate_experiment": EVENT_HYBRID_CALIBRATED_GATING_EXPERIMENT_NAME,
        "governance_baseline_experiment": "baseline",
        "reference_v10_experiment": EVENT_HYBRID_PAYOFF_RISK_EXPERIMENT_NAME,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
        "frozen_v10_holdout_unchanged": True,
    }

    if reference_v10_report is not None:
        reference_path = Path(reference_v10_report)
        reference = json.loads(reference_path.read_text(encoding="utf-8"))
        if reference.get("dataset_sha256") != hashes:
            raise ValueError("reference v10 report dataset hash does not match v11 corpus")
        reference_cutoff = pd.Timestamp(
            reference.get("qualification_decision_time_before")
        ).isoformat()
        requested_cutoff = pd.Timestamp(decision_time_before).isoformat()
        if reference_cutoff != requested_cutoff:
            raise ValueError("reference v10 report cutoff does not match v11 cutoff")
        v10 = (reference.get("experiments") or {}).get(
            EVENT_HYBRID_PAYOFF_RISK_EXPERIMENT_NAME
        )
        if not isinstance(v10, dict):
            raise ValueError("reference v10 report is missing the v10 experiment")
        report["reference_v10"] = {
            "path": str(reference_path),
            "qualification_frame_sha256": reference.get(
                "qualification_frame_sha256"
            ),
            "research_gate": v10.get("research_gate"),
            "active_trades": int((v10.get("overall") or {}).get("active_trades", 0)),
            "trading": (v10.get("overall") or {}).get("trading"),
        }

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    temporary.replace(output)
    return {**report, "report_path": str(output)}


def v11_summary(report: dict[str, Any]) -> dict[str, Any]:
    candidate = report["experiments"][EVENT_HYBRID_CALIBRATED_GATING_EXPERIMENT_NAME]
    baseline = report.get("reference_v10")
    return {
        "candidate": {
            "experiment": EVENT_HYBRID_CALIBRATED_GATING_EXPERIMENT_NAME,
            "research_gate": candidate["research_gate"],
            "active_trades": int(candidate["overall"]["active_trades"]),
            "trading": candidate["overall"]["trading"],
            "fold_selections": [
                {
                    "fold": int(fold["fold"]),
                    "opportunity_threshold": fold["selection"]["opportunity_threshold"],
                    "action_margin_floor": fold["selection"]["action_margin_floor"],
                    "outer_active_trades": fold["selection"].get("outer_active_trades"),
                    "outer_long_trades": fold["selection"].get("outer_long_trades"),
                    "outer_short_trades": fold["selection"].get("outer_short_trades"),
                    "opportunity_calibration": fold["selection"].get(
                        "opportunity_calibration"
                    ),
                }
                for fold in candidate["folds"]
            ],
        },
        "baseline_v10": (
            {
                "experiment": EVENT_HYBRID_PAYOFF_RISK_EXPERIMENT_NAME,
                "research_gate": baseline["research_gate"],
                "active_trades": int(baseline["active_trades"]),
                "trading": baseline["trading"],
            }
            if isinstance(baseline, dict)
            else None
        ),
        "approved_for_paper": False,
        "approved_for_live": False,
    }


def _parse_dataset(value: str) -> dict[str, str]:
    instrument, separator, path = value.partition("=")
    if not separator or not instrument.strip() or not path.strip():
        raise ValueError("--dataset must use INSTRUMENT=/path/to/corpus.csv")
    return {instrument.strip().upper(): path.strip()}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run USDJPY v11 calibrated-gating research qualification"
    )
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--horizon-bars", type=int, default=1)
    parser.add_argument("--decision-time-before", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--max-splits", type=int, default=3)
    parser.add_argument("--reference-v10-report")
    args = parser.parse_args()

    report = evaluate_v11_candidate(
        _parse_dataset(args.dataset),
        horizon_bars=args.horizon_bars,
        decision_time_before=args.decision_time_before,
        report_path=args.report,
        max_splits=args.max_splits,
        reference_v10_report=args.reference_v10_report,
    )
    print(json.dumps(v11_summary(report), indent=2, sort_keys=True, default=str))


if __name__ == "__main__":
    main()
