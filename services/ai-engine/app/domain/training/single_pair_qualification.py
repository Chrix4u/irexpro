"""Bounded single-pair qualification for the first production candidate.

The fast loop intentionally evaluates only:
1. the locked directional baseline (governance reference), and
2. the event-barrier pair-expert architecture that already showed the
   strongest USDJPY directional evidence, and
3. a targeted hybrid that keeps that direction expert but uses the more
   learnable friction-positive opportunity target.

No research gate is lowered and no PAPER/LIVE approval is produced here.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pandas as pd

from app.domain.training.model_qualification import (
    CONFIDENCE_FLOOR,
    EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
    HYBRID_ACTIONABLE_EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
    ModelVariant,
    QualificationExperiment,
    _qualification_checkpoint_fingerprint,
    run_nested_qualification_experiments,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora


def single_pair_experiments() -> tuple[QualificationExperiment, ...]:
    """Return the intentionally small experiment matrix for the fast loop."""
    return (
        QualificationExperiment(
            name="baseline",
            variants=(ModelVariant(name="baseline_locked"),),
        ),
        QualificationExperiment(
            name=EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
            variants=(ModelVariant(name="event_barrier_v4_pair_direction"),),
            mode="two_stage_event_pair_experts",
        ),
        QualificationExperiment(
            name=HYBRID_ACTIONABLE_EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
            variants=(ModelVariant(name="actionable_event_hybrid_pair_direction"),),
            mode="hybrid_actionable_event_pair_experts",
        ),
    )


def evaluate_single_pair_candidate(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    decision_time_before: str | pd.Timestamp,
    report_path: str | Path,
    max_splits: int,
    confidence_floor: float = CONFIDENCE_FLOOR,
) -> dict[str, Any]:
    if len(datasets) != 1:
        raise ValueError("single-pair qualification requires exactly one dataset")
    if decision_time_before is None:
        raise ValueError("decision_time_before is required")
    if confidence_floor < CONFIDENCE_FLOOR:
        raise ValueError("confidence floor must not be lowered below 0.60")

    pooled, hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        decision_time_before=decision_time_before,
    )
    experiments = single_pair_experiments()
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
    report["qualification_checkpoint_fingerprint"] = fingerprint
    report["qualification_decision_time_before"] = pd.Timestamp(
        decision_time_before
    ).isoformat()
    report["single_pair_scope"] = {
        "instrument": next(iter(sorted(datasets))),
        "horizon_bars": int(horizon_bars),
        "experiment": HYBRID_ACTIONABLE_EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
        "research_only": True,
        "approved_for_paper": False,
        "approved_for_live": False,
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    temporary.replace(output)
    return {**report, "report_path": str(output)}


def candidate_summary(report: dict[str, Any]) -> dict[str, Any]:
    candidate = report["experiments"][
        HYBRID_ACTIONABLE_EVENT_PAIR_EXPERT_EXPERIMENT_NAME
    ]
    gate = candidate["research_gate"]
    overall = candidate["overall"]
    return {
        "experiment": HYBRID_ACTIONABLE_EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
        "research_gate_passed": bool(gate["research_gate_passed"]),
        "observed": gate["observed"],
        "checks": gate["checks"],
        "active_trades": int(overall["active_trades"]),
        "trade_or_period_count": int(
            overall["trading"]["trade_or_period_count"]
        ),
        "evidence_sufficiency_warnings": overall.get(
            "evidence_sufficiency_warnings", []
        ),
    }


def _parse_dataset(value: str) -> dict[str, str]:
    instrument, separator, path = value.partition("=")
    if not separator or not instrument.strip() or not path.strip():
        raise ValueError("--dataset must use INSTRUMENT=/path/to/corpus.csv")
    return {instrument.strip().upper(): path.strip()}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run bounded single-pair event-barrier qualification"
    )
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--horizon-bars", type=int, required=True)
    parser.add_argument("--decision-time-before", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--max-splits", type=int, default=3)
    parser.add_argument("--confidence-floor", type=float, default=CONFIDENCE_FLOOR)
    args = parser.parse_args()

    report = evaluate_single_pair_candidate(
        _parse_dataset(args.dataset),
        horizon_bars=args.horizon_bars,
        decision_time_before=args.decision_time_before,
        report_path=args.report,
        max_splits=args.max_splits,
        confidence_floor=args.confidence_floor,
    )
    print(json.dumps(candidate_summary(report), sort_keys=True))


if __name__ == "__main__":
    main()
