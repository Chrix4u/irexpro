"""Historical causal evaluation of advisory Agent Council overlays.

This module is research-only. It replays contextual evidence at each already
out-of-sample quantitative decision time and compares the existing quant-only
trade stream with a candidate policy that suppresses entries during verified
high-impact macro-event windows.

It never changes model probabilities, reverses direction, resizes positions,
publishes signals, or calls execution/broker services.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.agents.context_sources import (
    TrustedContextSourceRegistry,
    default_trusted_source_registry,
)
from app.domain.agents.coordinator import assess_agent_context
from app.domain.agents.macro_context import (
    MacroContextEvent,
    build_high_impact_event_evidence,
)
from app.domain.training.train_multitimeframe import _trade_metrics
from app.domain.training.validation import compute_classification_metrics

_CONTEXT_POLICY = "verified_high_impact_macro_block_overlay_v1"
_REQUIRED_PREDICTION_COLUMNS = {
    "decision_time",
    "instrument",
    "confidence",
    "predicted_long",
    "active_trade",
    "selected_net_return",
}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_historical_macro_events(path: str | Path) -> list[MacroContextEvent]:
    """Load normalized historical macro events from CSV, JSON, or JSONL."""
    source = Path(path)
    suffix = source.suffix.lower()

    if suffix == ".csv":
        frame = pd.read_csv(source)
        raw_rows = [
            {key: value for key, value in row.items() if not pd.isna(value)}
            for row in frame.to_dict(orient="records")
        ]
    elif suffix == ".json":
        parsed = json.loads(source.read_text(encoding="utf-8"))
        if not isinstance(parsed, list):
            raise ValueError("Historical macro JSON must contain a list of events")
        raw_rows = parsed
    elif suffix in {".jsonl", ".ndjson"}:
        raw_rows = [
            json.loads(line)
            for line in source.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    else:
        raise ValueError("Historical macro events must be CSV, JSON, JSONL, or NDJSON")

    if not raw_rows:
        return []

    events: list[MacroContextEvent] = []
    for index, row in enumerate(raw_rows, start=1):
        if not isinstance(row, dict):
            raise ValueError(f"Historical macro event row {index} is not an object")
        try:
            events.append(MacroContextEvent.model_validate(row))
        except Exception as exc:
            raise ValueError(f"Invalid historical macro event row {index}: {exc}") from exc

    return events


def _validated_predictions(predictions: pd.DataFrame) -> pd.DataFrame:
    missing = sorted(_REQUIRED_PREDICTION_COLUMNS - set(predictions.columns))
    if missing:
        raise ValueError(f"Prediction dataset missing required columns: {missing}")
    if predictions.empty:
        raise ValueError("Prediction dataset is empty")

    frame = predictions.copy()
    frame["decision_time"] = pd.to_datetime(
        frame["decision_time"],
        utc=True,
        errors="coerce",
    )
    if frame["decision_time"].isna().any():
        raise ValueError("Prediction dataset contains invalid decision_time values")

    frame["instrument"] = frame["instrument"].astype(str).str.strip().str.upper()
    if frame["instrument"].str.len().eq(0).any():
        raise ValueError("Prediction dataset contains blank instruments")

    frame["confidence"] = pd.to_numeric(frame["confidence"], errors="coerce")
    if (
        frame["confidence"].isna().any()
        or not np.isfinite(frame["confidence"].to_numpy(dtype=float)).all()
        or (frame["confidence"] < 0).any()
        or (frame["confidence"] > 1).any()
    ):
        raise ValueError("Prediction confidence must be finite and between 0 and 1")

    def normalize_boolean(series: pd.Series, field_name: str) -> pd.Series:
        if pd.api.types.is_bool_dtype(series):
            return series.astype(bool)

        def parse(value: Any) -> bool | None:
            if isinstance(value, bool | np.bool_):
                return bool(value)
            if isinstance(value, int | np.integer) and int(value) in {0, 1}:
                return bool(int(value))
            if isinstance(value, str):
                normalized = value.strip().casefold()
                if normalized in {"true", "1"}:
                    return True
                if normalized in {"false", "0"}:
                    return False
            return None

        parsed = series.map(parse)
        if parsed.isna().any():
            raise ValueError(f"{field_name} must contain boolean values")
        return parsed.astype(bool)

    frame["predicted_long"] = normalize_boolean(
        frame["predicted_long"],
        "predicted_long",
    )
    frame["active_trade"] = normalize_boolean(
        frame["active_trade"],
        "active_trade",
    )

    if "fold" in frame.columns:
        folds = pd.to_numeric(frame["fold"], errors="coerce")
        if (
            folds.isna().any()
            or not np.isfinite(folds.to_numpy(dtype=float)).all()
            or (folds < 1).any()
            or ((folds % 1) != 0).any()
        ):
            raise ValueError("fold must contain positive integer values")
        frame["fold"] = folds.astype(int)

    frame["selected_net_return"] = pd.to_numeric(
        frame["selected_net_return"],
        errors="coerce",
    )
    if (
        frame["selected_net_return"].isna().any()
        or not np.isfinite(frame["selected_net_return"].to_numpy(dtype=float)).all()
    ):
        raise ValueError("selected_net_return must contain finite values")

    return frame.sort_values(["decision_time", "instrument"]).reset_index(drop=True)


def _metric_delta(
    candidate: dict[str, Any],
    baseline: dict[str, Any],
    key: str,
) -> float | int | None:
    candidate_value = candidate.get(key)
    baseline_value = baseline.get(key)
    if isinstance(candidate_value, bool) or isinstance(baseline_value, bool):
        return None
    if isinstance(candidate_value, int | float) and isinstance(
        baseline_value,
        int | float,
    ):
        return candidate_value - baseline_value
    return None


def _directional_accuracy(
    rows: pd.DataFrame,
    *,
    active_column: str,
) -> float | None:
    if "target" not in rows.columns:
        return None
    target = pd.to_numeric(rows["target"], errors="coerce")
    if target.isna().any() or not target.isin([0, 1]).all():
        raise ValueError("target must contain only binary 0/1 labels")
    active = rows[active_column].astype(bool)
    if not active.any():
        return None
    predicted = rows.loc[active, "predicted_long"].astype(bool).astype(int)
    actual = target.loc[active].astype(int)
    return float((predicted.to_numpy() == actual.to_numpy()).mean())


def _classification_on_active(
    rows: pd.DataFrame,
    *,
    active_column: str,
) -> dict[str, float | None] | None:
    if "target" not in rows.columns or "positive_probability" not in rows.columns:
        return None

    target = pd.to_numeric(rows["target"], errors="coerce")
    probabilities = pd.to_numeric(rows["positive_probability"], errors="coerce")
    if target.isna().any() or not target.isin([0, 1]).all():
        raise ValueError("target must contain only binary 0/1 labels")
    if (
        probabilities.isna().any()
        or not np.isfinite(probabilities.to_numpy(dtype=float)).all()
        or (probabilities < 0).any()
        or (probabilities > 1).any()
    ):
        raise ValueError("positive_probability must be finite and between 0 and 1")

    active = rows[active_column].astype(bool)
    if not active.any():
        return None
    return compute_classification_metrics(
        target.loc[active].to_numpy(dtype=int),
        probabilities.loc[active].to_numpy(dtype=float),
    )


def _summarize_comparison(
    rows: pd.DataFrame,
    *,
    horizon_bars: int,
) -> dict[str, Any]:
    baseline_frame = rows.copy()
    candidate_frame = rows.copy()
    candidate_frame["active_trade"] = candidate_frame[
        "context_candidate_active_trade"
    ].astype(bool)

    baseline = _trade_metrics(baseline_frame, horizon_bars=horizon_bars)
    candidate = _trade_metrics(candidate_frame, horizon_bars=horizon_bars)
    delta_keys = (
        "raw_active_signals",
        "non_overlapping_periods",
        "total_return",
        "average_net_return",
        "median_net_return",
        "win_rate",
        "profit_factor",
        "sharpe_ratio",
        "sortino_ratio",
        "max_drawdown",
    )
    baseline_accuracy = _directional_accuracy(
        rows,
        active_column="active_trade",
    )
    candidate_accuracy = _directional_accuracy(
        rows,
        active_column="context_candidate_active_trade",
    )
    accuracy_delta = (
        candidate_accuracy - baseline_accuracy
        if candidate_accuracy is not None and baseline_accuracy is not None
        else None
    )
    baseline_classification = _classification_on_active(
        rows,
        active_column="active_trade",
    )
    candidate_classification = _classification_on_active(
        rows,
        active_column="context_candidate_active_trade",
    )
    precision_delta = (
        float(candidate_classification["precision"])
        - float(baseline_classification["precision"])
        if candidate_classification is not None
        and baseline_classification is not None
        and candidate_classification["precision"] is not None
        and baseline_classification["precision"] is not None
        else None
    )
    brier_delta = (
        float(candidate_classification["brier_score"])
        - float(baseline_classification["brier_score"])
        if candidate_classification is not None
        and baseline_classification is not None
        and candidate_classification["brier_score"] is not None
        and baseline_classification["brier_score"] is not None
        else None
    )
    log_loss_delta = (
        float(candidate_classification["log_loss"])
        - float(baseline_classification["log_loss"])
        if candidate_classification is not None
        and baseline_classification is not None
        and candidate_classification["log_loss"] is not None
        and baseline_classification["log_loss"] is not None
        else None
    )
    return {
        "quant_only": baseline,
        "context_block_candidate": candidate,
        "directional_accuracy_on_active_signals": {
            "quant_only": baseline_accuracy,
            "context_block_candidate": candidate_accuracy,
            "delta_candidate_minus_quant": accuracy_delta,
        },
        "classification_on_active_signals": {
            "quant_only": baseline_classification,
            "context_block_candidate": candidate_classification,
            "precision_delta_candidate_minus_quant": precision_delta,
            "brier_delta_candidate_minus_quant": brier_delta,
            "log_loss_delta_candidate_minus_quant": log_loss_delta,
        },
        "delta_candidate_minus_quant": {
            key: _metric_delta(candidate, baseline, key) for key in delta_keys
        },
    }


def evaluate_agent_context_overlay_with_rows(
    predictions: pd.DataFrame,
    events: list[MacroContextEvent],
    *,
    horizon_bars: int,
    registry: TrustedContextSourceRegistry | None = None,
    pre_event_minutes: int = 30,
    post_event_minutes: int = 15,
) -> tuple[dict[str, Any], pd.DataFrame]:
    """Replay historical context against out-of-sample quant predictions."""
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be at least 1")
    for value, field_name in (
        (pre_event_minutes, "pre_event_minutes"),
        (post_event_minutes, "post_event_minutes"),
    ):
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or not 0 <= value <= 24 * 60
        ):
            raise ValueError(
                f"{field_name} must be an integer between 0 and 1440 minutes"
            )

    frame = _validated_predictions(predictions)
    trusted = registry or default_trusted_source_registry()

    frame["agent_context_status"] = "NOT_EVALUATED"
    frame["agent_context_evidence_count"] = 0
    frame["context_candidate_active_trade"] = frame["active_trade"].astype(bool)

    for index, row in frame.loc[frame["active_trade"]].iterrows():
        decision_time = pd.Timestamp(row["decision_time"]).to_pydatetime()
        quant_direction = "BUY" if bool(row["predicted_long"]) else "SELL"
        evidence = build_high_impact_event_evidence(
            events=events,
            registry=trusted,
            instrument=str(row["instrument"]),
            evaluated_at=decision_time,
            pre_event_minutes=pre_event_minutes,
            post_event_minutes=post_event_minutes,
        )

        # Defense in depth: historical replay must never consume source material
        # whose provider availability is after the decision being evaluated.
        for item in evidence:
            source_available = item.metadata.get("sourceAvailableAt")
            if source_available is None:
                continue
            source_available_at = pd.Timestamp(source_available)
            if source_available_at.tzinfo is None:
                source_available_at = source_available_at.tz_localize("UTC")
            else:
                source_available_at = source_available_at.tz_convert("UTC")
            if source_available_at.to_pydatetime() > decision_time:
                raise ValueError("Historical context replay detected future source availability")

        assessment = assess_agent_context(
            instrument=str(row["instrument"]),
            quant_direction=quant_direction,
            quant_confidence=float(row["confidence"]),
            evidence=evidence,
            evaluated_at=decision_time,
        )
        frame.at[index, "agent_context_status"] = assessment.status
        frame.at[index, "agent_context_evidence_count"] = len(
            assessment.evidence_used
        )
        if assessment.status == "BLOCKED":
            frame.at[index, "context_candidate_active_trade"] = False

    active = frame.loc[frame["active_trade"]].copy()
    statuses = Counter(active["agent_context_status"].tolist())
    blocked = active.loc[active["agent_context_status"] == "BLOCKED"]

    overall = _summarize_comparison(frame, horizon_bars=horizon_bars)
    by_fold = (
        {
            str(int(fold)): {
                **_summarize_comparison(group, horizon_bars=horizon_bars),
                "active_signal_count": int(group["active_trade"].sum()),
                "blocked_signal_count": int(
                    (
                        group["active_trade"]
                        & (group["agent_context_status"] == "BLOCKED")
                    ).sum()
                ),
            }
            for fold, group in frame.groupby("fold", sort=True)
        }
        if "fold" in frame.columns
        else {}
    )
    by_instrument = {
        instrument: {
            **_summarize_comparison(group, horizon_bars=horizon_bars),
            "active_signal_count": int(group["active_trade"].sum()),
            "blocked_signal_count": int(
                (
                    group["active_trade"]
                    & (group["agent_context_status"] == "BLOCKED")
                ).sum()
            ),
        }
        for instrument, group in frame.groupby("instrument", sort=True)
    }

    report = {
        "report_version": 1,
        "study": "agent_council_historical_overlay",
        "policy_candidate": _CONTEXT_POLICY,
        "horizon_bars": horizon_bars,
        "event_window": {
            "pre_event_minutes": pre_event_minutes,
            "post_event_minutes": post_event_minutes,
        },
        "evaluated_rows": int(len(frame)),
        "quant_active_signals": int(frame["active_trade"].sum()),
        "candidate_active_signals": int(
            frame["context_candidate_active_trade"].sum()
        ),
        "status_counts_on_quant_active_signals": {
            status: int(count) for status, count in sorted(statuses.items())
        },
        "blocked_signal_diagnostics": {
            "blocked_signals": int(len(blocked)),
            "blocked_positive_outcomes": int(
                (blocked["selected_net_return"] > 0).sum()
            ),
            "blocked_negative_outcomes": int(
                (blocked["selected_net_return"] < 0).sum()
            ),
            "blocked_flat_outcomes": int(
                (blocked["selected_net_return"] == 0).sum()
            ),
        },
        "overall": overall,
        "by_fold": by_fold,
        "by_instrument": by_instrument,
        "governance": {
            "lookahead_allowed": False,
            "quant_direction_changed": False,
            "quant_confidence_changed": False,
            "position_size_changed": False,
            "execution_authority": False,
            "approved_for_paper_uat": False,
            "approved_for_staging": False,
            "approved_for_live": False,
            "purpose": (
                "research-only comparison of a context block overlay against the "
                "existing quant-only out-of-sample validation stream"
            ),
        },
    }
    return report, frame


def evaluate_agent_context_overlay(
    predictions: pd.DataFrame,
    events: list[MacroContextEvent],
    *,
    horizon_bars: int,
    registry: TrustedContextSourceRegistry | None = None,
    pre_event_minutes: int = 30,
    post_event_minutes: int = 15,
) -> dict[str, Any]:
    """Return the research report without exposing annotated rows."""
    report, _ = evaluate_agent_context_overlay_with_rows(
        predictions,
        events,
        horizon_bars=horizon_bars,
        registry=registry,
        pre_event_minutes=pre_event_minutes,
        post_event_minutes=post_event_minutes,
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Compare quant-only walk-forward predictions with a causal "
            "Agent Council macro-block overlay"
        )
    )
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--events", required=True)
    parser.add_argument("--horizon-bars", type=int, required=True)
    parser.add_argument("--pre-event-minutes", type=int, default=30)
    parser.add_argument("--post-event-minutes", type=int, default=15)
    parser.add_argument("--report", required=True)
    parser.add_argument("--annotated-predictions")
    args = parser.parse_args()

    predictions_path = Path(args.predictions)
    events_path = Path(args.events)
    predictions = pd.read_csv(predictions_path)
    events = load_historical_macro_events(events_path)
    report, annotated = evaluate_agent_context_overlay_with_rows(
        predictions,
        events,
        horizon_bars=args.horizon_bars,
        pre_event_minutes=args.pre_event_minutes,
        post_event_minutes=args.post_event_minutes,
    )
    report["inputs"] = {
        "predictions_sha256": _sha256_file(predictions_path),
        "events_sha256": _sha256_file(events_path),
    }

    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True),
        encoding="utf-8",
    )

    if args.annotated_predictions:
        annotated_path = Path(args.annotated_predictions)
        annotated_path.parent.mkdir(parents=True, exist_ok=True)
        annotated.to_csv(annotated_path, index=False)

    print(json.dumps({**report, "report_path": str(report_path)}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
