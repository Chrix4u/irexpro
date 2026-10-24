"""Research-only 5/20/60-minute opportunity challenger orchestration."""
from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from app.domain.models.multitimeframe_features import INITIAL_FOREX_UNIVERSE
from app.domain.training.model_qualification import (
    CONFIDENCE_FLOOR,
    ModelVariant,
    QualificationExperiment,
    _qualification_checkpoint_fingerprint,
    run_nested_qualification_experiments,
)
from app.domain.training.train_multitimeframe import load_and_prepare_corpora

SHORT_HORIZON_MINUTES = (5, 20, 60)
SHORT_HORIZON_MIN_PERIODS_PER_DAY = {
    5: 24.0,
    20: 12.0,
    60: 6.0,
}
SHORT_HORIZON_V1_EXPERIMENT = "short_horizon_event_hybrid_payoff_risk"
SHORT_HORIZON_V1_VARIANT = "short_horizon_v1_hybrid_payoff_risk"
SHORT_HORIZON_CHALLENGER_EXPERIMENT = "short_horizon_event_pair_experts_v2"
SHORT_HORIZON_CHALLENGER_VARIANT = "short_horizon_v2_pair_experts"


def short_horizon_experiments() -> tuple[QualificationExperiment, ...]:
    """Return baseline, retained v1, and the v2 actionable-only pair expert challenger."""
    return (
        QualificationExperiment(
            name="baseline",
            variants=(ModelVariant(name="baseline_locked"),),
        ),
        QualificationExperiment(
            name=SHORT_HORIZON_V1_EXPERIMENT,
            variants=(ModelVariant(name=SHORT_HORIZON_V1_VARIANT),),
            mode="event_hybrid_dual_direction_payoff_risk",
        ),
        QualificationExperiment(
            name=SHORT_HORIZON_CHALLENGER_EXPERIMENT,
            variants=(ModelVariant(name=SHORT_HORIZON_CHALLENGER_VARIANT),),
            mode="two_stage_event_pair_experts",
        ),
    )


_NEW_YORK = ZoneInfo("America/New_York")


def _parse_utc(value: Any) -> datetime:
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("outer validation timestamps must be timezone-aware")
    return parsed.astimezone(UTC)


def _fx_active_seconds(start: datetime, end: datetime) -> float:
    """Return overlap with the 24x5 FX week, DST-aware in New York time."""
    if end < start:
        raise ValueError("outer validation end precedes start")
    if end == start:
        return 0.0

    local_start = start.astimezone(_NEW_YORK).date() - timedelta(days=6)
    local_end = end.astimezone(_NEW_YORK).date()
    current = local_start
    active_seconds = 0.0
    while current <= local_end:
        if current.weekday() == 6:  # Sunday
            open_local = datetime.combine(current, time(17, 0), tzinfo=_NEW_YORK)
            close_local = datetime.combine(
                current + timedelta(days=5), time(17, 0), tzinfo=_NEW_YORK
            )
            open_utc = open_local.astimezone(UTC)
            close_utc = close_local.astimezone(UTC)
            overlap_start = max(start, open_utc)
            overlap_end = min(end, close_utc)
            if overlap_end > overlap_start:
                active_seconds += (overlap_end - overlap_start).total_seconds()
        current += timedelta(days=1)
    return active_seconds


def _validation_days(folds: list[dict[str, Any]]) -> float:
    """Return summed outer-validation duration in active 24x5 FX-market days."""
    seconds = 0.0
    for fold in folds:
        start = _parse_utc(fold["validation_start"])
        end = _parse_utc(fold["validation_end"])
        seconds += _fx_active_seconds(start, end)
    return seconds / 86_400.0


def summarize_horizon_report(
    report: dict[str, Any],
    *,
    horizon_minutes: int,
) -> dict[str, Any]:
    """Combine the locked research gate with an explicit participation requirement."""
    if horizon_minutes not in SHORT_HORIZON_MINUTES:
        raise ValueError(f"Unsupported short horizon: {horizon_minutes}")

    experiments = report.get("experiments")
    if not isinstance(experiments, dict):
        raise ValueError("qualification report is missing experiments")
    challenger = experiments.get(SHORT_HORIZON_CHALLENGER_EXPERIMENT)
    if not isinstance(challenger, dict):
        raise ValueError("qualification report is missing short-horizon challenger")

    folds = challenger.get("folds")
    if not isinstance(folds, list) or not folds:
        raise ValueError("short-horizon challenger is missing outer folds")
    validation_days = _validation_days(folds)
    if validation_days <= 0.0:
        raise ValueError("short-horizon challenger has no validation duration")

    periods = sum(
        int(fold["aggregate"]["trading"]["trade_or_period_count"])
        for fold in folds
    )
    opportunities_per_day = float(periods / validation_days)
    target = float(SHORT_HORIZON_MIN_PERIODS_PER_DAY[horizon_minutes])
    research_gate = challenger.get("research_gate")
    research_gate_passed = bool(
        isinstance(research_gate, dict) and research_gate.get("research_gate_passed", False)
    )
    participation_gate_passed = opportunities_per_day >= target

    overall = challenger.get("overall", {})
    classification = overall.get("classification", {}) if isinstance(overall, dict) else {}
    trading = overall.get("trading", {}) if isinstance(overall, dict) else {}

    return {
        "horizon_minutes": horizon_minutes,
        "horizon_bars": horizon_minutes,
        "validation_days": validation_days,
        "non_overlapping_opportunity_periods": periods,
        "opportunities_per_validation_day": opportunities_per_day,
        "participation_target": target,
        "research_gate_passed": research_gate_passed,
        "participation_gate_passed": participation_gate_passed,
        "short_horizon_research_passed": (
            research_gate_passed and participation_gate_passed
        ),
        "balanced_accuracy": classification.get("balanced_accuracy"),
        "profit_factor": trading.get("profit_factor"),
        "sharpe_ratio": trading.get("sharpe_ratio"),
        "max_drawdown": trading.get("max_drawdown"),
        "approved_for_paper": False,
        "approved_for_live": False,
    }


