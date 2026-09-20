"""Train and package a final pooled multi-timeframe XGBoost candidate.

This module is deliberately separate from walk-forward research evaluation.
A deployable artifact is produced only after:
- a chronological train/validation/untouched-test split,
- purge gaps around split boundaries,
- exact feature-schema hashing,
- artifact SHA-256 generation,
- optional paper/UAT approval gated by both research and untouched-test metrics.

No code path in this module can approve a model for live trading.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from app.domain.models.baseline_xgboost import (
    MULTITIMEFRAME_MODEL_TYPE,
    MULTITIMEFRAME_RUNTIME_PROFILE,
)
from app.domain.models.multitimeframe_features import (
    MULTITIMEFRAME_FEATURE_COLUMNS,
)
from app.domain.training.train_multitimeframe import (
    INITIAL_FOREX_UNIVERSE,
    LONG_NET_RETURN_COLUMN,
    SHORT_NET_RETURN_COLUMN,
    TARGET_COLUMN,
    _build_model,
    _summarize_predictions,
    load_and_prepare_corpora,
)

DEFAULT_FINAL_GATE = {
    "min_balanced_accuracy": 0.52,
    "min_sharpe_ratio": 1.0,
    "min_profit_factor": 1.15,
    "max_drawdown": 0.12,
}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _feature_schema_hash(feature_names: list[str]) -> str:
    payload = json.dumps(feature_names, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _load_research_qualification(
    summary_path: str | Path | None,
    *,
    horizon_bars: int,
) -> tuple[dict[str, Any] | None, pd.Timestamp | None]:
    if summary_path is None:
        return None, None

    path = Path(summary_path)
    payload = json.loads(path.read_text(encoding="utf-8"))
    block = payload.get("horizon_reports", {}).get(f"{horizon_bars}m")
    if not isinstance(block, dict):
        raise ValueError(
            f"Qualification summary does not contain horizon {horizon_bars}m"
        )
    gate = block.get("research_gate")
    if not isinstance(gate, dict):
        raise ValueError("Qualification summary is missing research_gate")

    qualification_window = payload.get("qualification_window")
    if not isinstance(qualification_window, dict):
        raise ValueError("Qualification summary is missing qualification_window")
    raw_cutoff = qualification_window.get("decision_time_before")
    if not raw_cutoff:
        raise ValueError(
            "Qualification summary is missing research decision-time cutoff"
        )
    cutoff = pd.Timestamp(raw_cutoff)
    cutoff = (
        cutoff.tz_localize("UTC")
        if cutoff.tzinfo is None
        else cutoff.tz_convert("UTC")
    )
    return gate, cutoff


def _chronological_final_split(
    dataset: pd.DataFrame,
    *,
    horizon_bars: int,
    validation_fraction: float = 0.15,
    test_fraction: float = 0.15,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Return train/validation/untouched-test slices with purge gaps."""
    if not 0.05 <= validation_fraction <= 0.30:
        raise ValueError("validation_fraction must be in [0.05, 0.30]")
    if not 0.05 <= test_fraction <= 0.30:
        raise ValueError("test_fraction must be in [0.05, 0.30]")
    if validation_fraction + test_fraction >= 0.45:
        raise ValueError("validation_fraction + test_fraction must be < 0.45")
    if horizon_bars < 1:
        raise ValueError("horizon_bars must be positive")

    times = pd.Index(sorted(dataset["decision_time"].unique()))
    if len(times) < 500:
        raise ValueError("At least 500 unique decision periods are required")

    first_cut = int(len(times) * (1.0 - validation_fraction - test_fraction))
    second_cut = int(len(times) * (1.0 - test_fraction))

    train_end = first_cut - horizon_bars
    validation_start = first_cut + horizon_bars
    validation_end = second_cut - horizon_bars
    test_start = second_cut + horizon_bars

    if train_end <= 250 or validation_end <= validation_start or test_start >= len(times):
        raise ValueError("Insufficient periods after final-split purge gaps")

    train_times = set(times[:train_end])
    validation_times = set(times[validation_start:validation_end])
    test_times = set(times[test_start:])

    train = dataset[dataset["decision_time"].isin(train_times)].copy()
    validation = dataset[dataset["decision_time"].isin(validation_times)].copy()
    test = dataset[dataset["decision_time"].isin(test_times)].copy()

    for name, frame in (
        ("train", train),
        ("validation", validation),
        ("test", test),
    ):
        if frame.empty:
            raise ValueError(f"Final {name} split is empty")
        if frame[TARGET_COLUMN].nunique() < 2:
            raise ValueError(f"Final {name} split contains only one class")

    return (
        train.sort_values(["decision_time", "instrument"]).reset_index(drop=True),
        validation.sort_values(["decision_time", "instrument"]).reset_index(drop=True),
        test.sort_values(["decision_time", "instrument"]).reset_index(drop=True),
    )


