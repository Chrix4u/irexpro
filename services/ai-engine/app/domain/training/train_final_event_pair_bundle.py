"""Final untouched-test trainer and verified bundle packager for event pair experts."""
from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd

from app.domain.models.multitimeframe_features import (
    INITIAL_FOREX_UNIVERSE,
    MULTITIMEFRAME_BACKTEST_POLICY,
    MULTITIMEFRAME_FEATURE_COLUMNS,
    MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
    MULTITIMEFRAME_RUNTIME_PROFILE,
)
from app.domain.training.model_qualification import (
    CONFIDENCE_FLOOR,
    EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
    EVENT_PAIR_RETURN_MARGIN_EXPERIMENT_NAME,
    ModelVariant,
    _event_two_stage_prediction_frame,
    _fit_event_pair_experts_for_outer,
    _fit_event_pair_return_margin_for_outer,
    _pair_expert_probabilities,
    _pair_return_margin_probabilities,
    _probabilities,
    _summarize_predictions,
)
from app.domain.training.train_final_multitimeframe import (
    MIN_PAPER_PROMOTION_M1_ROWS_PER_INSTRUMENT,
    _chronological_final_split,
    _feature_schema_hash,
    _final_gate,
    _load_research_qualification,
    _sha256_file,
)
from app.domain.training.train_multitimeframe import (
    EVENT_LABEL_POLICY,
    load_and_prepare_corpora,
)

EVENT_PAIR_BUNDLE_MODEL_TYPE = "xgboost_event_pair_bundle"
SUPPORTED_EXPERIMENTS = {
    EVENT_PAIR_EXPERT_EXPERIMENT_NAME,
    EVENT_PAIR_RETURN_MARGIN_EXPERIMENT_NAME,
}


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.stem + ".tmp" + path.suffix)
    temp.write_text(
        json.dumps(payload, indent=2, sort_keys=True, default=str),
        encoding="utf-8",
    )
    temp.replace(path)


def _save_xgboost_model(model: Any, path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.stem + ".tmp" + path.suffix)
    model.save_model(str(temp))
    temp.replace(path)
    return _sha256_file(path)


def _load_qualification_experiment(
    path: str | Path,
    *,
    horizon_bars: int,
    experiment: str,
) -> tuple[dict[str, Any], pd.Timestamp, dict[str, str]]:
    report_path = Path(path)
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    if int(payload.get("horizon_bars", -1)) != int(horizon_bars):
        raise ValueError("Qualification report horizon does not match final candidate")
    if payload.get("event_label_policy") != EVENT_LABEL_POLICY:
        raise ValueError("Qualification report event label policy is unsupported")
    if bool(payload.get("untouched_final_test_used", True)):
        raise ValueError("Qualification report must not have used the untouched final test")
    if bool(payload.get("outer_validation_used_for_tuning", True)):
        raise ValueError("Qualification report reused outer validation for tuning")

    block = payload.get("experiments", {}).get(experiment)
    if not isinstance(block, dict):
        raise ValueError(f"Qualification report does not contain experiment {experiment}")
    gate = block.get("research_gate")
    if not isinstance(gate, dict):
        raise ValueError("Qualification experiment is missing research_gate")

    raw_cutoff = payload.get("qualification_decision_time_before")
    if not raw_cutoff:
        raise ValueError("Qualification report is missing research cutoff")
    cutoff = pd.Timestamp(raw_cutoff)
    cutoff = (
        cutoff.tz_localize("UTC")
        if cutoff.tzinfo is None
        else cutoff.tz_convert("UTC")
    )

    dataset_sha = payload.get("dataset_sha256")
    if not isinstance(dataset_sha, dict) or set(dataset_sha) != set(INITIAL_FOREX_UNIVERSE):
        raise ValueError("Qualification report dataset hashes are incomplete")
    return gate, cutoff, {str(k): str(v) for k, v in dataset_sha.items()}


