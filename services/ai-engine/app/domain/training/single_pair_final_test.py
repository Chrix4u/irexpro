"""Untouched final-test evaluator for a qualified single-pair event expert."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pandas as pd

from app.domain.training.model_qualification import (
    CONFIDENCE_FLOOR,
    EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
    OPPORTUNITY_CLASSIFICATION_THRESHOLD,
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
    args = parser.parse_args()

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