def _prediction_frame(
    model: Any,
    frame: pd.DataFrame,
    *,
    confidence_threshold: float,
) -> pd.DataFrame:
    probabilities = model.predict_proba(frame[MULTITIMEFRAME_FEATURE_COLUMNS])[:, 1]
    predictions = frame[
        [
            "decision_time",
            "instrument",
            TARGET_COLUMN,
            LONG_NET_RETURN_COLUMN,
            SHORT_NET_RETURN_COLUMN,
            "m1_spread_bps",
        ]
    ].copy()
    predictions["positive_probability"] = probabilities
    predictions["predicted_long"] = probabilities >= 0.5
    predictions["confidence"] = np.maximum(probabilities, 1.0 - probabilities)
    predictions["active_trade"] = predictions["confidence"] >= confidence_threshold
    predictions["selected_net_return"] = np.where(
        predictions["predicted_long"],
        predictions[LONG_NET_RETURN_COLUMN],
        predictions[SHORT_NET_RETURN_COLUMN],
    )
    return predictions


def _final_gate(metrics: dict[str, Any]) -> dict[str, Any]:
    classification = metrics["classification"]
    trading = metrics["trading"]

    observed = {
        "balanced_accuracy": classification.get("balanced_accuracy"),
        "sharpe_ratio": trading.get("sharpe_ratio"),
        "profit_factor": trading.get("profit_factor"),
        "max_drawdown": trading.get("max_drawdown"),
    }
    checks = {
        "balanced_accuracy": (
            observed["balanced_accuracy"] is not None
            and observed["balanced_accuracy"]
            >= DEFAULT_FINAL_GATE["min_balanced_accuracy"]
        ),
        "sharpe_ratio": (
            observed["sharpe_ratio"] is not None
            and observed["sharpe_ratio"] >= DEFAULT_FINAL_GATE["min_sharpe_ratio"]
        ),
        "profit_factor": (
            observed["profit_factor"] is not None
            and observed["profit_factor"] >= DEFAULT_FINAL_GATE["min_profit_factor"]
        ),
        "max_drawdown": (
            observed["max_drawdown"] is not None
            and observed["max_drawdown"] <= DEFAULT_FINAL_GATE["max_drawdown"]
        ),
    }
    return {
        "thresholds": DEFAULT_FINAL_GATE,
        "observed": observed,
        "checks": checks,
        "passed": all(checks.values()),
    }