def _predict_pair_candidate(
    *,
    experiment: str,
    direction_models: dict[str, Any],
    direction_calibrators: dict[str, Any] | None,
    opportunity_model: Any,
    frame: pd.DataFrame,
    confidence_floor: float,
    horizon_bars: int,
) -> pd.DataFrame:
    if experiment == EVENT_PAIR_EXPERT_EXPERIMENT_NAME:
        direction_probabilities = _pair_expert_probabilities(
            direction_models,
            frame,
            list(MULTITIMEFRAME_FEATURE_COLUMNS),
        )
        variant = ModelVariant(name="event_barrier_v4_pair_direction")
    elif experiment == EVENT_PAIR_RETURN_MARGIN_EXPERIMENT_NAME:
        if direction_calibrators is None:
            raise ValueError("Return-margin candidate requires pair calibrators")
        direction_probabilities = _pair_return_margin_probabilities(
            direction_models,
            direction_calibrators,
            frame,
            list(MULTITIMEFRAME_FEATURE_COLUMNS),
        )
        variant = ModelVariant(name="event_barrier_v5_pair_return_margin")
    else:
        raise ValueError(f"Unsupported final pair experiment: {experiment}")

    opportunity_probabilities = _probabilities(
        opportunity_model,
        frame,
        list(MULTITIMEFRAME_FEATURE_COLUMNS),
    )
    predictions = _event_two_stage_prediction_frame(
        frame,
        direction_probabilities=direction_probabilities,
        opportunity_probabilities=opportunity_probabilities,
        confidence_floor=confidence_floor,
        fold=0,
        experiment=experiment,
        variant=variant,
    )
    if experiment == EVENT_PAIR_RETURN_MARGIN_EXPERIMENT_NAME:
        predictions["calibration_method"] = "pair_logistic_return_margin"
    return predictions


def _fit_pair_candidate(
    train: pd.DataFrame,
    *,
    experiment: str,
    horizon_bars: int,
) -> tuple[dict[str, Any], dict[str, Any] | None, Any, dict[str, Any]]:
    if experiment == EVENT_PAIR_EXPERT_EXPERIMENT_NAME:
        models, opportunity, features, counts = _fit_event_pair_experts_for_outer(
            train,
            variant=ModelVariant(name="event_barrier_v4_pair_direction"),
            horizon_bars=horizon_bars,
        )
        calibrators = None
    elif experiment == EVENT_PAIR_RETURN_MARGIN_EXPERIMENT_NAME:
        (
            models,
            calibrators,
            opportunity,
            features,
            counts,
        ) = _fit_event_pair_return_margin_for_outer(
            train,
            variant=ModelVariant(name="event_barrier_v5_pair_return_margin"),
            horizon_bars=horizon_bars,
        )
    else:
        raise ValueError(f"Unsupported final pair experiment: {experiment}")

    if features != list(MULTITIMEFRAME_FEATURE_COLUMNS):
        raise ValueError("Final pair candidate feature schema diverged from runtime")
    return models, calibrators, opportunity, counts


def _component_manifest(
    output: Path,
    *,
    experiment: str,
    direction_models: dict[str, Any],
    direction_calibrators: dict[str, Any] | None,
    opportunity_model: Any,
) -> dict[str, Any]:
    root = output.parent
    opportunity_path = root / "opportunity.json"
    opportunity_sha = _save_xgboost_model(opportunity_model, opportunity_path)

    direction: dict[str, Any] = {}
    for instrument in INITIAL_FOREX_UNIVERSE:
        model = direction_models.get(instrument)
        if model is None:
            raise ValueError(f"Final bundle is missing direction expert {instrument}")
        path = root / f"direction-{instrument}.json"
        sha = _save_xgboost_model(model, path)
        item: dict[str, Any] = {
            "path": path.name,
            "sha256": sha,
            "kind": (
                "xgboost_classifier"
                if experiment == EVENT_PAIR_EXPERT_EXPERIMENT_NAME
                else "xgboost_return_margin_regressor"
            ),
        }
        if experiment == EVENT_PAIR_RETURN_MARGIN_EXPERIMENT_NAME:
            if direction_calibrators is None or instrument not in direction_calibrators:
                raise ValueError(f"Final bundle is missing calibrator {instrument}")
            calibrator = direction_calibrators[instrument]
            item["calibration"] = {
                "method": "logistic_return_margin_bps",
                "coefficient": float(calibrator.coef_[0][0]),
                "intercept": float(calibrator.intercept_[0]),
            }
        direction[instrument] = item

    return {
        "bundle_version": 1,
        "model_type": EVENT_PAIR_BUNDLE_MODEL_TYPE,
        "experiment": experiment,
        "event_label_policy": EVENT_LABEL_POLICY,
        "opportunity": {
            "path": opportunity_path.name,
            "sha256": opportunity_sha,
            "kind": "xgboost_classifier",
        },
        "direction": direction,
    }


