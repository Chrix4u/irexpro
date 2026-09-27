"""Generate forensic robustness diagnostics from frozen qualification checkpoints."""
from __future__ import annotations

import argparse
import json
from collections.abc import Iterable
from pathlib import Path

import numpy as np
import pandas as pd

from app.domain.training.robustness_audit import robustness_snapshot

EXPERIMENT = "event_barrier_hybrid_opportunity_dual_direction_payoff_risk"
CONFIDENCE_BUCKETS = [0.0, 0.60, 0.65, 0.70, 0.80, 1.0]


def _safe_float(value: object) -> float | None:
    if value is None:
        return None
    result = float(value)
    return result if np.isfinite(result) else None


def _active_rows(frame: pd.DataFrame) -> pd.DataFrame:
    if "active_trade" not in frame:
        raise ValueError("checkpoint is missing active_trade")
    return frame.loc[frame["active_trade"].astype(bool)].copy()


def _max_consecutive_losses(returns: Iterable[float]) -> int:
    longest = current = 0
    for value in returns:
        if float(value) < 0.0:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest


def _session(hour: int) -> str:
    if 0 <= hour < 7:
        return "asia"
    if 7 <= hour < 13:
        return "london"
    if 13 <= hour < 16:
        return "london_new_york_overlap"
    if 16 <= hour < 21:
        return "new_york"
    return "late_session"


def _trade_summary(active: pd.DataFrame) -> dict[str, object]:
    if active.empty:
        return {
            "trade_count": 0,
            "wins": 0,
            "losses": 0,
            "win_rate": None,
            "total_return_sum": 0.0,
            "average_return": None,
            "median_return": None,
            "worst_trade": None,
            "best_trade": None,
            "max_consecutive_losses": 0,
        }
    returns = pd.to_numeric(active["selected_net_return"], errors="raise")
    return {
        "trade_count": int(len(active)),
        "wins": int((returns > 0).sum()),
        "losses": int((returns < 0).sum()),
        "win_rate": float((returns > 0).mean()),
        "total_return_sum": float(returns.sum()),
        "average_return": float(returns.mean()),
        "median_return": float(returns.median()),
        "worst_trade": float(returns.min()),
        "best_trade": float(returns.max()),
        "max_consecutive_losses": _max_consecutive_losses(returns),
    }


def _calibration(active: pd.DataFrame) -> list[dict[str, object]]:
    if active.empty:
        return []
    working = active.copy()
    working["confidence_bucket"] = pd.cut(
        working["confidence"],
        bins=CONFIDENCE_BUCKETS,
        right=False,
        include_lowest=True,
    )
    rows: list[dict[str, object]] = []
    for bucket, group in working.groupby("confidence_bucket", observed=True):
        returns = pd.to_numeric(group["selected_net_return"], errors="raise")
        rows.append(
            {
                "bucket": str(bucket),
                "trades": int(len(group)),
                "mean_confidence": float(group["confidence"].mean()),
                "win_rate": float((returns > 0).mean()),
                "average_return": float(returns.mean()),
            }
        )
    return rows


def _context(active: pd.DataFrame) -> dict[str, object]:
    if active.empty:
        return {"direction": {}, "session": {}, "market": {}}
    working = active.copy()
    times = pd.to_datetime(working["decision_time"], utc=True, errors="raise")
    working["session"] = [_session(int(hour)) for hour in times.dt.hour]
    working["direction"] = np.where(working["predicted_long"].astype(bool), "long", "short")

    direction: dict[str, object] = {}
    for name, group in working.groupby("direction"):
        direction[name] = _trade_summary(group)

    session: dict[str, object] = {}
    for name, group in working.groupby("session"):
        session[str(name)] = _trade_summary(group)

    market = {
        "average_spread_bps": _safe_float(working["m1_spread_bps"].mean()),
        "median_spread_bps": _safe_float(working["m1_spread_bps"].median()),
        "average_volatility_20": _safe_float(working["m1_volatility_20"].mean()),
        "median_volatility_20": _safe_float(working["m1_volatility_20"].median()),
    }
    return {"direction": direction, "session": session, "market": market}


def _gating_funnel(frame: pd.DataFrame) -> dict[str, object]:
    rows: dict[str, object] = {}
    for name, mask in {
        "long": frame["predicted_long"].astype(bool),
        "short": ~frame["predicted_long"].astype(bool),
    }.items():
        side = frame.loc[mask].copy()
        direction = side["direction_confidence"] >= 0.60
        opportunity = side["opportunity_probability"] >= 0.60
        margin = side["action_probability_margin"] >= 0.10
        payoff = side["payoff_filter_pass"].astype(bool)
        rows[name] = {
            "predictions": int(len(side)),
            "direction_confidence_pass": int(direction.sum()),
            "opportunity_confidence_pass": int(opportunity.sum()),
            "margin_pass": int(margin.sum()),
            "payoff_pass": int(payoff.sum()),
            "pre_payoff_pass": int((direction & opportunity & margin).sum()),
            "all_filters_pass": int((direction & opportunity & margin & payoff).sum()),
        }
    return rows



