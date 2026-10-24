"""Research-only 5/20/60-minute opportunity challenger orchestration."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from app.domain.training.model_qualification import (
    ModelVariant,
    QualificationExperiment,
)

SHORT_HORIZON_MINUTES = (5, 20, 60)
SHORT_HORIZON_MIN_PERIODS_PER_DAY = {
    5: 6.0,
    20: 4.0,
    60: 2.0,
}
SHORT_HORIZON_CHALLENGER_EXPERIMENT = "short_horizon_event_hybrid_payoff_risk"
SHORT_HORIZON_CHALLENGER_VARIANT = "short_horizon_v1_hybrid_payoff_risk"


def short_horizon_experiments() -> tuple[QualificationExperiment, ...]:
    """Return the locked baseline plus one fixed bounded short-horizon challenger."""
    return (
        QualificationExperiment(
            name="baseline",
            variants=(ModelVariant(name="baseline_locked"),),
        ),
        QualificationExperiment(
            name=SHORT_HORIZON_CHALLENGER_EXPERIMENT,
            variants=(ModelVariant(name=SHORT_HORIZON_CHALLENGER_VARIANT),),
            mode="event_hybrid_dual_direction_payoff_risk",
        ),
    )


def _validation_days(folds: list[dict[str, Any]]) -> float:
    """Return the summed untouched outer-validation wall-clock duration in days."""
    seconds = 0.0
    for fold in folds:
        start = datetime.fromisoformat(str(fold["validation_start"]).replace("Z", "+00:00"))
        end = datetime.fromisoformat(str(fold["validation_end"]).replace("Z", "+00:00"))
        elapsed = (end - start).total_seconds()
        if elapsed < 0:
            raise ValueError("outer validation end precedes start")
        seconds += elapsed
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