def train_final_event_pair_candidate(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    experiment: str,
    output_model_path: str | Path,
    qualification_report_path: str | Path,
    qualification_summary_path: str | Path,
    confidence_threshold: float = CONFIDENCE_FLOOR,
    commission_bps: float = 0.0,
    slippage_bps: float = 0.0,
    approve_paper: bool = False,
) -> dict[str, Any]:
    """Train and untouched-test one exact event pair architecture."""
    if experiment not in SUPPORTED_EXPERIMENTS:
        raise ValueError(f"Unsupported final event-pair experiment: {experiment}")
    if set(datasets) != set(INITIAL_FOREX_UNIVERSE):
        raise ValueError("Final pair candidate requires the complete six-pair universe")
    if confidence_threshold < CONFIDENCE_FLOOR or confidence_threshold >= 1.0:
        raise ValueError("confidence_threshold must remain >= 0.60 and < 1.0")

    research_gate, qualification_cutoff, research_hashes = (
        _load_qualification_experiment(
            qualification_report_path,
            horizon_bars=horizon_bars,
            experiment=experiment,
        )
    )
    _, summary_cutoff, target_rows = _load_research_qualification(
        qualification_summary_path,
        horizon_bars=horizon_bars,
    )
    if summary_cutoff is None or summary_cutoff != qualification_cutoff:
        raise ValueError("Qualification report and summary research cutoffs disagree")

    evidence_volume_verified = bool(
        target_rows is not None
        and target_rows >= MIN_PAPER_PROMOTION_M1_ROWS_PER_INSTRUMENT
    )
    if approve_paper and not evidence_volume_verified:
        raise ValueError("Paper approval requested with insufficient research evidence volume")

    pooled, dataset_hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        min_net_return_bps=0.0,
        commission_bps=commission_bps,
        slippage_bps=slippage_bps,
    )
    if dataset_hashes != research_hashes:
        raise ValueError("Final candidate datasets do not match qualification datasets")

    train, validation, test = _chronological_final_split(
        pooled,
        horizon_bars=horizon_bars,
    )
    test_start = pd.Timestamp(test["decision_time"].min())
    research_separation_verified = bool(test_start >= qualification_cutoff)
    if approve_paper and not research_separation_verified:
        raise ValueError("Untouched final test overlaps the research qualification boundary")

    (
        direction_models,
        direction_calibrators,
        opportunity_model,
        training_counts,
    ) = _fit_pair_candidate(
        train,
        experiment=experiment,
        horizon_bars=horizon_bars,
    )
    validation_predictions = _predict_pair_candidate(
        experiment=experiment,
        direction_models=direction_models,
        direction_calibrators=direction_calibrators,
        opportunity_model=opportunity_model,
        frame=validation,
        confidence_floor=confidence_threshold,
        horizon_bars=horizon_bars,
    )
    test_predictions = _predict_pair_candidate(
        experiment=experiment,
        direction_models=direction_models,
        direction_calibrators=direction_calibrators,
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
    final_gate = _final_gate(test_metrics)
    research_gate_passed = bool(research_gate.get("research_gate_passed", False))
    paper_approved = bool(
        approve_paper
        and research_gate_passed
        and research_separation_verified
        and final_gate["passed"]
    )
    if approve_paper and not paper_approved:
        raise ValueError(
            "Paper approval requested but research and/or untouched-test gate did not pass"
        )

    output = Path(output_model_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    bundle = _component_manifest(
        output,
        experiment=experiment,
        direction_models=direction_models,
        direction_calibrators=direction_calibrators,
        opportunity_model=opportunity_model,
    )
    _atomic_write_json(output, bundle)

    timestamp = datetime.now(UTC)
    model_version = (
        f"mtf-event-pair-{experiment}-h{horizon_bars}-"
        f"{timestamp.strftime('%Y%m%dT%H%M%SZ')}"
    )
    metadata = {
        "metadata_version": 4,
        "model_type": EVENT_PAIR_BUNDLE_MODEL_TYPE,
        "runtime_feature_profile": MULTITIMEFRAME_RUNTIME_PROFILE,
        "research_experiment": experiment,
        "event_label_policy": EVENT_LABEL_POLICY,
        "backtest_evaluation_policy": MULTITIMEFRAME_BACKTEST_POLICY,
        "research_validation_policy": MULTITIMEFRAME_RESEARCH_VALIDATION_POLICY,
        "model_version": model_version,
        "artifact_sha256": _sha256_file(output),
        "feature_columns": list(MULTITIMEFRAME_FEATURE_COLUMNS),
        "feature_schema_hash": _feature_schema_hash(
            list(MULTITIMEFRAME_FEATURE_COLUMNS)
        ),
        "feature_count": len(MULTITIMEFRAME_FEATURE_COLUMNS),
        "training_data_source": "dukascopy_public_datafeed_ticks",
        "dataset_sha256": dataset_hashes,
        "instruments": list(INITIAL_FOREX_UNIVERSE),
        "horizon_bars": horizon_bars,
        "confidence_threshold": confidence_threshold,
        "opportunity_threshold": confidence_threshold,
        "direction_threshold": 0.50,
        "training_counts": training_counts,
        "bundle_components": bundle,
        "cost_model": {
            "historical_spread": "half spread at entry + half spread at exit",
            "commission_bps_round_trip": commission_bps,
            "slippage_bps_round_trip": slippage_bps,
            "future_profitability_row_filtering": "prohibited",
        },
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
            "research_qualification_before": qualification_cutoff.isoformat(),
            "research_separation_verified": research_separation_verified,
        },
        "validation_metrics": validation_metrics,
        "untouched_test_metrics": test_metrics,
        "final_test_gate": final_gate,
        "research_gate": research_gate,
        "qualification_evidence": {
            "target_m1_rows_per_instrument": target_rows,
            "minimum_m1_rows_per_instrument": MIN_PAPER_PROMOTION_M1_ROWS_PER_INSTRUMENT,
            "evidence_volume_verified": evidence_volume_verified,
        },
        "validation_status": (
            "untouched_test_passed"
            if final_gate["passed"]
            else "untouched_test_failed"
        ),
        "approved_for_paper": paper_approved,
        "approved_for_sandbox": paper_approved,
        "approved_for_live": False,
        "confidence_semantics": (
            "Joint confidence is the minimum of event-opportunity probability "
            "and pair-specific directional confidence; it is not a probability of profit."
        ),
        "created_at": timestamp.isoformat(),
    }
    metadata_path = output.with_suffix(".metadata.json")
    _atomic_write_json(metadata_path, metadata)
    return {
        **metadata,
        "model_path": str(output),
        "metadata_path": str(metadata_path),
    }


def _parse_dataset_args(values: list[str]) -> dict[str, str]:
    datasets: dict[str, str] = {}
    for value in values:
        instrument, separator, path = value.partition("=")
        instrument = instrument.strip().upper()
        if not separator or not path.strip():
            raise ValueError("--dataset values must use INSTRUMENT=/path/to/corpus.csv")
        if instrument in datasets:
            raise ValueError(f"Duplicate dataset for {instrument}")
        datasets[instrument] = path.strip()
    return datasets


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Train and package final event pair-expert paper candidate"
    )
    parser.add_argument("--dataset", action="append", required=True)
    parser.add_argument("--horizon-bars", type=int, required=True)
    parser.add_argument("--experiment", required=True)
    parser.add_argument("--output-model", required=True)
    parser.add_argument("--qualification-report", required=True)
    parser.add_argument("--qualification-summary", required=True)
    parser.add_argument("--confidence-threshold", type=float, default=CONFIDENCE_FLOOR)
    parser.add_argument("--commission-bps", type=float, default=0.0)
    parser.add_argument("--slippage-bps", type=float, default=0.0)
    parser.add_argument("--approve-paper", action="store_true")
    args = parser.parse_args()

    result = train_final_event_pair_candidate(
        _parse_dataset_args(args.dataset),
        horizon_bars=args.horizon_bars,
        experiment=args.experiment,
        output_model_path=args.output_model,
        qualification_report_path=args.qualification_report,
        qualification_summary_path=args.qualification_summary,
        confidence_threshold=args.confidence_threshold,
        commission_bps=args.commission_bps,
        slippage_bps=args.slippage_bps,
        approve_paper=args.approve_paper,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