def _directional_payoff_diagnostics(frame: pd.DataFrame) -> dict[str, object]:
    result: dict[str, object] = {}
    for name, mask in {
        "long": frame["predicted_long"].astype(bool),
        "short": ~frame["predicted_long"].astype(bool),
    }.items():
        side = frame.loc[mask].copy()
        pre = side.loc[
            (side["direction_confidence"] >= 0.60)
            & (side["opportunity_probability"] >= 0.60)
            & (side["action_probability_margin"] >= 0.10)
        ].copy()
        if pre.empty:
            result[name] = {"pre_payoff_candidates": 0}
            continue
        ratios = pd.to_numeric(pre["expected_payoff_ratio"], errors="raise")
        realized = pd.to_numeric(pre["selected_net_return"], errors="raise")
        result[name] = {
            "pre_payoff_candidates": int(len(pre)),
            "payoff_ratio_min": float(ratios.min()),
            "payoff_ratio_median": float(ratios.median()),
            "payoff_ratio_max": float(ratios.max()),
            "payoff_ratio_gte_1_0": int((ratios >= 1.0).sum()),
            "payoff_ratio_gte_1_15": int((ratios >= 1.15).sum()),
            "realized_win_rate": float((realized > 0.0).mean()),
            "realized_average_return": float(realized.mean()),
            "realized_total_return": float(realized.sum()),
        }
    return result

def generate_report(qualification_root: Path) -> dict[str, object]:
    checkpoint_root = qualification_root / "qualification.checkpoints"
    pattern = f"fold-*-{EXPERIMENT}.csv"
    paths = sorted(checkpoint_root.glob(pattern))
    if not paths:
        raise FileNotFoundError(f"No checkpoints matched {pattern}")

    fold_reports: list[dict[str, object]] = []
    active_frames: list[pd.DataFrame] = []
    for path in paths:
        frame = pd.read_csv(path)
        active = _active_rows(frame)
        active_frames.append(active)
        summary = _trade_summary(active)
        fold_reports.append(
            {
                "fold": int(frame["fold"].iloc[0]),
                "validation_rows": int(len(frame)),
                **summary,
                "context": _context(active),
                "calibration": _calibration(active),
            }
        )

    combined = pd.concat(active_frames, ignore_index=True)
    all_predictions = pd.concat([pd.read_csv(path) for path in paths], ignore_index=True)
    returns = pd.to_numeric(combined["selected_net_return"], errors="raise").tolist()
    trial_sharpes: list[float] = []
    qualification_path = qualification_root / "qualification.json"
    if qualification_path.exists():
        qualification = json.loads(qualification_path.read_text(encoding="utf-8"))
        for experiment in (qualification.get("experiments") or {}).values():
            sharpe = (
                ((experiment.get("overall") or {}).get("trading") or {})
                .get("sharpe_ratio")
            )
            if sharpe is not None:
                trial_sharpes.append(float(sharpe))

    valid_folds = [row for row in fold_reports if row["trade_count"]]
    worst_fold = None
    if valid_folds:
        worst_fold = min(
            valid_folds,
            key=lambda row: (
                float(row["total_return_sum"]),
                float(row["win_rate"]) if row["win_rate"] is not None else -1.0,
            ),
        )

    return {
        "experiment": EXPERIMENT,
        "status": "AUDIT_ONLY_DO_NOT_CHANGE_FROZEN_V10",
        "fold_count": len(fold_reports),
        "folds": fold_reports,
        "overall_trades": _trade_summary(combined),
        "overall_context": _context(combined),
        "overall_calibration": _calibration(combined),
        "directional_gating_funnel": _gating_funnel(all_predictions),
        "directional_payoff_diagnostics": _directional_payoff_diagnostics(all_predictions),
        "statistical_robustness": robustness_snapshot(
            returns,
            comparable_trial_sharpes=trial_sharpes if len(trial_sharpes) >= 2 else None,
        ),
        "worst_fold": worst_fold,
        "interpretation": {
            "research_gate_unchanged": True,
            "headline_risk_metrics_reliable": len(combined) >= 30,
            "preferred_trade_evidence_reached": len(combined) >= 100,
            "holdout_consumed": False,
            "two_sided_execution_observed": bool((combined["predicted_long"].astype(bool)).any() and (~combined["predicted_long"].astype(bool)).any()),
            "directional_warning": ("Only one execution direction is represented in qualification trades." if len(combined) and combined["predicted_long"].nunique() < 2 else None),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--qualification-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = generate_report(args.qualification_root)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    print(json.dumps(report["interpretation"], sort_keys=True))


if __name__ == "__main__":
    main()