def train_final_candidate(
    datasets: dict[str, str | Path],
    *,
    horizon_bars: int,
    output_model_path: str | Path,
    qualification_summary_path: str | Path | None = None,
    confidence_threshold: float = 0.60,
    min_net_return_bps: float = 0.0,
    commission_bps: float = 0.0,
    slippage_bps: float = 0.0,
    approve_paper: bool = False,
) -> dict[str, Any]:
    """Train, test, hash and package one final paper/UAT candidate."""
    if set(datasets) != set(INITIAL_FOREX_UNIVERSE):
        raise ValueError("Final candidate requires the complete six-pair universe")
    if not 0.5 <= confidence_threshold < 1.0:
        raise ValueError("confidence_threshold must be in [0.5, 1.0)")

    research_gate, research_cutoff = _load_research_qualification(
        qualification_summary_path,
        horizon_bars=horizon_bars,
    )

    pooled, dataset_hashes = load_and_prepare_corpora(
        datasets,
        horizon_bars=horizon_bars,
        min_net_return_bps=min_net_return_bps,
        commission_bps=commission_bps,
        slippage_bps=slippage_bps,
    )
    train, validation, test = _chronological_final_split(
        pooled,
        horizon_bars=horizon_bars,
    )

    test_start = pd.Timestamp(test["decision_time"].min())
    research_separation_verified = bool(
        research_cutoff is not None and test_start >= research_cutoff
    )
    if approve_paper and not research_separation_verified:
        raise ValueError(
            "Paper approval requested but the untouched test overlaps or lacks "
            "the reserved research qualification boundary"
        )

    model = _build_model()
    model.fit(
        train[MULTITIMEFRAME_FEATURE_COLUMNS],
        train[TARGET_COLUMN].astype(int),
        eval_set=[
            (
                validation[MULTITIMEFRAME_FEATURE_COLUMNS],
                validation[TARGET_COLUMN].astype(int),
            )
        ],
        verbose=False,
    )

    validation_predictions = _prediction_frame(
        model,
        validation,
        confidence_threshold=confidence_threshold,
    )
    test_predictions = _prediction_frame(
        model,
        test,
        confidence_threshold=confidence_threshold,
    )
    validation_metrics = _summarize_predictions(validation_predictions)
    test_metrics = _summarize_predictions(test_predictions)
    final_gate = _final_gate(test_metrics)

    research_gate_passed = bool(
        research_gate is not None and research_gate.get("research_gate_passed", False)
    )
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
    model.save_model(str(output))

    timestamp = datetime.now(UTC)
    model_version = (
        f"mtf-xgboost-sixpair-h{horizon_bars}-"
        f"{timestamp.strftime('%Y%m%dT%H%M%SZ')}"
    )
    metadata = {
        "metadata_version": 2,
        "model_type": MULTITIMEFRAME_MODEL_TYPE,
        "runtime_feature_profile": MULTITIMEFRAME_RUNTIME_PROFILE,
        "model_version": model_version,
        "artifact_sha256": _sha256_file(output),
        "feature_columns": MULTITIMEFRAME_FEATURE_COLUMNS,
        "feature_schema_hash": _feature_schema_hash(MULTITIMEFRAME_FEATURE_COLUMNS),
        "feature_count": len(MULTITIMEFRAME_FEATURE_COLUMNS),
        "training_data_source": "dukascopy_public_datafeed_ticks",
        "dataset_sha256": dataset_hashes,
        "instruments": list(INITIAL_FOREX_UNIVERSE),
        "horizon_bars": horizon_bars,
        "confidence_threshold": confidence_threshold,
        "cost_model": {
            "historical_spread": "half spread at entry + half spread at exit",
            "commission_bps_round_trip": commission_bps,
            "slippage_bps_round_trip": slippage_bps,
            "minimum_net_return_bps_for_label": min_net_return_bps,
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
            "purge_periods": horizon_bars,
            "research_qualification_before": (
                research_cutoff.isoformat() if research_cutoff is not None else None
            ),
            "research_separation_verified": research_separation_verified,
        },
        "best_iteration": int(getattr(model, "best_iteration", -1)),
        "validation_metrics": validation_metrics,
        "untouched_test_metrics": test_metrics,
        "final_test_gate": final_gate,
        "research_gate": research_gate,
        "validation_status": (
            "untouched_test_passed"
            if final_gate["passed"]
            else "untouched_test_failed"
        ),
        "approved_for_paper": paper_approved,
        "approved_for_sandbox": paper_approved,
        "approved_for_live": False,
        "confidence_semantics": (
            "Directional class probability estimate from fitted XGBoost; "
            "not a probability of profit."
        ),
        "created_at": timestamp.isoformat(),
    }

    metadata_path = output.with_suffix(".metadata.json")
    metadata_path.write_text(
        json.dumps(metadata, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return {
        **metadata,
        "model_path": str(output),
        "metadata_path": str(metadata_path),
    }


def _parse_dataset_args(values: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for value in values:
        instrument, separator, path = value.partition("=")
        instrument = instrument.strip().upper()
        if not separator or not path.strip():
            raise ValueError("--dataset values must use INSTRUMENT=/path/to/corpus.csv")
        if instrument in result:
            raise ValueError(f"Duplicate dataset for {instrument}")
        result[instrument] = path.strip()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Train and package final paper/UAT multi-timeframe XGBoost candidate"
    )
    parser.add_argument("--dataset", action="append", required=True)
    parser.add_argument("--horizon-bars", type=int, required=True)
    parser.add_argument("--output-model", required=True)
    parser.add_argument("--qualification-summary")
    parser.add_argument("--confidence-threshold", type=float, default=0.60)
    parser.add_argument("--min-net-return-bps", type=float, default=0.0)
    parser.add_argument("--commission-bps", type=float, default=0.0)
    parser.add_argument("--slippage-bps", type=float, default=0.0)
    parser.add_argument("--approve-paper", action="store_true")
    args = parser.parse_args()

    result = train_final_candidate(
        _parse_dataset_args(args.dataset),
        horizon_bars=args.horizon_bars,
        output_model_path=args.output_model,
        qualification_summary_path=args.qualification_summary,
        confidence_threshold=args.confidence_threshold,
        min_net_return_bps=args.min_net_return_bps,
        commission_bps=args.commission_bps,
        slippage_bps=args.slippage_bps,
        approve_paper=args.approve_paper,
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