def evaluate_short_horizon_corpora(
    datasets: dict[str, str | Path],
    *,
    decision_time_before: str,
    report_path: str | Path,
    confidence_floor: float = CONFIDENCE_FLOOR,
    max_splits: int = 5,
) -> dict[str, Any]:
    """Run the fixed challenger independently at 5/20/60 minutes."""
    if set(datasets) != set(INITIAL_FOREX_UNIVERSE):
        raise ValueError("short-horizon research requires the complete six-pair universe")
    if not decision_time_before:
        raise ValueError("decision_time_before is required")
    if confidence_floor < CONFIDENCE_FLOOR:
        raise ValueError("confidence floor must not be lowered below 0.60")

    output = Path(report_path)
    experiments = short_horizon_experiments()
    horizons: dict[str, Any] = {}

    for horizon in SHORT_HORIZON_MINUTES:
        pooled, hashes = load_and_prepare_corpora(
            datasets,
            horizon_bars=horizon,
            decision_time_before=decision_time_before,
        )
        fingerprint = _qualification_checkpoint_fingerprint(
            dataset_sha256=hashes,
            decision_time_before=decision_time_before,
            horizon_bars=horizon,
            confidence_floor=confidence_floor,
            max_splits=max_splits,
            experiments=experiments,
        )
        checkpoint_dir = output.parent / f"{output.stem}.h{horizon}.checkpoints"
        qualification = run_nested_qualification_experiments(
            pooled,
            horizon_bars=horizon,
            confidence_floor=confidence_floor,
            max_splits=max_splits,
            experiments=experiments,
            checkpoint_dir=checkpoint_dir,
            checkpoint_fingerprint=fingerprint,
        )
        qualification["dataset_sha256"] = hashes
        qualification["qualification_checkpoint_fingerprint"] = fingerprint
        qualification["qualification_decision_time_before"] = decision_time_before
        summary = summarize_horizon_report(
            qualification,
            horizon_minutes=horizon,
        )
        horizons[f"{horizon}m"] = {
            "summary": summary,
            "qualification": qualification,
        }

    passed = all(
        block["summary"]["short_horizon_research_passed"]
        for block in horizons.values()
    )
    result: dict[str, Any] = {
        "report_version": 2,
        "purpose": "short_horizon_opportunity_research_only",
        "model_family": "two_stage_event_pair_experts",
        "retained_control_model_family": "event_hybrid_dual_direction_payoff_risk",
        "horizon_minutes": list(SHORT_HORIZON_MINUTES),
        "confidence_floor": confidence_floor,
        "decision_time_before": decision_time_before,
        "short_horizon_research_passed": passed,
        "horizons": horizons,
        "governance": {
            "shadow_only": True,
            "approved_for_paper": False,
            "approved_for_demo": False,
            "approved_for_live": False,
            "forced_trade_quota": False,
        },
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(
        json.dumps(result, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    temporary.replace(output)
    return {**result, "report_path": str(output)}


def _parse_dataset_args(values: list[str]) -> dict[str, str]:
    datasets: dict[str, str] = {}
    for value in values:
        instrument, separator, path = value.partition("=")
        instrument = instrument.strip().upper()
        if not separator or not instrument or not path.strip():
            raise ValueError("--dataset must use INSTRUMENT=/path/to/corpus.csv")
        if instrument in datasets:
            raise ValueError(f"duplicate dataset for {instrument}")
        datasets[instrument] = path.strip()
    return datasets


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate the shadow-only 5/20/60-minute opportunity challenger"
    )
    parser.add_argument("--dataset", action="append", required=True)
    parser.add_argument("--decision-time-before", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--max-splits", type=int, default=5)
    parser.add_argument("--confidence-floor", type=float, default=CONFIDENCE_FLOOR)
    args = parser.parse_args()
    result = evaluate_short_horizon_corpora(
        _parse_dataset_args(args.dataset),
        decision_time_before=args.decision_time_before,
        report_path=args.report,
        confidence_floor=args.confidence_floor,
        max_splits=args.max_splits,
    )
    print(json.dumps(result, indent=2, sort_keys=True, default=str))


if __name__ == "__main__":
    main()
