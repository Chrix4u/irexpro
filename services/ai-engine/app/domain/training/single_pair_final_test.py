"""Untouched final-test evaluator for a qualified single-pair event expert."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pandas as pd

from app.domain.training.model_qualification import (
    ACTIONABLE_TARGET_COLUMN,
    CONFIDENCE_FLOOR,
    EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
    OPPORTUNITY_CLASSIFICATION_THRESHOLD,
    TARGET_COLUMN,
    _opportunity_classification,
    _summarize_predictions,
)
from app.domain.training.train_final_event_pair_bundle import (
    _fit_pair_candidate,
    _predict_pair_candidate,
)
from app.domain.training.train_final_multitimeframe import (
    DEFAULT_FINAL_GATE,
    _chronological_final_split,
)
from app.domain.training.train_multitimeframe import (
    EVENT_LABEL_POLICY,
    load_and_prepare_corpora,
)

SINGLE_PAIR_FINAL_TEST_POLICY = "single_pair_untouched_event_expert_v1"
SINGLE_PAIR_FUTURE_HOLDOUT_POLICY = "single_pair_future_holdout_event_expert_v1"


def _binary_balanced_accuracy(truth: pd.Series, predicted: pd.Series) -> float | None:
    """Compute binary balanced accuracy without changing model decisions."""
    truth_int = pd.to_numeric(truth, errors="raise").astype(int)
    predicted_bool = predicted.astype(bool)
    positives = truth_int == 1
    negatives = truth_int == 0
    if not positives.any() or not negatives.any():
        return None
    tpr = float((predicted_bool[positives]).mean())
    tnr = float((~predicted_bool[negatives]).mean())
    return float((tpr + tnr) / 2.0)


def _direction_failure_diagnostics(predictions: pd.DataFrame) -> dict[str, Any]:
    """Describe directional behavior for diagnosis only; never tune or gate from it."""
    if predictions.empty:
        return {
            "rows": 0,
            "event_direction_rows": 0,
            "active_trades": 0,
            "balanced_accuracy": None,
            "confusion": {"tn": 0, "fp": 0, "fn": 0, "tp": 0},
            "true_long_fraction": None,
            "predicted_long_fraction": None,
            "mean_positive_probability": None,
            "brier_score": None,
            "temporal_quartiles": [],
            "confidence_bands": [],
        }

    event_rows = predictions.loc[
        predictions[ACTIONABLE_TARGET_COLUMN] == 1
    ].copy()
    if event_rows.empty:
        return {
            "rows": int(len(predictions)),
            "event_direction_rows": 0,
            "active_trades": int(predictions["active_trade"].sum()),
            "balanced_accuracy": None,
            "confusion": {"tn": 0, "fp": 0, "fn": 0, "tp": 0},
            "true_long_fraction": None,
            "predicted_long_fraction": None,
            "mean_positive_probability": None,
            "brier_score": None,
            "temporal_quartiles": [],
            "confidence_bands": [],
        }

    truth = pd.to_numeric(event_rows[TARGET_COLUMN], errors="raise").astype(int)
    predicted_long = event_rows["predicted_long"].astype(bool)
    probabilities = pd.to_numeric(
        event_rows["positive_probability"], errors="raise"
    ).astype(float)
    tn = int(((truth == 0) & (~predicted_long)).sum())
    fp = int(((truth == 0) & predicted_long).sum())
    fn = int(((truth == 1) & (~predicted_long)).sum())
    tp = int(((truth == 1) & predicted_long).sum())

    ordered = event_rows.sort_values("decision_time").copy()
    temporal_quartiles: list[dict[str, Any]] = []
    if len(ordered) >= 4:
        boundaries = [round(len(ordered) * i / 4) for i in range(5)]
        for idx in range(4):
            chunk = ordered.iloc[boundaries[idx]:boundaries[idx + 1]]
            if chunk.empty:
                continue
            quartile_number = idx + 1
            chunk_truth = pd.to_numeric(chunk[TARGET_COLUMN], errors="raise").astype(int)
            chunk_pred = chunk["predicted_long"].astype(bool)
            temporal_quartiles.append(
                {
                    "quartile": quartile_number,
                    "rows": int(len(chunk)),
                    "start": pd.Timestamp(chunk["decision_time"].min()).isoformat(),
                    "end": pd.Timestamp(chunk["decision_time"].max()).isoformat(),
                    "balanced_accuracy": _binary_balanced_accuracy(
                        chunk_truth, chunk_pred
                    ),
                    "true_long_fraction": float(chunk_truth.mean()),
                    "predicted_long_fraction": float(chunk_pred.mean()),
                    "mean_positive_probability": float(
                        pd.to_numeric(
                            chunk["positive_probability"], errors="raise"
                        ).mean()
                    ),
                }
            )

    confidence = pd.to_numeric(event_rows["direction_confidence"], errors="raise")
    band_specs = (
        ("0.50-0.55", 0.50, 0.55),
        ("0.55-0.60", 0.55, 0.60),
        ("0.60-0.70", 0.60, 0.70),
        ("0.70-0.80", 0.70, 0.80),
        ("0.80-1.00", 0.80, 1.0000001),
    )
    confidence_bands: list[dict[str, Any]] = []
    for label, lower, upper in band_specs:
        mask = (confidence >= lower) & (confidence < upper)
        band = event_rows.loc[mask]
        if band.empty:
            continue
        band_truth = pd.to_numeric(band[TARGET_COLUMN], errors="raise").astype(int)
        band_pred = band["predicted_long"].astype(bool)
        confidence_bands.append(
            {
                "band": label,
                "rows": int(len(band)),
                "balanced_accuracy": _binary_balanced_accuracy(
                    band_truth, band_pred
                ),
                "true_long_fraction": float(band_truth.mean()),
                "predicted_long_fraction": float(band_pred.mean()),
            }
        )

    return {
        "rows": int(len(predictions)),
        "event_direction_rows": int(len(event_rows)),
        "active_trades": int(predictions["active_trade"].sum()),
        "balanced_accuracy": _binary_balanced_accuracy(truth, predicted_long),
        "confusion": {"tn": tn, "fp": fp, "fn": fn, "tp": tp},
        "true_long_fraction": float(truth.mean()),
        "predicted_long_fraction": float(predicted_long.mean()),
        "mean_positive_probability": float(probabilities.mean()),
        "brier_score": float(((probabilities - truth.astype(float)) ** 2).mean()),
        "temporal_quartiles": temporal_quartiles,
        "confidence_bands": confidence_bands,
    }


def _load_qualified_single_pair(
    path: str | Path,
    *,
    instrument: str,
    horizon_bars: int,
) -> tuple[dict[str, Any], pd.Timestamp, dict[str, str]]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    scope = payload.get("single_pair_scope")
    if not isinstance(scope, dict):
        raise ValueError("Qualification report is missing single_pair_scope")
    if str(scope.get("instrument", "")).upper() != instrument:
        raise ValueError("Qualification report instrument does not match final test")
    if int(scope.get("horizon_bars", -1)) != int(horizon_bars):
        raise ValueError("Qualification report horizon does not match final test")
    if scope.get("experiment") != EVENT_PAIR_EXPERT_EXPERIMENT_NAME:
        raise ValueError("Qualification report experiment is unsupported")
    if payload.get("event_label_policy") != EVENT_LABEL_POLICY:
        raise ValueError("Qualification report event label policy is unsupported")
    if bool(payload.get("untouched_final_test_used", True)):
        raise ValueError("Qualification report must not have used the untouched final test")
    if bool(payload.get("outer_validation_used_for_tuning", True)):
        raise ValueError("Qualification report reused outer validation for tuning")

    block = payload.get("experiments", {}).get(EVENT_PAIR_EXPERT_EXPERIMENT_NAME)
    if not isinstance(block, dict):
        raise ValueError("Qualification report is missing event pair expert result")
    gate = block.get("research_gate")
    if not isinstance(gate, dict) or not bool(gate.get("research_gate_passed", False)):
        raise ValueError("Single-pair research gate has not passed")

    raw_cutoff = payload.get("qualification_decision_time_before")
    if not raw_cutoff:
        raise ValueError("Qualification report is missing research cutoff")
    cutoff = pd.Timestamp(raw_cutoff)
    cutoff = cutoff.tz_localize("UTC") if cutoff.tzinfo is None else cutoff.tz_convert("UTC")

    hashes = payload.get("dataset_sha256")
    if not isinstance(hashes, dict) or set(hashes) != {instrument}:
        raise ValueError("Qualification report dataset hashes do not match single-pair scope")
    return gate, cutoff, {str(k): str(v) for k, v in hashes.items()}


def _single_pair_final_gate(
    test_metrics: dict[str, Any],
    opportunity_metrics: dict[str, Any] | None,
) -> dict[str, Any]:
    classification = test_metrics["classification"]
    trading = test_metrics["trading"]
    opportunity_balanced = (
        float(opportunity_metrics["balanced_accuracy"])
        if opportunity_metrics is not None
        else None
    )
    observed = {
        "balanced_accuracy": classification.get("balanced_accuracy"),
        "opportunity_balanced_accuracy": opportunity_balanced,
        "sharpe_ratio": trading.get("sharpe_ratio"),
        "profit_factor": trading.get("profit_factor"),
        "max_drawdown": trading.get("max_drawdown"),
    }
    checks = {
        "balanced_accuracy": (
            observed["balanced_accuracy"] is not None
            and float(observed["balanced_accuracy"]) >= DEFAULT_FINAL_GATE["min_balanced_accuracy"]
        ),
        "opportunity_balanced_accuracy": (
            opportunity_balanced is not None
            and opportunity_balanced >= DEFAULT_FINAL_GATE["min_balanced_accuracy"]
        ),
        "sharpe_ratio": (
            observed["sharpe_ratio"] is not None
            and float(observed["sharpe_ratio"]) >= DEFAULT_FINAL_GATE["min_sharpe_ratio"]
        ),
        "profit_factor": (
            observed["profit_factor"] is not None
            and float(observed["profit_factor"]) >= DEFAULT_FINAL_GATE["min_profit_factor"]
        ),
        "max_drawdown": (
            observed["max_drawdown"] is not None
            and float(observed["max_drawdown"]) <= DEFAULT_FINAL_GATE["max_drawdown"]
        ),
    }
    return {
        "thresholds": {
            **DEFAULT_FINAL_GATE,
            "min_opportunity_balanced_accuracy": DEFAULT_FINAL_GATE["min_balanced_accuracy"],
        },
        "observed": observed,
        "checks": checks,
        "passed": all(checks.values()),
    }


def evaluate_single_pair_untouched_test(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    qualification_report_path: str | Path,
    report_path: str | Path,
    confidence_threshold: float = CONFIDENCE_FLOOR,
) -> dict[str, Any]:
    if len(datasets) != 1:
        raise ValueError("Untouched final test requires exactly one dataset")
    instrument = next(iter(datasets)).upper()
    if confidence_threshold < CONFIDENCE_FLOOR or confidence_threshold >= 1.0:
        raise ValueError("confidence threshold must remain >= 0.60 and < 1.0")

    research_gate, cutoff, research_hashes = _load_qualified_single_pair(
        qualification_report_path,
        instrument=instrument,
        horizon_bars=horizon_bars,
    )
    pooled, dataset_hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        min_net_return_bps=0.0,
        commission_bps=0.0,
        slippage_bps=0.0,
    )
    if dataset_hashes != research_hashes:
        raise ValueError("Final-test dataset does not match qualified dataset")

    train, validation, test = _chronological_final_split(
        pooled,
        horizon_bars=horizon_bars,
    )
    test_start = pd.Timestamp(test["decision_time"].min())
    research_separation_verified = bool(test_start >= cutoff)
    if not research_separation_verified:
        raise ValueError("Untouched test overlaps the research qualification boundary")

    (
        direction_models,
        direction_calibrators,
        regime_routers,
        opportunity_model,
        training_counts,
    ) = _fit_pair_candidate(
        train,
        experiment=EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
        horizon_bars=horizon_bars,
    )
    validation_predictions = _predict_pair_candidate(
        experiment=EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
        direction_models=direction_models,
        direction_calibrators=direction_calibrators,
        regime_routers=regime_routers,
        opportunity_model=opportunity_model,
        frame=validation,
        confidence_floor=confidence_threshold,
        horizon_bars=horizon_bars,
    )
    test_predictions = _predict_pair_candidate(
        experiment=EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
        direction_models=direction_models,
        direction_calibrators=direction_calibrators,
        regime_routers=regime_routers,
        opportunity_model=opportunity_model,
        frame=test,
        confidence_floor=confidence_threshold,
        horizon_bars=horizon_bars,
    )

    validation_metrics = _summarize_predictions(
        validation_predictions,
        horizon_bars=horizon_bars,
        confidence_threshold=confidence_threshold,
    )
    test_metrics = _summarize_predictions(
        test_predictions,
        horizon_bars=horizon_bars,
        confidence_threshold=confidence_threshold,
    )
    opportunity_metrics = _opportunity_classification(
        test_predictions,
        classification_threshold=OPPORTUNITY_CLASSIFICATION_THRESHOLD,
    )
    gate = _single_pair_final_gate(test_metrics, opportunity_metrics)

    report = {
        "policy": SINGLE_PAIR_FINAL_TEST_POLICY,
        "instrument": instrument,
        "horizon_bars": int(horizon_bars),
        "experiment": EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
        "dataset_sha256": dataset_hashes,
        "research_gate": research_gate,
        "qualification_decision_time_before": cutoff.isoformat(),
        "research_separation_verified": research_separation_verified,
        "split": {
            "train_rows": int(len(train)),
            "validation_rows": int(len(validation)),
            "test_rows": int(len(test)),
            "train_start": train["decision_time"].min().isoformat(),
            "train_end": train["decision_time"].max().isoformat(),
            "validation_start": validation["decision_time"].min().isoformat(),
            "validation_end": validation["decision_time"].max().isoformat(),
            "test_start": test["decision_time"].min().isoformat(),
            "test_end": test["decision_time"].max().isoformat(),
        },
        "training_counts": training_counts,
        "validation_metrics": validation_metrics,
        "untouched_test_metrics": test_metrics,
        "direction_failure_diagnostics": {
            "policy": "diagnostic_only_no_threshold_or_model_tuning",
            "validation": _direction_failure_diagnostics(validation_predictions),
            "untouched_test": _direction_failure_diagnostics(test_predictions),
        },
        "untouched_opportunity_classification": opportunity_metrics,
        "final_test_gate": gate,
        "approved_for_paper": False,
        "approved_for_live": False,
        "note": (
            "Passing this untouched gate authorizes packaging review only. "
            "It does not itself promote a model to PAPER or LIVE."
        ),
    }
    output = Path(report_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(output.suffix + ".tmp")
    temp.write_text(json.dumps(report, indent=2, sort_keys=True, default=str), encoding="utf-8")
    temp.replace(output)
    return report


def evaluate_single_pair_future_holdout(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    qualification_report_path: str | Path,
    report_path: str | Path,
    future_holdout_start: str | pd.Timestamp,
    min_holdout_rows: int = 2500,
    confidence_threshold: float = CONFIDENCE_FLOOR,
) -> dict[str, Any]:
    """Evaluate only rows strictly after a frozen future boundary.

    The qualification report must use the same boundary as its
    decision_time_before cutoff. Model fitting consumes only pre-boundary rows
    with a horizon-sized purge gap; the future holdout is never used for
    selection, fitting, calibration, threshold tuning, or early stopping.
    """
    if len(datasets) != 1:
        raise ValueError("Future holdout test requires exactly one dataset")
    if min_holdout_rows < 500:
        raise ValueError("min_holdout_rows must be at least 500")
    if confidence_threshold < CONFIDENCE_FLOOR or confidence_threshold >= 1.0:
        raise ValueError("confidence threshold must remain >= 0.60 and < 1.0")

    instrument = next(iter(datasets)).upper()
    research_gate, cutoff, research_hashes = _load_qualified_single_pair(
        qualification_report_path,
        instrument=instrument,
        horizon_bars=horizon_bars,
    )
    holdout_start = pd.Timestamp(future_holdout_start)
    holdout_start = (
        holdout_start.tz_localize("UTC")
        if holdout_start.tzinfo is None
        else holdout_start.tz_convert("UTC")
    )
    if cutoff != holdout_start:
        raise ValueError(
            "Future holdout start must exactly match the qualification research cutoff"
        )

    pooled, dataset_hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        min_net_return_bps=0.0,
        commission_bps=0.0,
        slippage_bps=0.0,
    )
    if dataset_hashes != research_hashes:
        raise ValueError("Future-holdout dataset does not match qualified dataset")

    purge_boundary = holdout_start - pd.Timedelta(minutes=horizon_bars)
    train = pooled.loc[pooled["decision_time"] < purge_boundary].copy()
    holdout = pooled.loc[pooled["decision_time"] >= holdout_start].copy()
    train = train.sort_values(["decision_time", "instrument"]).reset_index(drop=True)
    holdout = holdout.sort_values(["decision_time", "instrument"]).reset_index(drop=True)

    if train.empty:
        raise ValueError("Future holdout leaves no pre-boundary training rows")
    if len(holdout) < min_holdout_rows:
        raise ValueError(
            f"Future holdout has {len(holdout)} rows; at least {min_holdout_rows} are required"
        )
    if train[TARGET_COLUMN].nunique() < 2:
        raise ValueError("Future-holdout training rows contain only one direction class")
    if holdout[TARGET_COLUMN].nunique() < 2:
        raise ValueError("Future holdout contains only one direction class")
    if holdout[ACTIONABLE_TARGET_COLUMN].nunique() < 2:
        raise ValueError("Future holdout lacks both opportunity classes")

    actual_holdout_start = pd.Timestamp(holdout["decision_time"].min())
    if actual_holdout_start < holdout_start:
        raise ValueError("Future holdout overlaps the frozen research boundary")

    (
        direction_models,
        direction_calibrators,
        regime_routers,
        opportunity_model,
        training_counts,
    ) = _fit_pair_candidate(
        train,
        experiment=EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
        horizon_bars=horizon_bars,
    )
    holdout_predictions = _predict_pair_candidate(
        experiment=EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
        direction_models=direction_models,
        direction_calibrators=direction_calibrators,
        regime_routers=regime_routers,
        opportunity_model=opportunity_model,
        frame=holdout,
        confidence_floor=confidence_threshold,
        horizon_bars=horizon_bars,
    )
    holdout_metrics = _summarize_predictions(
        holdout_predictions,
        horizon_bars=horizon_bars,
        confidence_threshold=confidence_threshold,
    )
    opportunity_metrics = _opportunity_classification(
        holdout_predictions,
        classification_threshold=OPPORTUNITY_CLASSIFICATION_THRESHOLD,
    )
    gate = _single_pair_final_gate(holdout_metrics, opportunity_metrics)

    report = {
        "policy": SINGLE_PAIR_FUTURE_HOLDOUT_POLICY,
        "instrument": instrument,
        "horizon_bars": int(horizon_bars),
        "experiment": EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
        "dataset_sha256": dataset_hashes,
        "research_gate": research_gate,
        "qualification_decision_time_before": cutoff.isoformat(),
        "future_holdout_start": holdout_start.isoformat(),
        "research_separation_verified": True,
        "future_holdout_used_for_training": False,
        "split": {
            "train_rows": int(len(train)),
            "holdout_rows": int(len(holdout)),
            "train_start": train["decision_time"].min().isoformat(),
            "train_end": train["decision_time"].max().isoformat(),
            "holdout_start": holdout["decision_time"].min().isoformat(),
            "holdout_end": holdout["decision_time"].max().isoformat(),
            "purge_minutes": int(horizon_bars),
        },
        "training_counts": training_counts,
        "future_holdout_metrics": holdout_metrics,
        "direction_failure_diagnostics": {
            "policy": "diagnostic_only_no_threshold_or_model_tuning",
            "future_holdout": _direction_failure_diagnostics(holdout_predictions),
        },
        "future_holdout_opportunity_classification": opportunity_metrics,
        "final_test_gate": gate,
        "approved_for_paper": False,
        "approved_for_live": False,
        "note": (
            "This is a one-touch future holdout evaluation. Passing authorizes "
            "packaging review only and does not itself promote PAPER or LIVE."
        ),
    }
    output = Path(report_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(output.suffix + ".tmp")
    temp.write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    temp.replace(output)
    return report


def _parse_dataset(value: str) -> dict[str, str]:
    instrument, separator, path = value.partition("=")
    if not separator or not instrument.strip() or not path.strip():
        raise ValueError("--dataset must use INSTRUMENT=/path/to/corpus.csv")
    return {instrument.strip().upper(): path.strip()}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run untouched final test for a qualified single pair")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--horizon-bars", type=int, required=True)
    parser.add_argument("--qualification-report", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--confidence-threshold", type=float, default=CONFIDENCE_FLOOR)
    parser.add_argument("--future-holdout-start")
    parser.add_argument("--min-future-holdout-rows", type=int, default=2500)
    args = parser.parse_args()

    if args.future_holdout_start:
        report = evaluate_single_pair_future_holdout(
            _parse_dataset(args.dataset),
            horizon_bars=args.horizon_bars,
            qualification_report_path=args.qualification_report,
            report_path=args.report,
            future_holdout_start=args.future_holdout_start,
            min_holdout_rows=args.min_future_holdout_rows,
            confidence_threshold=args.confidence_threshold,
        )
    else:
        report = evaluate_single_pair_untouched_test(
            _parse_dataset(args.dataset),
            horizon_bars=args.horizon_bars,
            qualification_report_path=args.qualification_report,
            report_path=args.report,
            confidence_threshold=args.confidence_threshold,
        )
    print(json.dumps({
        "instrument": report["instrument"],
        "horizon_bars": report["horizon_bars"],
        "passed": report["final_test_gate"]["passed"],
        "observed": report["final_test_gate"]["observed"],
        "checks": report["final_test_gate"]["checks"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
