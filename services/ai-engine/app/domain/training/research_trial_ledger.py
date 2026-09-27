"""Append-only research trial ledger helpers for model-selection accounting."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ResearchTrial:
    candidate: str
    experiment: str
    candidate_sha: str
    outer_era: str
    trade_count: int
    long_trades: int
    short_trades: int
    sharpe_ratio: float | None
    profit_factor: float | None
    max_drawdown: float | None
    total_return: float | None
    research_passed: bool
    approved_for_paper: bool
    approved_for_live: bool


def trial_from_report(
    report: dict[str, Any],
    *,
    candidate: str,
    candidate_sha: str,
    outer_era: str,
) -> ResearchTrial:
    aggregate = report.get("aggregate") or {}
    trading = aggregate.get("trading") or aggregate
    gate = report.get("robustness_gate") or report.get("research_gate") or {}
    passed = bool(
        gate.get("research_robustness_passed")
        or gate.get("research_gate_passed")
    )
    return ResearchTrial(
        candidate=candidate,
        experiment=str(report.get("experiment", candidate)),
        candidate_sha=candidate_sha,
        outer_era=outer_era,
        trade_count=int(trading.get("trade_count", trading.get("trade_or_period_count", 0))),
        long_trades=int(trading.get("long_trades", 0)),
        short_trades=int(trading.get("short_trades", 0)),
        sharpe_ratio=(
            float(trading["sharpe_ratio"])
            if trading.get("sharpe_ratio") is not None
            else None
        ),
        profit_factor=(
            float(trading["profit_factor"])
            if trading.get("profit_factor") is not None
            else None
        ),
        max_drawdown=(
            float(trading["max_drawdown"])
            if trading.get("max_drawdown") is not None
            else None
        ),
        total_return=(
            float(trading["total_return"])
            if trading.get("total_return") is not None
            else None
        ),
        research_passed=passed,
        approved_for_paper=bool(report.get("approved_for_paper", False)),
        approved_for_live=bool(report.get("approved_for_live", False)),
    )


def append_trial(path: str | Path, trial: ResearchTrial) -> list[dict[str, Any]]:
    """Append one unique candidate SHA while preserving an auditable JSON ledger."""
    ledger_path = Path(path)
    rows: list[dict[str, Any]] = []
    if ledger_path.exists():
        rows = json.loads(ledger_path.read_text(encoding="utf-8"))
        if not isinstance(rows, list):
            raise ValueError("trial ledger must contain a JSON list")
    if any(row.get("candidate_sha") == trial.candidate_sha for row in rows):
        raise ValueError(f"candidate SHA already recorded: {trial.candidate_sha}")
    rows.append(asdict(trial))
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    ledger_path.write_text(
        json.dumps(rows, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return rows


def comparable_sharpes(rows: list[dict[str, Any]]) -> list[float]:
    """Return finite reported Sharpes for comparable completed research trials."""
    result: list[float] = []
    for row in rows:
        value = row.get("sharpe_ratio")
        if value is not None:
            result.append(float(value))
    return result
